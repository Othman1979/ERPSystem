import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';

export interface ReportRange {
  from?: string;
  to?: string;
}

/**
 * JSON accounting reports (docs/BUILD_PLAN.md §15 subset for Phase 3):
 * general ledger, trial balance, party statement. All read POSTED entries
 * only and are tenant/company scoped via tenantScopedPrisma.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { tenantId, db: this.prisma.forTenant(tenantId) };
  }

  private async companyId(db: ReturnType<PrismaService['forTenant']>): Promise<bigint> {
    const company = await db.company.findFirst({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    if (!company) throw new DomainError(ErrorCode.INTERNAL, 'Tenant has no active company');
    return company.id;
  }

  private dateWhere(range: ReportRange) {
    const where: { gte?: Date; lte?: Date } = {};
    if (range.from) where.gte = new Date(range.from);
    if (range.to) {
      const d = new Date(range.to);
      d.setUTCHours(23, 59, 59, 999);
      where.lte = d;
    }
    return where;
  }

  /** Trial balance: per-account debit/credit totals over POSTED entries. */
  async trialBalance(range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const dateWhere = this.dateWhere(range);

    const grouped = await db.journalLine.groupBy({
      by: ['accountId'],
      where: {
        entry: {
          companyId,
          status: 'POSTED',
          ...(Object.keys(dateWhere).length ? { entryDate: dateWhere } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });

    const accountIds = grouped.map((g) => g.accountId);
    const accounts = await db.account.findMany({
      where: { id: { in: accountIds } },
      select: { id: true, code: true, nameAr: true, nameEn: true, accountType: true, normalBalance: true },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    const rows = grouped
      .map((g) => {
        const a = byId.get(g.accountId);
        if (!a) return null;
        const debit = new Decimal(g._sum.debit?.toString() ?? 0);
        const credit = new Decimal(g._sum.credit?.toString() ?? 0);
        // Natural-sign balance: positive = normal side.
        const balance = a.normalBalance === 'DEBIT' ? debit.minus(credit) : credit.minus(debit);
        return {
          accountId: a.id.toString(),
          code: a.code,
          nameAr: a.nameAr,
          nameEn: a.nameEn,
          accountType: a.accountType,
          normalBalance: a.normalBalance,
          totalDebit: debit.toString(),
          totalCredit: credit.toString(),
          balance: balance.toString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => a.code.localeCompare(b.code));

    const totalDebit = sum(rows.map((r) => r.totalDebit));
    const totalCredit = sum(rows.map((r) => r.totalCredit));
    return {
      rows,
      totals: { debit: totalDebit.toString(), credit: totalCredit.toString() },
      balanced: totalDebit.eq(totalCredit),
    };
  }

  /** General ledger for one account: lines + running balance. */
  async generalLedger(accountId: bigint, range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const dateWhere = this.dateWhere(range);

    const account = await db.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw DomainError.notFound('Account', accountId.toString());

    const lines = await db.journalLine.findMany({
      where: {
        accountId,
        entry: {
          companyId,
          status: 'POSTED',
          ...(Object.keys(dateWhere).length ? { entryDate: dateWhere } : {}),
        },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }],
      include: {
        entry: {
          select: {
            id: true,
            entryNo: true,
            entryDate: true,
            description: true,
            sourceType: true,
            postingKind: true,
          },
        },
      },
    });

    // Opening balance = everything before `from`.
    let opening = new Decimal(0);
    if (range.from) {
      const before = await db.journalLine.findMany({
        where: {
          accountId,
          entry: {
            companyId,
            status: 'POSTED',
            entryDate: { lt: new Date(range.from) },
          },
        },
        select: { debit: true, credit: true },
      });
      opening = sum(before.map((l) => new Decimal(l.debit.toString()).minus(l.credit.toString())));
    }

    let running = opening;
    const rows = lines.map((l) => {
      const debit = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      running = running.plus(debit).minus(credit);
      return {
        lineId: l.id.toString(),
        entryId: l.entry.id.toString(),
        entryNo: l.entry.entryNo,
        entryDate: l.entry.entryDate,
        description: l.description ?? l.entry.description,
        sourceType: l.entry.sourceType,
        postingKind: l.entry.postingKind,
        partyType: l.partyType,
        partyId: l.partyId?.toString() ?? null,
        debit: debit.toString(),
        credit: credit.toString(),
        balance: running.toString(),
      };
    });

    return {
      account: {
        id: account.id.toString(),
        code: account.code,
        nameAr: account.nameAr,
        nameEn: account.nameEn,
        normalBalance: account.normalBalance,
      },
      openingBalance: opening.toString(),
      closingBalance: running.toString(),
      rows,
    };
  }

  /** Party statement: control-account lines for one customer/supplier. */
  async partyStatement(partyType: 'CUSTOMER' | 'SUPPLIER', partyId: bigint, range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const dateWhere = this.dateWhere(range);

    const lines = await db.journalLine.findMany({
      where: {
        partyType,
        partyId,
        entry: {
          companyId,
          status: 'POSTED',
          ...(Object.keys(dateWhere).length ? { entryDate: dateWhere } : {}),
        },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }],
      include: {
        entry: {
          select: { id: true, entryNo: true, entryDate: true, description: true, sourceType: true },
        },
        account: { select: { id: true, code: true, nameAr: true } },
      },
    });

    let opening = new Decimal(0);
    if (range.from) {
      const before = await db.journalLine.findMany({
        where: {
          partyType,
          partyId,
          entry: { companyId, status: 'POSTED', entryDate: { lt: new Date(range.from) } },
        },
        select: { debit: true, credit: true },
      });
      opening = sum(before.map((l) => new Decimal(l.debit.toString()).minus(l.credit.toString())));
    }

    let running = opening;
    const rows = lines.map((l) => {
      const debit = new Decimal(l.debit.toString());
      const credit = new Decimal(l.credit.toString());
      running = running.plus(debit).minus(credit);
      return {
        lineId: l.id.toString(),
        entryId: l.entry.id.toString(),
        entryNo: l.entry.entryNo,
        entryDate: l.entry.entryDate,
        accountCode: l.account.code,
        accountName: l.account.nameAr,
        description: l.description ?? l.entry.description,
        debit: debit.toString(),
        credit: credit.toString(),
        balance: running.toString(),
      };
    });

    const totalDebit = sum(rows.map((r) => r.debit));
    const totalCredit = sum(rows.map((r) => r.credit));

    return {
      partyType,
      partyId: partyId.toString(),
      openingBalance: opening.toString(),
      closingBalance: running.toString(),
      totalDebit: totalDebit.toString(),
      totalCredit: totalCredit.toString(),
      rows,
    };
  }
}
