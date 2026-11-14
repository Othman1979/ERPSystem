import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Decimal, sum } from '../../common/decimal/decimal.utils.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { branchWhere } from '../../common/branch/branch-context.js';
import { CursorCodec } from '../../common/paging/cursor.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { FiscalService } from '../accounting/fiscal.service.js';
import { EXPORT_LIMITS } from '../printing/printing.service.js';
import { afterLine, LINE_ORDER, lineCursor, lineState, type StatementPageQuery } from './statement-cursor.js';

/** Accounts closed into equity at year end (their opening restarts each year). */
const NOMINAL_TYPES: ReadonlySet<string> = new Set(['REVENUE', 'EXPENSE']);

/** Amount string with 3 decimals, as the statements print them ('100.000'). */
const amt = (d: Decimal): string => d.toFixed(3);

export interface ReportRange {
  from?: string;
  to?: string;
}

export type AccountTypeCode = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';

/**
 * A net debit-minus-credit balance shown on one side: `{prefix}Debit` when
 * positive, `{prefix}Credit` when negative, the other side '0.000'.
 */
export function sides<P extends string>(
  prefix: P,
  net: Decimal,
): Record<`${P}Debit` | `${P}Credit`, string> {
  return {
    [`${prefix}Debit`]: amt(net.gt(0) ? net : new Decimal(0)),
    [`${prefix}Credit`]: amt(net.lt(0) ? net.neg() : new Decimal(0)),
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly fiscal: FiscalService,
    private readonly cursors: CursorCodec,
  ) {}

  /**
   * Profit and loss accounts start each fiscal year at zero (ADR-008 §7,
   * owner's option B — no closing entry, §8.5): with a `from`, their opening
   * counts only from the start of the fiscal year holding `from`. Returns
   * that start, or null (no `from`, or no fiscal year around it).
   */
  private async nominalStart(range: ReportRange): Promise<Date | null> {
    if (!range.from) return null;
    const from = new Date(range.from);
    const year = await this.fiscal.yearContaining(from);
    return year ? new Date(year.startDate) : null;
  }

  /** Rejects a range whose `from` is after its `to` (yyyy-mm-dd strings compare in date order). */
  private assertRange(range: ReportRange) {
    if (range.from && range.to && range.from > range.to) {
      throw new DomainError(ErrorCode.INVALID_DATE_RANGE, 'from must not be after to', {
        from: range.from,
        to: range.to,
      });
    }
  }

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
    this.assertRange(range);
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const nominalStart = await this.nominalStart(range);
    const [inRange, opening, movement, chart, prior] = await Promise.all([
      this.accountTotals(range),
      this.sumsByAccount(db, companyId, this.openingEntryWhere(range)),
      this.sumsByAccount(db, companyId, this.movementEntryWhere(range)),
      this.chart(),
      // Lines of earlier fiscal years: P&L accounts leave them out of their opening.
      nominalStart
        ? this.sumsByAccount(db, companyId, { entryDate: { lt: nominalStart } })
        : Promise.resolve(new Map<bigint, { debit: Decimal; credit: Decimal }>()),
    ]);
    const accountById = new Map(chart.map((a) => [a.id, a]));
    const inRangeById = new Map(inRange.map((r) => [r.account.id, r]));
    const zero = { debit: new Decimal(0), credit: new Decimal(0) };
    const ids = new Set([...inRangeById.keys(), ...opening.keys(), ...movement.keys()]);
    // Unclosed profit of earlier years (debit − credit; negative = profit).
    let priorNet = new Decimal(0);

    const accountRows = [...ids]
      .map((id) => {
        const a = accountById.get(id);
        if (!a) return null;
        const debit = inRangeById.get(id)?.debit ?? new Decimal(0);
        const credit = inRangeById.get(id)?.credit ?? new Decimal(0);
        let o = opening.get(id) ?? zero;
        const p = prior.get(id);
        if (p && NOMINAL_TYPES.has(a.accountType)) {
          o = { debit: o.debit.minus(p.debit), credit: o.credit.minus(p.credit) };
          priorNet = priorNet.plus(p.debit).minus(p.credit);
        }
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
          /** null for an account; PRIOR_YEARS for the computed equity row. */
          kind: null as 'PRIOR_YEARS' | null,
          code: a.code,
          nameAr: a.nameAr,
          nameEn: a.nameEn,
          accountType: a.accountType,
          normalBalance: a.normalBalance,
          totalDebit: amt(debit),
          totalCredit: amt(credit),
          balance: amt(balance),
          ...sides('opening', openingNet),
          periodDebit: amt(m.debit),
          periodCredit: amt(m.credit),
          ...sides('closing', closingNet),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((x, y) => x.code.localeCompare(y.code));

    // Earlier years' unclosed profit, shown with equity (as the balance
    // sheet's "prior years" line): the opening totals still balance.
    const rows = [...accountRows];
    if (!priorNet.isZero()) {
      const priorRow = {
        accountId: '',
        kind: 'PRIOR_YEARS' as const,
        code: '',
        nameAr: 'أرباح سنوات سابقة غير مقفلة',
        nameEn: 'Prior years profit (not closed)',
        accountType: 'EQUITY' as const,
        normalBalance: 'CREDIT' as const,
        totalDebit: '0.000',
        totalCredit: '0.000',
        balance: '0.000',
        ...sides('opening', priorNet),
        periodDebit: '0.000',
        periodCredit: '0.000',
        ...sides('closing', priorNet),
      };
      const lastEquity = rows.map((r) => r.accountType).lastIndexOf('EQUITY');
      const firstNominal = rows.findIndex((r) => NOMINAL_TYPES.has(r.accountType));
      const at = lastEquity >= 0 ? lastEquity + 1 : firstNominal >= 0 ? firstNominal : rows.length;
      rows.splice(at, 0, priorRow);
    }

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
      /** Start of the fiscal year P&L accounts open from (null: no `from` or no year). */
      nominalFrom: nominalStart ? nominalStart.toISOString().slice(0, 10) : null,
      totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, amt(v)])) as Record<
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

  /** The account, or 404 if it is not the company's. */
  private async ledgerAccount(db: ReturnType<PrismaService['forTenant']>, companyId: bigint, accountId: bigint) {
    const account = await db.account.findFirst({ where: { id: accountId, companyId } });
    if (!account) throw DomainError.notFound('Account', accountId.toString());
    return account;
  }

  /** Lines of an account statement: the period's movements on the account. */
  private ledgerWhere(companyId: bigint, accountId: bigint, range: ReportRange): Prisma.JournalLineWhereInput {
    return { accountId, entry: { companyId, status: 'POSTED', ...this.movementEntryWhere(range) } };
  }

  /**
   * Opening balance of an account statement, summed in the database
   * (ADR-008: before `from` plus the opening entries of the period). A P&L
   * account opens from the start of the fiscal year holding `from`.
   */
  private async ledgerOpening(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    account: { id: bigint; accountType: string },
    range: ReportRange,
  ): Promise<Decimal> {
    const nominalStart = NOMINAL_TYPES.has(account.accountType) ? await this.nominalStart(range) : null;
    const before = await db.journalLine.aggregate({
      where: {
        accountId: account.id,
        entry: {
          companyId,
          status: 'POSTED',
          AND: [this.openingEntryWhere(range), ...(nominalStart ? [{ entryDate: { gte: nominalStart } }] : [])],
        },
      },
      _sum: { debit: true, credit: true },
    });
    return new Decimal(before._sum.debit?.toString() ?? 0).minus(before._sum.credit?.toString() ?? 0);
  }

  private static readonly LEDGER_LINE_INCLUDE = {
    entry: {
      select: { id: true, entryNo: true, entryDate: true, description: true, sourceType: true, postingKind: true },
    },
  } as const;

  /** A statement line with the running balance after it. */
  private static ledgerRow(
    l: Prisma.JournalLineGetPayload<{ include: typeof ReportsService.LEDGER_LINE_INCLUDE }>,
    balance: Decimal,
  ) {
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
      debit: amt(new Decimal(l.debit.toString())),
      credit: amt(new Decimal(l.credit.toString())),
      balance: amt(balance),
    };
  }

  /** Header of a statement: the account (or party) and its period figures (ADR-008). */
  private static statementSummary(opening: Decimal, debit: Decimal, credit: Decimal) {
    const closing = opening.plus(debit).minus(credit);
    return {
      openingBalance: amt(opening),
      ...sides('opening', opening),
      totalDebit: amt(debit),
      totalCredit: amt(credit),
      closingBalance: amt(closing),
      ...sides('closing', closing),
    };
  }

  /** Lines with a running balance from `start`; returns the rows and the balance after the last. */
  private static withRunning<L extends { debit: unknown; credit: unknown }, R>(
    lines: L[],
    start: Decimal,
    row: (l: L, balance: Decimal) => R,
  ): { rows: R[]; balance: Decimal } {
    let running = start;
    const rows = lines.map((l) => {
      running = running.plus(new Decimal(String(l.debit))).minus(new Decimal(String(l.credit)));
      return row(l, running);
    });
    return { rows, balance: running };
  }

  private static accountHeader(account: {
    id: bigint;
    code: string;
    nameAr: string;
    nameEn: string | null;
    normalBalance: string;
  }) {
    return {
      id: account.id.toString(),
      code: account.code,
      nameAr: account.nameAr,
      nameEn: account.nameEn,
      normalBalance: account.normalBalance,
    };
  }

  /**
   * Account statement (كشف حساب / general ledger) for one account, whole:
   * the opening balance (ADR-008: before `from` plus the opening entries of
   * the period), the period's other lines with a running balance, the
   * closing. Used by the PDF / XLSX export (ADR-022 §6), capped at the XLSX
   * limit (REPORT_TOO_LARGE). The JSON screen reads it page by page
   * (generalLedgerPage).
   */
  async generalLedger(accountId: bigint, range: ReportRange) {
    this.assertRange(range);
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const account = await this.ledgerAccount(db, companyId, accountId);

    const lines = await db.journalLine.findMany({
      where: this.ledgerWhere(companyId, accountId, range),
      orderBy: LINE_ORDER,
      // LEDGER-19 / DB-14: bounded like the stock item card. One row past the
      // limit is fetched only to detect that the statement is too large.
      take: EXPORT_LIMITS.xlsx + 1,
      include: ReportsService.LEDGER_LINE_INCLUDE,
    });
    if (lines.length > EXPORT_LIMITS.xlsx) {
      throw new DomainError(
        ErrorCode.REPORT_TOO_LARGE,
        `The statement has more than ${EXPORT_LIMITS.xlsx} lines. Narrow the period.`,
        { limit: EXPORT_LIMITS.xlsx },
      );
    }
    const opening = await this.ledgerOpening(db, companyId, account, range);
    const { rows } = ReportsService.withRunning(lines, opening, ReportsService.ledgerRow);
    return {
      account: ReportsService.accountHeader(account),
      ...ReportsService.statementSummary(
        opening,
        sum(rows.map((r) => r.debit)),
        sum(rows.map((r) => r.credit)),
      ),
      rows,
    };
  }

  /**
   * One page of an account statement (ADR-022 §4, LEDGER-19): `limit`
   * lines in statement order after the cursor, each with its running
   * balance. The first page (no cursor) also carries `summary` — opening,
   * period totals and closing, summed in the database — and starts the
   * balance from the opening; later pages continue from the balance the
   * cursor carries, so reading in pages gives the same balances as reading
   * the statement whole.
   */
  async generalLedgerPage(accountId: bigint, range: ReportRange, page: StatementPageQuery) {
    this.assertRange(range);
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const account = await this.ledgerAccount(db, companyId, accountId);
    const filters = { accountId: accountId.toString(), from: range.from, to: range.to };
    const at = page.cursor ? lineCursor(this.cursors.decode('general-ledger', filters, page.cursor)) : null;
    const where = this.ledgerWhere(companyId, accountId, range);

    const lines = await db.journalLine.findMany({
      where: at ? { AND: [where, afterLine(at.key)] } : where,
      orderBy: LINE_ORDER,
      take: page.limit + 1,
      include: ReportsService.LEDGER_LINE_INCLUDE,
    });
    const more = lines.length > page.limit;
    if (more) lines.pop();

    let summary: ReturnType<typeof ReportsService.statementSummary> | null = null;
    let start: Decimal;
    if (at) {
      start = at.balance;
    } else {
      const [opening, totals] = await Promise.all([
        this.ledgerOpening(db, companyId, account, range),
        db.journalLine.aggregate({ where, _sum: { debit: true, credit: true } }),
      ]);
      summary = ReportsService.statementSummary(
        opening,
        new Decimal(totals._sum.debit?.toString() ?? 0),
        new Decimal(totals._sum.credit?.toString() ?? 0),
      );
      start = opening;
    }
    const { rows, balance } = ReportsService.withRunning(lines, start, ReportsService.ledgerRow);
    const last = lines[lines.length - 1];
    return {
      account: ReportsService.accountHeader(account),
      summary,
      items: rows,
      nextCursor: more && last ? this.cursors.encode('general-ledger', filters, lineState(last, balance)) : null,
    };
  }

  /**
   * Lines of a party statement: control-account lines of the party in the
   * period, on the caller's branches only (ADR-003 §12: the line's branch).
   */
  private partyWhere(
    companyId: bigint,
    partyType: 'CUSTOMER' | 'SUPPLIER',
    partyId: bigint,
    entryWhere: Prisma.JournalEntryWhereInput,
  ): Prisma.JournalLineWhereInput {
    return {
      partyType,
      partyId,
      entry: { companyId, status: 'POSTED', ...entryWhere },
      AND: [branchWhere()],
    };
  }

  /** Opening balance of a party statement, on the caller's branches. */
  private async partyOpening(
    db: ReturnType<PrismaService['forTenant']>,
    companyId: bigint,
    partyType: 'CUSTOMER' | 'SUPPLIER',
    partyId: bigint,
    range: ReportRange,
  ): Promise<Decimal> {
    const before = await db.journalLine.aggregate({
      where: this.partyWhere(companyId, partyType, partyId, this.openingEntryWhere(range)),
      _sum: { debit: true, credit: true },
    });
    return new Decimal(before._sum.debit?.toString() ?? 0).minus(before._sum.credit?.toString() ?? 0);
  }

  private static readonly PARTY_LINE_INCLUDE = {
    ...ReportsService.LEDGER_LINE_INCLUDE,
    account: { select: { id: true, code: true, nameAr: true, nameEn: true } },
  } as const;

  private static partyRow(
    l: Prisma.JournalLineGetPayload<{ include: typeof ReportsService.PARTY_LINE_INCLUDE }>,
    balance: Decimal,
  ) {
    return {
      lineId: l.id.toString(),
      entryId: l.entry.id.toString(),
      entryNo: l.entry.entryNo,
      entryDate: l.entry.entryDate,
      accountCode: l.account.code,
      accountName: l.account.nameAr,
      accountNameEn: l.account.nameEn,
      sourceType: l.entry.sourceType,
      postingKind: l.entry.postingKind,
      description: l.description ?? l.entry.description,
      debit: amt(new Decimal(l.debit.toString())),
      credit: amt(new Decimal(l.credit.toString())),
      balance: amt(balance),
    };
  }

  /**
   * Party statement, whole: control-account lines for one customer/supplier,
   * with the same opening / movements / closing split as the account
   * statement, on the caller's branches (ADR-003 §12). Used by the PDF /
   * XLSX export; the JSON screen reads it page by page (partyStatementPage).
   */
  async partyStatement(partyType: 'CUSTOMER' | 'SUPPLIER', partyId: bigint, range: ReportRange) {
    this.assertRange(range);
    const { db } = this.tenant();
    const companyId = await this.companyId(db);

    const lines = await db.journalLine.findMany({
      where: this.partyWhere(companyId, partyType, partyId, this.movementEntryWhere(range)),
      orderBy: LINE_ORDER,
      // LEDGER-19 / DB-14: bounded like the general ledger (see generalLedger).
      take: EXPORT_LIMITS.xlsx + 1,
      include: ReportsService.PARTY_LINE_INCLUDE,
    });
    if (lines.length > EXPORT_LIMITS.xlsx) {
      throw new DomainError(
        ErrorCode.REPORT_TOO_LARGE,
        `The statement has more than ${EXPORT_LIMITS.xlsx} lines. Narrow the period.`,
        { limit: EXPORT_LIMITS.xlsx },
      );
    }
    const opening = await this.partyOpening(db, companyId, partyType, partyId, range);
    const { rows } = ReportsService.withRunning(lines, opening, ReportsService.partyRow);
    return {
      partyType,
      partyId: partyId.toString(),
      ...ReportsService.statementSummary(
        opening,
        sum(rows.map((r) => r.debit)),
        sum(rows.map((r) => r.credit)),
      ),
      rows,
    };
  }

  /** One page of a party statement (ADR-022 §4), like generalLedgerPage. */
  async partyStatementPage(
    partyType: 'CUSTOMER' | 'SUPPLIER',
    partyId: bigint,
    range: ReportRange,
    page: StatementPageQuery,
  ) {
    this.assertRange(range);
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const filters = { partyType, partyId: partyId.toString(), from: range.from, to: range.to };
    const at = page.cursor ? lineCursor(this.cursors.decode('party-statement', filters, page.cursor)) : null;
    const where = this.partyWhere(companyId, partyType, partyId, this.movementEntryWhere(range));

    const lines = await db.journalLine.findMany({
      where: at ? { AND: [where, afterLine(at.key)] } : where,
      orderBy: LINE_ORDER,
      take: page.limit + 1,
      include: ReportsService.PARTY_LINE_INCLUDE,
    });
    const more = lines.length > page.limit;
    if (more) lines.pop();

    let summary: ReturnType<typeof ReportsService.statementSummary> | null = null;
    let start: Decimal;
    if (at) {
      start = at.balance;
    } else {
      const [opening, totals] = await Promise.all([
        this.partyOpening(db, companyId, partyType, partyId, range),
        db.journalLine.aggregate({ where, _sum: { debit: true, credit: true } }),
      ]);
      summary = ReportsService.statementSummary(
        opening,
        new Decimal(totals._sum.debit?.toString() ?? 0),
        new Decimal(totals._sum.credit?.toString() ?? 0),
      );
      start = opening;
    }
    const { rows, balance } = ReportsService.withRunning(lines, start, ReportsService.partyRow);
    const last = lines[lines.length - 1];
    return {
      partyType,
      partyId: partyId.toString(),
      summary,
      items: rows,
      nextCursor: more && last ? this.cursors.encode('party-statement', filters, lineState(last, balance)) : null,
    };
  }

  // ------------------------------------------- aging inputs (treasury, ADR-004)

  /** Entry date of each given journal entry of the company (treasury aging: voucher reversal dates). */
  async entryDates(ids: bigint[]): Promise<Map<bigint, Date>> {
    if (ids.length === 0) return new Map();
    const { db } = this.tenant();
    const companyId = await this.companyId(db);
    const rows = await db.journalEntry.findMany({
      where: { companyId, id: { in: [...new Set(ids)] } },
      select: { id: true, entryDate: true },
    });
    return new Map(rows.map((r) => [r.id, r.entryDate]));
  }

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
