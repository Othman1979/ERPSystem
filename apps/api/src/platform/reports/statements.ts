import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { AccountTotal, AccountTypeCode, ChartAccount } from '../journal/reports.service.js';

/**
 * Financial statement formulas (BUILD_PLAN §8.5, Phase 8), pure functions
 * over the journal's account totals so they can be unit tested:
 *  - REVENUE shown Cr − Dr (contra accounts such as sales returns come out
 *    negative), EXPENSE and ASSET Dr − Cr, LIABILITY and EQUITY Cr − Dr;
 *  - net profit = Σ (Cr − Dr) over REVENUE + EXPENSE accounts;
 *  - accounts' normal_balance is not used: the sign follows the type.
 */

export interface StatementRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  /** 0 for a root of the section, +1 per level. */
  depth: number;
  /** A group: `amount` is the subtotal of the accounts under it. */
  isGroup: boolean;
  amount: string;
}

export interface StatementSection {
  rows: StatementRow[];
  total: string;
}

const CREDIT_SIDE: ReadonlySet<AccountTypeCode> = new Set(['LIABILITY', 'EQUITY', 'REVENUE']);

/** Amount in the statement's sign for the account's type. */
export function statementAmount(type: AccountTypeCode, debit: Decimal, credit: Decimal): Decimal {
  return CREDIT_SIDE.has(type) ? credit.minus(debit) : debit.minus(credit);
}

/** Σ (Cr − Dr) over REVENUE and EXPENSE accounts: the profit of the totals' range. */
export function profitOf(totals: AccountTotal[]): Decimal {
  return totals
    .filter((t) => t.account.accountType === 'REVENUE' || t.account.accountType === 'EXPENSE')
    .reduce((s, t) => s.plus(t.credit).minus(t.debit), new Decimal(0));
}

/**
 * One statement section as the account tree: every account the filter
 * keeps that has lines in `totals`, under its ancestors; each ancestor is a
 * group row carrying the subtotal of the kept accounts below it. Pre-order,
 * siblings by code. `total` = Σ kept accounts = Σ root subtotals.
 */
export function accountTree(
  chart: ChartAccount[],
  totals: AccountTotal[],
  keep: (a: ChartAccount) => boolean,
): { rows: StatementRow[]; total: Decimal } {
  const own = new Map<bigint, Decimal>();
  for (const t of totals) {
    if (keep(t.account)) own.set(t.account.id, statementAmount(t.account.accountType, t.debit, t.credit));
  }
  const ids = new Set(chart.map((a) => a.id));
  // An account whose parent is not in the chart is treated as a root.
  const parentOf = (a: ChartAccount) => (a.parentId !== null && ids.has(a.parentId) ? a.parentId : null);
  const children = new Map<bigint | null, ChartAccount[]>();
  for (const a of [...chart].sort((x, y) => x.code.localeCompare(y.code))) {
    const p = parentOf(a);
    const list = children.get(p) ?? [];
    list.push(a);
    children.set(p, list);
  }

  const subtotal = new Map<bigint, Decimal>();
  const present = new Set<bigint>();
  const visit = (a: ChartAccount, seen: Set<bigint>): Decimal => {
    if (seen.has(a.id)) return new Decimal(0); // a cycle in parent links: never loop
    seen.add(a.id);
    let s = own.get(a.id) ?? new Decimal(0);
    let any = own.has(a.id);
    for (const c of children.get(a.id) ?? []) {
      s = s.plus(visit(c, seen));
      if (present.has(c.id)) any = true;
    }
    subtotal.set(a.id, s);
    if (any) present.add(a.id);
    return s;
  };
  const roots = children.get(null) ?? [];
  const seen = new Set<bigint>();
  let total = new Decimal(0);
  for (const r of roots) total = total.plus(visit(r, seen));

  const rows: StatementRow[] = [];
  const emit = (a: ChartAccount, depth: number) => {
    if (!present.has(a.id)) return;
    const kids = (children.get(a.id) ?? []).filter((c) => present.has(c.id));
    rows.push({
      accountId: a.id.toString(),
      code: a.code,
      nameAr: a.nameAr,
      nameEn: a.nameEn,
      depth,
      isGroup: kids.length > 0,
      amount: (subtotal.get(a.id) ?? new Decimal(0)).toFixed(3),
    });
    for (const c of kids) emit(c, depth + 1);
  };
  for (const r of roots) emit(r, 0);
  return { rows, total };
}

