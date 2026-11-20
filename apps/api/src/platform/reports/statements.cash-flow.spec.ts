import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { AccountTotal, AccountTypeCode, ChartAccount } from '../journal/reports.service.js';
import { cashBalance, cashFlow, cashFlowActivityOf } from './statements.js';

let nextId = 1n;
function acct(code: string, accountType: AccountTypeCode, extra: Partial<ChartAccount> = {}): ChartAccount {
  return {
    id: nextId++,
    code,
    nameAr: `ح ${code}`,
    nameEn: null,
    parentId: null,
    accountType,
    normalBalance: accountType === 'ASSET' || accountType === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    isPostable: true,
    controlType: null,
    cashFlowActivity: null,
    ...extra,
  };
}
const total = (account: ChartAccount, debit: string, credit: string): AccountTotal => ({
  account,
  debit: new Decimal(debit),
  credit: new Decimal(credit),
});

const cash = acct('1101', 'ASSET', { controlType: 'CASH' });
const bank = acct('1102', 'ASSET', { controlType: 'BANK' });
const inputTax = acct('1105', 'ASSET');
const equipment = acct('1201', 'ASSET', { cashFlowActivity: 'INVESTING' });
const depreciation = acct('1202', 'ASSET');
const accrued = acct('2103', 'LIABILITY');
const capital = acct('3101', 'EQUITY');
const retained = acct('3102', 'EQUITY');
const sales = acct('4101', 'REVENUE');
const salaries = acct('5201', 'EXPENSE');
const rent = acct('5202', 'EXPENSE');
const admin = acct('5204', 'EXPENSE');

// Golden C1 (BUILD_PLAN §18) as period totals.
const C1: AccountTotal[] = [
  total(cash, '8000', '4460'),
  total(bank, '4000', '3700'),
  total(inputTax, '160', '0'),
  total(equipment, '2500', '0'),
  total(depreciation, '0', '250'),
  total(accrued, '0', '800'),
  total(capital, '0', '5000'),
  total(retained, '300', '0'),
  total(sales, '0', '3000'),
  total(salaries, '1200', '0'),
  total(rent, '800', '0'),
  total(admin, '250', '0'),
];

describe('cash flow statement (ADR-036)', () => {
  it('classifies accounts by type, control and explicit activity', () => {
    expect(cashFlowActivityOf(cash)).toBeNull();
    expect(cashFlowActivityOf(sales)).toBeNull();
    expect(cashFlowActivityOf(inputTax)).toBe('OPERATING');
    expect(cashFlowActivityOf(equipment)).toBe('INVESTING');
    expect(cashFlowActivityOf(capital)).toBe('FINANCING');
    expect(cashFlowActivityOf({ ...accrued, cashFlowActivity: 'FINANCING' })).toBe('FINANCING');
  });

  it('computes golden C1', () => {
    const r = cashFlow(C1, new Decimal(0), cashBalance(C1));
    expect(r).toMatchObject({
      netProfit: '750.000',
      operating: { total: '1640.000' },
      investing: { total: '-2500.000' },
      financing: { total: '4700.000' },
      netChange: '3840.000',
      openingCash: '0.000',
      closingCash: '3840.000',
      reconciles: true,
    });
    expect(r.operating.rows.map((x) => [x.code, x.amount])).toEqual([
      ['1105', '-160.000'],
      ['1202', '250.000'],
      ['2103', '800.000'],
    ]);
    expect(r.financing.rows.map((x) => [x.code, x.amount])).toEqual([
      ['3101', '5000.000'],
      ['3102', '-300.000'],
    ]);
  });

  it('moves a reclassified account between sections without changing the net change (C3)', () => {
    const reclassified = C1.map((t) => (t.account === accrued ? { ...t, account: { ...accrued, cashFlowActivity: 'FINANCING' as const } } : t));
    const r = cashFlow(reclassified, new Decimal(0), cashBalance(reclassified));
    expect([r.operating.total, r.financing.total, r.netChange]).toEqual(['840.000', '5500.000', '3840.000']);
  });

  it('flags a closing balance that does not follow from the opening one', () => {
    expect(cashFlow(C1, new Decimal(0), new Decimal('3839.999')).reconciles).toBe(false);
  });
});
