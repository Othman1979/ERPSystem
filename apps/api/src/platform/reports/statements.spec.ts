import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { AccountTotal, AccountTypeCode, ChartAccount } from '../journal/reports.service.js';
import { accountTree, balanceSheet, incomeStatement, profitOf, statementAmount } from './statements.js';

let nextId = 1n;
const chart: ChartAccount[] = [];
const byCode: Record<string, ChartAccount> = {};
function acct(code: string, type: AccountTypeCode, parent?: string, isPostable = true) {
  const a: ChartAccount = {
    id: nextId++,
    code,
    nameAr: `ح ${code}`,
    nameEn: null,
    parentId: parent ? byCode[parent].id : null,
    accountType: type,
    normalBalance: type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    isPostable,
  };
  chart.push(a);
  byCode[code] = a;
}
acct('1', 'ASSET', undefined, false);
acct('11', 'ASSET', '1', false);
acct('1101', 'ASSET', '11');
acct('1104', 'ASSET', '11');
acct('1202', 'ASSET', '1'); // contra asset (accumulated depreciation)
acct('2', 'LIABILITY', undefined, false);
acct('2101', 'LIABILITY', '2');
acct('3', 'EQUITY', undefined, false);
acct('3103', 'EQUITY', '3');
acct('4', 'REVENUE', undefined, false);
acct('4101', 'REVENUE', '4');
acct('4102', 'REVENUE', '4'); // sales returns: debit balance, stays REVENUE
acct('42', 'REVENUE', '4', false);
acct('4201', 'REVENUE', '42');
acct('5', 'EXPENSE', undefined, false);
acct('5101', 'EXPENSE', '5'); // COGS
acct('5102', 'EXPENSE', '5'); // inventory adjustments
acct('52', 'EXPENSE', '5', false);
acct('5202', 'EXPENSE', '52');
acct('5204', 'EXPENSE', '52');

const t = (code: string, debit: Decimal.Value, credit: Decimal.Value): AccountTotal => ({
  account: byCode[code],
  debit: new Decimal(debit),
  credit: new Decimal(credit),
});

describe('statement amounts', () => {
  it('follow the account type, not normal_balance', () => {
    expect(statementAmount('REVENUE', new Decimal(100), new Decimal(30)).toString()).toBe('-70');
    expect(statementAmount('EXPENSE', new Decimal(100), new Decimal(30)).toString()).toBe('70');
    expect(statementAmount('ASSET', new Decimal(0), new Decimal(5)).toString()).toBe('-5');
    expect(statementAmount('LIABILITY', new Decimal(0), new Decimal(5)).toString()).toBe('5');
    expect(statementAmount('EQUITY', new Decimal(2), new Decimal(5)).toString()).toBe('3');
  });

  it('profit = Σ (Cr − Dr) over revenue and expense only', () => {
    expect(profitOf([t('4101', 0, 1000), t('4102', 100, 0), t('5101', 400, 0), t('1101', 900, 0)]).toString()).toBe('500');
  });
});

describe('accountTree', () => {
  it('groups carry the subtotal of the kept accounts below them, pre-order by code', () => {
    const tree = accountTree(chart, [t('4201', 0, 50), t('4102', 80, 0), t('4101', 0, 1000)], (a) => a.accountType === 'REVENUE');
    expect(tree.rows.map((r) => [r.code, r.depth, r.isGroup, r.amount])).toEqual([
      ['4', 0, true, '970.000'],
      ['4101', 1, false, '1000.000'],
      ['4102', 1, false, '-80.000'],
      ['42', 1, true, '50.000'],
      ['4201', 2, false, '50.000'],
    ]);
    expect(tree.total.toString()).toBe('970');
  });

  it('leaves out accounts without lines and groups without kept accounts', () => {
    const tree = accountTree(chart, [t('5202', 10, 0), t('5101', 99, 0)], (a) => a.accountType === 'EXPENSE' && a.code !== '5101');
    expect(tree.rows.map((r) => r.code)).toEqual(['5', '52', '5202']);
    expect(tree.total.toString()).toBe('10');
  });

  it('shows an account whose lines net to zero', () => {
    const tree = accountTree(chart, [t('1101', 5, 5)], (a) => a.accountType === 'ASSET');
    expect(tree.rows.map((r) => [r.code, r.amount])).toEqual([
      ['1', '0.000'],
      ['11', '0.000'],
      ['1101', '0.000'],
    ]);
  });
});

