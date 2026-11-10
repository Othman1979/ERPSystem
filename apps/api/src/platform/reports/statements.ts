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
 * Balance sheet as of a date, with no closing entries (§8.5):
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