export interface CostOfSalesRow {
  kind: 'COGS' | 'INVENTORY_ADJUSTMENT';
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  amount: string;
}

/**
 * Income statement over one range of account totals:
 *  - revenue = Σ REVENUE (Cr − Dr);
 *  - cost of sales = the COGS mapping account + the INVENTORY_ADJUSTMENT
 *    mapping account (count differences, stock in/out), each Dr − Cr, as
 *    two lines;
 *  - gross profit = revenue − cost of sales;
 *  - expenses = every other EXPENSE account (Dr − Cr), as the account tree;
 *  - net profit = Σ (Cr − Dr) over REVENUE + EXPENSE (= gross − expenses).
 */
export function incomeStatement(
  chart: ChartAccount[],
  totals: AccountTotal[],
  mapped: { cogs?: bigint; inventoryAdjustment?: bigint },
) {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const totalOf = new Map(totals.map((t) => [t.account.id, t]));
  const costLines: { kind: CostOfSalesRow['kind']; id?: bigint }[] = [
    { kind: 'COGS', id: mapped.cogs },
    { kind: 'INVENTORY_ADJUSTMENT', id: mapped.inventoryAdjustment },
  ];
  const costIds = new Set<bigint>();
  const costRows: CostOfSalesRow[] = [];
  let costTotal = new Decimal(0);
  for (const line of costLines) {
    const a = line.id !== undefined ? byId.get(line.id) : undefined;
    // Only an EXPENSE account can be a cost of sales; anything else stays in its own section.
    if (!a || a.accountType !== 'EXPENSE' || costIds.has(a.id)) continue;
    costIds.add(a.id);
    const t = totalOf.get(a.id);
    const amount = t ? t.debit.minus(t.credit) : new Decimal(0);
    costTotal = costTotal.plus(amount);
    costRows.push({ kind: line.kind, accountId: a.id.toString(), code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, amount: amount.toFixed(3) });
  }

  const revenue = accountTree(chart, totals, (a) => a.accountType === 'REVENUE');
  const expenses = accountTree(chart, totals, (a) => a.accountType === 'EXPENSE' && !costIds.has(a.id));
  const grossProfit = revenue.total.minus(costTotal);
  const netProfit = profitOf(totals);
  return {
    revenue: { rows: revenue.rows, total: revenue.total.toFixed(3) },
    costOfSales: { rows: costRows, total: costTotal.toFixed(3) },
    grossProfit: grossProfit.toFixed(3),
    expenses: { rows: expenses.rows, total: expenses.total.toFixed(3) },
    netProfit: netProfit.toFixed(3),
  };
}

/**
 * Balance sheet as of a date, including closing entries (§8.5):
 *  - assets = Σ ASSET (Dr − Cr), liabilities = Σ LIABILITY (Cr − Dr),
 *    equity = Σ EQUITY (Cr − Dr), all lines dated ≤ asOf;
 *  - priorYears = Σ (Cr − Dr) of REVENUE + EXPENSE before the start of the
 *    fiscal year containing asOf; yearProfit = the same from that start to
 *    asOf (= the income statement's net profit for that range);
 *  - balanced ⇔ assets = liabilities + equity + priorYears + yearProfit.
 */