describe('incomeStatement', () => {
  const totals = [
    t('4101', 0, 730),
    t('4102', 100, 0),
    t('5101', 300, 40),
    t('5102', 10, 0),
    t('5202', 300, 0),
    t('1104', 500, 0), // balance-sheet accounts never count
  ];
  const mapped = { cogs: byCode['5101'].id, inventoryAdjustment: byCode['5102'].id };

  it('revenue Cr − Dr with contra accounts negative, cost of sales = COGS + adjustments, net = Σ (Cr − Dr)', () => {
    const is = incomeStatement(chart, totals, mapped);
    expect(is.revenue.total).toBe('630.000');
    expect(is.revenue.rows.find((r) => r.code === '4102')!.amount).toBe('-100.000');
    expect(is.costOfSales.rows.map((r) => [r.kind, r.code, r.amount])).toEqual([
      ['COGS', '5101', '260.000'],
      ['INVENTORY_ADJUSTMENT', '5102', '10.000'],
    ]);
    expect(is.costOfSales.total).toBe('270.000');
    expect(is.grossProfit).toBe('360.000');
    expect(is.expenses.rows.map((r) => r.code)).toEqual(['5', '52', '5202']); // cost-of-sales accounts not repeated
    expect(is.expenses.total).toBe('300.000');
    expect(is.netProfit).toBe('60.000');
    expect(new Decimal(is.grossProfit).minus(is.expenses.total).toFixed(3)).toBe(is.netProfit);
  });

  it('keeps the cost lines (at zero) without movement, and drops a mapping to a non-expense account', () => {
    const is = incomeStatement(chart, [t('4101', 0, 10)], { cogs: byCode['5101'].id, inventoryAdjustment: byCode['1104'].id });
    expect(is.costOfSales.rows.map((r) => [r.code, r.amount])).toEqual([['5101', '0.000']]);
    expect([is.grossProfit, is.netProfit]).toEqual(['10.000', '10.000']);
  });
});

describe('balanceSheet', () => {
  it('assets = liabilities + equity + prior years + year profit', () => {
    // Prior year: sold 200 at cost 100. This year: sold 730 − 100 returns, cost 270, rent 300.
    const prior = [t('1101', 200, 0), t('1104', 1000, 100), t('2101', 0, 1000), t('4101', 0, 200), t('5101', 100, 0)];
    const year = [t('1101', 630, 300), t('1104', 0, 270), t('4101', 0, 730), t('4102', 100, 0), t('5101', 260, 0), t('5102', 10, 0), t('5202', 300, 0)];
    const opening = [t('1101', 5000, 0), t('3103', 0, 5000)];
    const sum = (...lists: AccountTotal[][]) => {
      const m = new Map<string, AccountTotal>();
      for (const x of lists.flat()) {
        const prev = m.get(x.account.code);
        m.set(x.account.code, prev ? { ...x, debit: prev.debit.plus(x.debit), credit: prev.credit.plus(x.credit) } : x);
      }
      return [...m.values()];
    };
    const bs = balanceSheet(chart, sum(opening, prior, year), sum(opening, prior), year);
    expect(bs.assets.total).toBe('6160.000'); // cash 5530 + inventory 630
    expect(bs.liabilities.total).toBe('1000.000');
    expect(bs.equity.total).toBe('5000.000');
    expect(bs.priorYears).toBe('100.000');
    expect(bs.yearProfit).toBe('60.000');
    expect(bs.totalLiabilitiesAndEquity).toBe('6160.000');
    expect([bs.balanced, bs.difference]).toEqual([true, '0.000']);
  });

  it('reports the difference when the books do not balance', () => {
    const bs = balanceSheet(chart, [t('1101', 10, 0)], [], []);
    expect([bs.balanced, bs.difference]).toEqual([false, '10.000']);
  });
});
