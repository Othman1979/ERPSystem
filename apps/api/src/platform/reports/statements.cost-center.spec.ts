import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { AccountTypeCode, ChartAccount } from '../journal/reports.service.js';
import { incomeStatementByCostCenter, profitOf } from './statements.js';

function acct(id: bigint, code: string, type: AccountTypeCode): ChartAccount {
  return {
    id,
    code,
    nameAr: `ح ${code}`,
    nameEn: null,
    parentId: null,
    accountType: type,
    normalBalance: type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    isPostable: true,
  };
}
const sales = acct(1n, '4101', 'REVENUE');
const returns = acct(2n, '4102', 'REVENUE');
const cogs = acct(3n, '5101', 'EXPENSE');
const rent = acct(4n, '5202', 'EXPENSE');

const line = (account: ChartAccount, costCenterId: bigint | null, debit: string, credit: string) => ({
  account,
  costCenterId,
  debit: new Decimal(debit),
  credit: new Decimal(credit),
});

const centres = [
  { id: 20n, code: 'CC2', nameAr: 'فرع الشمال', nameEn: 'North' },
  { id: 10n, code: 'CC1', nameAr: 'المركز الرئيسي', nameEn: 'Head office' },
  { id: 30n, code: 'CC3', nameAr: 'بلا حركة', nameEn: null },
];

describe('incomeStatementByCostCenter (ADR-024 §1.9)', () => {
  const totals = [
    line(sales, 10n, '0', '1000.000'),
    line(sales, 20n, '0', '400.000'),
    line(sales, null, '0', '100.000'),
    line(returns, 10n, '50.000', '0'),
    line(cogs, 10n, '600.000', '0'),
    line(cogs, 20n, '250.000', '0'),
    line(rent, null, '300.000', '0'),
    line(rent, 20n, '120.500', '20.500'),
  ];
  const r = incomeStatementByCostCenter(totals, centres);

  it('has a column per centre with lines, by code, and "no centre" last', () => {
    expect(r.columns.map((c) => c.costCenterId)).toEqual(['10', '20', null]);
    expect(r.columns[0]).toMatchObject({ code: 'CC1', nameEn: 'Head office' });
  });

  it('signs revenue Cr − Dr and expenses Dr − Cr, per column', () => {
    expect(r.revenue.rows.map((x) => [x.code, x.amounts, x.total])).toEqual([
      ['4101', ['1000.000', '400.000', '100.000'], '1500.000'],
      ['4102', ['-50.000', '0.000', '0.000'], '-50.000'],
    ]);
    expect(r.expenses.rows.map((x) => [x.code, x.amounts, x.total])).toEqual([
      ['5101', ['600.000', '250.000', '0.000'], '850.000'],
      ['5202', ['0.000', '100.000', '300.000'], '400.000'],
    ]);
    expect(r.revenue.totals).toEqual(['950.000', '400.000', '100.000']);
    expect(r.expenses.totals).toEqual(['600.000', '350.000', '300.000']);
  });

  it('the columns add up to the net profit of the same lines', () => {
    expect(r.netProfit.amounts).toEqual(['350.000', '50.000', '-200.000']);
    expect(r.netProfit.total).toBe('200.000');
    expect(r.netProfit.total).toBe(profitOf(totals).toFixed(3));
    const sum = r.netProfit.amounts.reduce((s, a) => s.plus(a), new Decimal(0));
    expect(sum.toFixed(3)).toBe(r.netProfit.total);
  });

  it('keeps a column for a centre id the list does not know (an orphan)', () => {
    const o = incomeStatementByCostCenter([line(sales, 99n, '0', '5.000')], centres);
    expect(o.columns).toEqual([
      { costCenterId: '99', code: '99', nameAr: null, nameEn: null },
      { costCenterId: null, code: null, nameAr: null, nameEn: null },
    ]);
    expect(o.netProfit).toEqual({ amounts: ['5.000', '0.000'], total: '5.000' });
  });

  it('with no lines: only the "no centre" column, all zero', () => {
    const e = incomeStatementByCostCenter([], centres);
    expect(e.columns).toHaveLength(1);
    expect(e.netProfit).toEqual({ amounts: ['0.000'], total: '0.000' });
  });
});
