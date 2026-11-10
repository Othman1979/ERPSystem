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

/**
 * A net debit-minus-credit balance shown on one side: `{prefix}Debit` when
 * positive, `{prefix}Credit` when negative, the other side '0'.
 */
export function sides<P extends string>(
  prefix: P,
  net: Decimal,
): Record<`${P}Debit` | `${P}Credit`, string> {
  return {
    [`${prefix}Debit`]: (net.gt(0) ? net : new Decimal(0)).toString(),
    [`${prefix}Credit`]: (net.lt(0) ? net.neg() : new Decimal(0)).toString(),
  } as Record<`${P}Debit` | `${P}Credit`, string>;
}

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

  /**
   * Entries making up a period's opening balance (ADR-008): everything dated
   * before `from`, plus the opening entries (is_opening) dated in the period.
   * Without `from`, the opening entries up to `to`.
   */
  private openingEntryWhere(range: ReportRange) {
    const inRange = this.dateWhere(range);
    const openingInRange = {
      isOpening: true,
      ...(Object.keys(inRange).length ? { entryDate: inRange } : {}),
    };
    return range.from
      ? { OR: [{ entryDate: { lt: new Date(range.from) } }, openingInRange] }
      : openingInRange;
  }

  /** Entries that are the period's movements: dated in it and not opening entries. */
  private movementEntryWhere(range: ReportRange) {
    const inRange = this.dateWhere(range);
    return { isOpening: false, ...(Object.keys(inRange).length ? { entryDate: inRange } : {}) };
  }

  /** Posted debit / credit sums per account for an entry filter. */
  private async sumsByAccount(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    entryWhere: Record<string, unknown>,
  ): Promise<Map<bigint, { debit: Decimal; credit: Decimal }>> {
    const grouped = await db.journalLine.groupBy({
      by: ['accountId'],
      where: { entry: { companyId, status: 'POSTED', ...entryWhere } },
      _sum: { debit: true, credit: true },
    });
    return new Map(
      grouped.map((g) => [
        g.accountId,
        {
          debit: new Decimal(g._sum.debit?.toString() ?? 0),
          credit: new Decimal(g._sum.credit?.toString() ?? 0),
        },
      ]),
    );
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

  /** Trial balance: per-account debit/credit totals over POSTED entries. */
  /**
   * Trial balance with balances and totals (ميزان بالأرصدة والمجاميع, ADR-008):
   * per account the opening balance (net, on one side), the period's
   * movements (both sides) and the closing balance (net, on one side).
   * `totalDebit` / `totalCredit` / `balance` keep their meaning: every posted
   * line dated in the range, opening entries included.
   */
  async trialBalance(range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const [inRange, opening, movement, chart] = await Promise.all([
      this.accountTotals(range),
      this.sumsByAccount(db, companyId, this.openingEntryWhere(range)),
      this.sumsByAccount(db, companyId, this.movementEntryWhere(range)),
      this.chart(),
    ]);
    const accountById = new Map(chart.map((a) => [a.id, a]));
    const inRangeById = new Map(inRange.map((r) => [r.account.id, r]));
    const zero = { debit: new Decimal(0), credit: new Decimal(0) };
    const ids = new Set([...inRangeById.keys(), ...opening.keys(), ...movement.keys()]);

    const rows = [...ids]
      .map((id) => {
        const a = accountById.get(id);
        if (!a) return null;
        const debit = inRangeById.get(id)?.debit ?? new Decimal(0);
        const credit = inRangeById.get(id)?.credit ?? new Decimal(0);
        const o = opening.get(id) ?? zero;
        const m = movement.get(id) ?? zero;
        const openingNet = o.debit.minus(o.credit);
        const closingNet = openingNet.plus(m.debit).minus(m.credit);
        if (openingNet.isZero() && m.debit.isZero() && m.credit.isZero() && debit.isZero() && credit.isZero()) {
          return null;
        }
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
          ...sides('opening', openingNet),
          periodDebit: m.debit.toString(),
          periodCredit: m.credit.toString(),
          ...sides('closing', closingNet),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((x, y) => x.code.localeCompare(y.code));

    const total = (key: keyof (typeof rows)[number]) => sum(rows.map((r) => r[key] as string));
    const totals = {
      debit: total('totalDebit'),
      credit: total('totalCredit'),
      openingDebit: total('openingDebit'),
      openingCredit: total('openingCredit'),
      periodDebit: total('periodDebit'),
      periodCredit: total('periodCredit'),
      closingDebit: total('closingDebit'),
      closingCredit: total('closingCredit'),
    };
    return {
      rows,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])) as Record<
        keyof typeof totals,
        string
      >,
      balanced:
        totals.debit.eq(totals.credit) &&
        totals.openingDebit.eq(totals.openingCredit) &&
        totals.periodDebit.eq(totals.periodCredit) &&
        totals.closingDebit.eq(totals.closingCredit),
    };
  }

  /**
   * Account statement (كشف حساب / general ledger) for one account: the
   * opening balance (ADR-008: before `from` plus the opening entries of the
   * period), the period's other lines with a running balance, the closing.
   */
  async generalLedger(accountId: bigint, range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);

    const account = await db.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw DomainError.notFound('Account', accountId.toString());

    const lines = await db.journalLine.findMany({
      where: {
        accountId,
        entry: { companyId, status: 'POSTED', ...this.movementEntryWhere(range) },
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

    // Opening balance, summed in the database.
    const before = await db.journalLine.aggregate({
      where: { accountId, entry: { companyId, status: 'POSTED', ...this.openingEntryWhere(range) } },
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
      ...sides('opening', opening),
      totalDebit: sum(rows.map((r) => r.debit)).toString(),
      totalCredit: sum(rows.map((r) => r.credit)).toString(),
      closingBalance: running.toString(),
      ...sides('closing', running),
      rows,
    };
  }

  /**
   * Party statement: control-account lines for one customer/supplier, with
   * the same opening / movements / closing split as the account statement.
   */
  async partyStatement(partyType: 'CUSTOMER' | 'SUPPLIER', partyId: bigint, range: ReportRange) {
    const { db } = this.tenant();
    const companyId = await this.companyId(db);

    const lines = await db.journalLine.findMany({
      where: {
        partyType,
        partyId,
        entry: { companyId, status: 'POSTED', ...this.movementEntryWhere(range) },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { id: 'asc' } }, { lineNo: 'asc' }],
      include: {
        entry: {
          select: { id: true, entryNo: true, entryDate: true, description: true, sourceType: true },
        },
        account: { select: { id: true, code: true, nameAr: true } },
      },
    });

    const before = await db.journalLine.aggregate({
      where: { partyType, partyId, entry: { companyId, status: 'POSTED', ...this.openingEntryWhere(range) } },
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
      ...sides('opening', opening),
      closingBalance: running.toString(),
      ...sides('closing', running),
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