export function balanceSheet(
  chart: ChartAccount[],
  asOfTotals: AccountTotal[],
  priorTotals: AccountTotal[],
  yearTotals: AccountTotal[],
) {
  const assets = accountTree(chart, asOfTotals, (a) => a.accountType === 'ASSET');
  const liabilities = accountTree(chart, asOfTotals, (a) => a.accountType === 'LIABILITY');
  const equity = accountTree(chart, asOfTotals, (a) => a.accountType === 'EQUITY');
  const priorYears = profitOf(priorTotals);
  const yearProfit = profitOf(yearTotals);
  const totalLiabilitiesAndEquity = liabilities.total.plus(equity.total).plus(priorYears).plus(yearProfit);
  return {
    assets: { rows: assets.rows, total: assets.total.toFixed(3) },
    liabilities: { rows: liabilities.rows, total: liabilities.total.toFixed(3) },
    equity: { rows: equity.rows, total: equity.total.toFixed(3) },
    priorYears: priorYears.toFixed(3),
    yearProfit: yearProfit.toFixed(3),
    totalLiabilitiesAndEquity: totalLiabilitiesAndEquity.toFixed(3),
    difference: assets.total.minus(totalLiabilitiesAndEquity).toFixed(3),
    balanced: assets.total.eq(totalLiabilitiesAndEquity),
  };
}

/** One column of the income statement by cost centre: a centre, or "no centre" (all nulls). */
export interface CostCenterColumn {
  costCenterId: string | null;
  code: string | null;
  nameAr: string | null;
  nameEn: string | null;
}

/** One account of the income statement by cost centre: its amount per column and in total. */
export interface CostCenterStatementRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  amounts: string[];
  total: string;
}

export interface CostCenterSection {
  rows: CostCenterStatementRow[];
  /** Per column, in column order. */
  totals: string[];
  total: string;
}

/**
 * Income statement by cost centre (ADR-024 §1.9), over the per-(account,
 * centre) totals of the range:
 *  - one column per centre with lines in the range (by code), then "no
 *    centre" (always present, last); a centre missing from `centres` (an
 *    orphan id) keeps its column, named by its id;
 *  - revenue rows Cr − Dr, expense rows Dr − Cr (cost of sales included), the
 *    postable accounts with lines, by code;
 *  - net profit per column = revenue − expenses; the columns add up to the
 *    total, which is the income statement's net profit for the same range
 *    (the same lines, summed another way).
 */
