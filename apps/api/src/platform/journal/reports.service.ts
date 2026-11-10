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

export type AccountTypeCode = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

/** One account of the company's chart (groups too), for statement trees. */
export interface ChartAccount {
  id: bigint;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: bigint | null;
  accountType: AccountTypeCode;
  normalBalance: 'DEBIT' | 'CREDIT';
  isPostable: boolean;
}

/** Posted debit / credit totals of one account over a range. */
export interface AccountTotal {
  account: ChartAccount;
  debit: Decimal;
  credit: Decimal;
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

  /** The company's whole chart of accounts (groups included), by code. */
  async chart(): Promise<ChartAccount[]> {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    return db.account.findMany({
      where: { companyId },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        parentId: true,
        accountType: true,
        normalBalance: true,
        isPostable: true,
      },
      orderBy: { code: 'asc' },
    });
  }

  /**
   * Posted debit / credit totals per account, entries dated in the range
   * (both ends inclusive, either optional), for the company in CLS. The one
   * query behind the trial balance, income statement, balance sheet and
   * dashboard, so their figures agree by construction. Accounts without
   * lines in the range are absent.
   */
  async accountTotals(range: ReportRange = {}): Promise<AccountTotal[]> {
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

    const accounts = grouped.length
      ? await db.account.findMany({
          where: { id: { in: grouped.map((g) => g.accountId) } },
          select: {
            id: true,
            code: true,
            nameAr: true,
            nameEn: true,
            parentId: true,
            accountType: true,
            normalBalance: true,
            isPostable: true,
          },
        })
      : [];
    const byId = new Map(accounts.map((a) => [a.id, a]));

    return grouped
      .map((g) => {
        const account = byId.get(g.accountId);
        if (!account) return null;
        return {
          account,
          debit: new Decimal(g._sum.debit?.toString() ?? 0),
          credit: new Decimal(g._sum.credit?.toString() ?? 0),
        };
      })
      .filter((r): r is AccountTotal => r !== null)
      .sort((a, b) => a.account.code.localeCompare(b.account.code));
  }

  /**
   * Trial balance. Per account:
   * - opening: everything before `from`, plus opening balances (is_opening)
   *   dated in the range — they are the start position, not movement (ADR-007);
   * - period: the other entries in the range (gross debit and credit);
   * - closing: opening + period, i.e. everything up to `to`.
   * Opening and closing are netted to one side. totalDebit / totalCredit /
   * balance keep their earlier meaning — every entry dated in the range.
   */
  async trialBalance(range: ReportRange) {
    const { tenantId, db } = this.tenant();
    const companyId = await this.companyId(db);
    const from = range.from?.slice(0, 10) ?? '1000-01-01';
    const to = range.to?.slice(0, 10) ?? '9999-12-31';

    // One pass over the lines: before `from`, opening in range, other in range.
    const sums = (await db.$queryRaw`
      SELECT jl.account_id AS accountId,
        SUM(CASE WHEN je.entry_date < ${from} THEN jl.debit ELSE 0 END) AS bd,
        SUM(CASE WHEN je.entry_date < ${from} THEN jl.credit ELSE 0 END) AS bc,
        SUM(CASE WHEN je.entry_date >= ${from} AND je.is_opening = 1 THEN jl.debit ELSE 0 END) AS od,
        SUM(CASE WHEN je.entry_date >= ${from} AND je.is_opening = 1 THEN jl.credit ELSE 0 END) AS oc,
        SUM(CASE WHEN je.entry_date >= ${from} AND je.is_opening = 0 THEN jl.debit ELSE 0 END) AS pd,
        SUM(CASE WHEN je.entry_date >= ${from} AND je.is_opening = 0 THEN jl.credit ELSE 0 END) AS pc
      FROM journal_lines jl
      JOIN journal_entries je ON je.tenant_id = jl.tenant_id AND je.id = jl.journal_entry_id
      WHERE jl.tenant_id = ${tenantId} AND je.tenant_id = ${tenantId}
        AND je.company_id = ${companyId} AND je.status = 'POSTED' AND je.entry_date <= ${to}
      GROUP BY jl.account_id
    `) as { accountId: bigint; bd: unknown; bc: unknown; od: unknown; oc: unknown; pd: unknown; pc: unknown }[];

    const accounts = sums.length
      ? await db.account.findMany({
          where: { companyId, id: { in: sums.map((r) => BigInt(r.accountId)) } },
          select: { id: true, code: true, nameAr: true, nameEn: true, accountType: true, normalBalance: true },
        })
      : [];
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const d = (v: unknown) => new Decimal(String(v ?? 0));
    const side = (n: Decimal) => ({ debit: n.gt(0) ? n : new Decimal(0), credit: n.lt(0) ? n.neg() : new Decimal(0) });
    const isZero = (...vs: string[]) => vs.every((v) => new Decimal(v).isZero());

    const rows = sums
      .map((s) => {
        const a = byId.get(BigInt(s.accountId));
        if (!a) return null;
        const debit = d(s.od).plus(d(s.pd));
        const credit = d(s.oc).plus(d(s.pc));
        const opening = side(d(s.bd).plus(d(s.od)).minus(d(s.bc)).minus(d(s.oc)));
        const closing = side(d(s.bd).plus(debit).minus(d(s.bc)).minus(credit));
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
          openingDebit: opening.debit.toString(),
          openingCredit: opening.credit.toString(),
          periodDebit: d(s.pd).toString(),
          periodCredit: d(s.pc).toString(),
          closingDebit: closing.debit.toString(),
          closingCredit: closing.credit.toString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      // Accounts that only moved before `from` and net to zero add nothing.
      .filter((r) => !isZero(r.openingDebit, r.openingCredit, r.totalDebit, r.totalCredit))
      .sort((a, b) => a.code.localeCompare(b.code));

    const total = (pick: (r: (typeof rows)[number]) => string) => sum(rows.map(pick)).toString();
    const totalDebit = sum(rows.map((r) => r.totalDebit));
    const totalCredit = sum(rows.map((r) => r.totalCredit));
    return {
      rows,
      totals: {
        debit: totalDebit.toString(),
        credit: totalCredit.toString(),
        openingDebit: total((r) => r.openingDebit),
        openingCredit: total((r) => r.openingCredit),
        periodDebit: total((r) => r.periodDebit),
        periodCredit: total((r) => r.periodCredit),
        closingDebit: total((r) => r.closingDebit),
        closingCredit: total((r) => r.closingCredit),
      },
      balanced: totalDebit.eq(totalCredit),
    };
  }

  /**
   * Line filter for statement-style reports (ledger, party statement), ADR-007:
   * `lines` = entries in the range that are not opening balances; `opening` =
   * everything before `from` plus opening balances dated in the range.
   */
  private openingSplit(range: ReportRange, companyId: bigint) {
    const dateWhere = this.dateWhere(range);
    const inRange = Object.keys(dateWhere).length ? { entryDate: dateWhere } : {};
    return {
      lines: { companyId, status: 'POSTED' as const, isOpening: false, ...inRange },
      opening: {
        companyId,
        status: 'POSTED' as const,
        OR: [
          ...(range.from ? [{ entryDate: { lt: new Date(range.from) } }] : []),
          { isOpening: true, ...inRange },
        ],
      },
    };
  }

  /** General ledger for one account: lines + running balance. */
  async generalLedger(accountId: bigint, range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);

    const account = await db.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw DomainError.notFound('Account', accountId.toString());
    const split = this.openingSplit(range, companyId);

    const lines = await db.journalLine.findMany({
      where: { accountId, entry: split.lines },
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

    // Opening balance = everything before `from` + opening balances in range (summed in the database).
    const before = await db.journalLine.aggregate({
      where: { accountId, entry: split.opening },
      _sum: { debit: true, credit: true },
    });
    const opening = new Decimal(before._sum.debit?.toString() ?? 0).minus(before._sum.credit?.toString() ?? 0);

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

    const split = this.openingSplit(range, companyId);
    const lines = await db.journalLine.findMany({
      where: { partyType, partyId, entry: split.lines },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }],
      include: {
        entry: {
          select: { id: true, entryNo: true, entryDate: true, description: true, sourceType: true },
        },
        account: { select: { id: true, code: true, nameAr: true } },
      },
    });

    const before = await db.journalLine.aggregate({
      where: { partyType, partyId, entry: split.opening },
      _sum: { debit: true, credit: true },
    });
    const opening = new Decimal(before._sum.debit?.toString() ?? 0).minus(before._sum.credit?.toString() ?? 0);

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

  // ------------------------------------------- aging inputs (treasury, ADR-004)

  /** Lines of this party type on its receivable/payable control accounts. */
  private controlLineWhere(partyType: 'CUSTOMER' | 'SUPPLIER', mappedAccountId?: bigint) {
    return {
      partyType,
      partyId: { not: null },
      account: {
        OR: [
          { controlType: partyType === 'CUSTOMER' ? ('CUSTOMERS' as const) : ('SUPPLIERS' as const) },
          ...(mappedAccountId ? [{ id: mappedAccountId }] : []),
        ],
      },
    };
  }

  /**
   * What each customer owes (or each supplier is owed) as of a date: posted
   * lines on the control accounts (control type CUSTOMERS / SUPPLIERS, plus
   * the mapped control account) dated ≤ asOf, in the natural sign —
   * customers Dr − Cr, suppliers Cr − Dr. Same lines as the trial balance.
   */
  async controlBalancesByParty(
    partyType: 'CUSTOMER' | 'SUPPLIER',
    asOf: Date,
    mappedAccountId?: bigint,
  ): Promise<Map<bigint, Decimal>> {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const rows = await db.journalLine.groupBy({
      by: ['partyId'],
      where: {
        ...this.controlLineWhere(partyType, mappedAccountId),
        entry: { companyId, status: 'POSTED', entryDate: { lte: asOf } },
      },
      _sum: { debit: true, credit: true },
    });
    const out = new Map<bigint, Decimal>();
    for (const r of rows) {
      if (r.partyId === null) continue;
      const dr = new Decimal(r._sum.debit?.toString() ?? '0');
      const cr = new Decimal(r._sum.credit?.toString() ?? '0');
      out.set(r.partyId, partyType === 'CUSTOMER' ? dr.minus(cr) : cr.minus(dr));
    }
    return out;
  }

  /**
   * Opening-balance and manual-journal amounts that raise a party's balance
   * (customers: debits, suppliers: credits) on its control accounts, dated
   * ≤ asOf, from entries not reversed on or before asOf. Aging cannot match
   * these to an invoice, so it ages them by their entry date.
   */
  async openingAndManualItemsByParty(
    partyType: 'CUSTOMER' | 'SUPPLIER',
    asOf: Date,
    mappedAccountId?: bigint,
  ): Promise<Map<bigint, { entryDate: Date; amount: Decimal }[]>> {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const raising = partyType === 'CUSTOMER' ? { debit: { gt: 0 } } : { credit: { gt: 0 } };
    const lines = await db.journalLine.findMany({
      where: {
        ...this.controlLineWhere(partyType, mappedAccountId),
        ...raising,
        entry: {
          companyId,
          status: 'POSTED',
          postingKind: 'POST',
          sourceType: { in: ['OPENING_ENTRY', 'MANUAL_JOURNAL'] },
          entryDate: { lte: asOf },
          reversals: { none: { status: 'POSTED', entryDate: { lte: asOf } } },
        },
      },
      select: { partyId: true, debit: true, credit: true, entry: { select: { entryDate: true } } },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }],
    });
    const out = new Map<bigint, { entryDate: Date; amount: Decimal }[]>();
    for (const l of lines) {
      if (l.partyId === null) continue;
      const amount = new Decimal((partyType === 'CUSTOMER' ? l.debit : l.credit).toString());
      const list = out.get(l.partyId) ?? [];
      list.push({ entryDate: l.entry.entryDate, amount });
      out.set(l.partyId, list);
    }
    return out;
  }
}