export function incomeStatementByCostCenter(
  totals: (AccountTotal & { costCenterId: bigint | null })[],
  centres: { id: bigint; code: string; nameAr: string; nameEn: string | null }[],
) {
  const present = new Set(totals.map((t) => t.costCenterId).filter((id): id is bigint => id !== null));
  const known = new Map(centres.map((c) => [c.id, c]));
  const named = centres.filter((c) => present.has(c.id)).sort((a, b) => a.code.localeCompare(b.code));
  const orphans = [...present].filter((id) => !known.has(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const columns: CostCenterColumn[] = [
    ...named.map((c) => ({ costCenterId: c.id.toString(), code: c.code, nameAr: c.nameAr, nameEn: c.nameEn })),
    ...orphans.map((id) => ({ costCenterId: id.toString(), code: id.toString(), nameAr: null, nameEn: null })),
    { costCenterId: null, code: null, nameAr: null, nameEn: null },
  ];
  const columnOf = new Map(columns.map((c, i) => [c.costCenterId ?? '', i]));
  const zeros = () => columns.map(() => new Decimal(0));

  const section = (type: 'REVENUE' | 'EXPENSE') => {
    const byAccount = new Map<bigint, { account: AccountTotal['account']; amounts: Decimal[] }>();
    for (const t of totals) {
      if (t.account.accountType !== type) continue;
      const row = byAccount.get(t.account.id) ?? { account: t.account, amounts: zeros() };
      const i = columnOf.get(t.costCenterId?.toString() ?? '')!;
      row.amounts[i] = row.amounts[i].plus(statementAmount(type, t.debit, t.credit));
      byAccount.set(t.account.id, row);
    }
    const sums = zeros();
    const rows = [...byAccount.values()]
      .sort((a, b) => a.account.code.localeCompare(b.account.code))
      .map(({ account, amounts }) => {
        amounts.forEach((a, i) => (sums[i] = sums[i].plus(a)));
        return {
          accountId: account.id.toString(),
          code: account.code,
          nameAr: account.nameAr,
          nameEn: account.nameEn,
          amounts: amounts.map((a) => a.toFixed(3)),
          total: amounts.reduce((s, a) => s.plus(a), new Decimal(0)).toFixed(3),
        };
      });
    const total = sums.reduce((s, a) => s.plus(a), new Decimal(0));
    return { section: { rows, totals: sums.map((a) => a.toFixed(3)), total: total.toFixed(3) }, sums, total };
  };

  const revenue = section('REVENUE');
  const expenses = section('EXPENSE');
  const net = revenue.sums.map((r, i) => r.minus(expenses.sums[i]));
  return {
    columns,
    revenue: revenue.section,
    expenses: expenses.section,
    netProfit: { amounts: net.map((a) => a.toFixed(3)), total: revenue.total.minus(expenses.total).toFixed(3) },
  };
}

export type CashFlowActivityCode = 'OPERATING' | 'INVESTING' | 'FINANCING';

export interface CashFlowRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  amount: string;
}

const isCash = (a: ChartAccount) => a.controlType === 'CASH' || a.controlType === 'BANK';

/** ADR-036 §3: the account's section; null for cash and income statement accounts. */
export function cashFlowActivityOf(a: ChartAccount): CashFlowActivityCode | null {
  if (isCash(a) || a.accountType === 'REVENUE' || a.accountType === 'EXPENSE') return null;
  return a.cashFlowActivity ?? (a.accountType === 'EQUITY' ? 'FINANCING' : 'OPERATING');
}

/** Σ (Dr − Cr) over the cash and bank accounts. */
export function cashBalance(totals: AccountTotal[]): Decimal {
  return totals.filter((t) => isCash(t.account)).reduce((s, t) => s.plus(t.debit).minus(t.credit), new Decimal(0));
}

/**
 * Cash flow statement, indirect method (ADR-036 §1), over the period's totals
 * without closing entries:
 *  - operating = net profit + Σ (Cr − Dr) of OPERATING accounts;
 *  - investing / financing = Σ (Cr − Dr) of their accounts;
 *  - net change = Σ sections = Σ (Dr − Cr) of cash accounts, by double entry;
 *  - closing = opening + net change (`reconciles` checks it against the cash balance at `to`).
 */
export function cashFlow(periodTotals: AccountTotal[], openingCash: Decimal, closingCash: Decimal) {
  const netProfit = profitOf(periodTotals);
  const sections: Record<CashFlowActivityCode, { rows: CashFlowRow[]; total: Decimal }> = {
    OPERATING: { rows: [], total: netProfit },
    INVESTING: { rows: [], total: new Decimal(0) },
    FINANCING: { rows: [], total: new Decimal(0) },
  };
  for (const t of periodTotals) {
    const activity = cashFlowActivityOf(t.account);
    if (!activity) continue;
    const effect = t.credit.minus(t.debit);
    if (effect.isZero()) continue;
    sections[activity].rows.push({
      accountId: t.account.id.toString(),
      code: t.account.code,
      nameAr: t.account.nameAr,
      nameEn: t.account.nameEn,
      amount: effect.toFixed(3),
    });
    sections[activity].total = sections[activity].total.plus(effect);
  }
  const netChange = sections.OPERATING.total.plus(sections.INVESTING.total).plus(sections.FINANCING.total);
  const expectedClosing = openingCash.plus(netChange);
  const section = (k: CashFlowActivityCode) => ({ rows: sections[k].rows, total: sections[k].total.toFixed(3) });
  return {
    netProfit: netProfit.toFixed(3),
    operating: section('OPERATING'),
    investing: section('INVESTING'),
    financing: section('FINANCING'),
    netChange: netChange.toFixed(3),
    openingCash: openingCash.toFixed(3),
    closingCash: closingCash.toFixed(3),
    reconciles: expectedClosing.equals(closingCash),
  };
}
