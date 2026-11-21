import { Decimal } from '../../common/decimal/decimal.utils.js';
import {
  calculateMovementPrice,
  calculatePayroll,
  latestEffectiveOnDate,
  type PayrollElement,
} from './payroll-calculator.js';

const overtime: PayrollElement = {
  id: 1n,
  code: 'OT',
  nameAr: 'إضافي',
  nameEn: 'Overtime',
  kind: 'EARNING',
  amountType: 'PER_HOUR',
  rateFactor: '1.250000',
  sscSubject: true,
  taxSubject: true,
};

const daily: PayrollElement = {
  ...overtime,
  id: 2n,
  code: 'ABSENCE',
  kind: 'DEDUCTION',
  amountType: 'PER_DAY',
  rateFactor: '1.000000',
  sscSubject: false,
};
const holiday: PayrollElement = {
  ...overtime,
  id: 3n,
  code: 'HOLIDAY_OT',
  rateFactor: '1.500000',
};

const base = {
  employee: {
    hireDate: new Date('2025-01-01'), leaveDate: null, sscCovered: true, sscHazardous: false,
    taxSubject: true, taxDependants: false, taxOtherExemption: '0.000',
  },
  salary: '480.000',
  periodStart: new Date('2026-01-01'),
  periodEnd: new Date('2026-01-31'),
  settings: {
    employeeRate: '0.075000',
    employerRate: '0.142500',
    hazardousExtra: '0.010000',
    minimumWage: '290.000',
    maximumWage: null,
    hoursPerMonth: '240.00',
    daysPerMonth: '30.00',
    taxPersonalExemption: '9000.000',
    taxDependantsExemption: '9000.000',
    taxNationalThreshold: '16666.000',
    taxNationalRate: '0.010000',
    taxBrackets: [
      { upTo: '416.000', rate: '0.050000' },
      { upTo: '832.000', rate: '0.100000' },
      { upTo: '1248.000', rate: '0.150000' },
      { upTo: '1664.000', rate: '0.200000' },
      { upTo: '83333.000', rate: '0.250000' },
      { upTo: null, rate: '0.300000' },
    ],
  },
  inputs: [],
  recurring: [],
};

describe('calculatePayroll', () => {
  it('calculates taxable pay after exempting monthly personal and dependant exemptions', () => {
    const bonus = { ...overtime, id: 4n, code: 'BONUS', amountType: 'FIXED' as const };
    const absence = { ...daily, taxSubject: true };
    const result = calculatePayroll({
      ...base,
      salary: '2000.000',
      inputs: [
        { element: bonus, amount: '500.000', quantity: null },
        { element: absence, amount: '66.667', quantity: '1' },
      ],
    })!;
    expect(result.taxableIncome.toString()).toBe('2433.333');
    expect(result.incomeTax.toString()).toBe('212.833');
    expect(result.nationalContribution.toString()).toBe('0');
  });

  it('uses the dependant exemption and includes fixed recurring allowances in taxable pay', () => {
    const transport = { ...overtime, id: 5n, code: 'TRANSPORT', amountType: 'FIXED' as const };
    const result = calculatePayroll({
      ...base,
      salary: '1200.000',
      employee: { ...base.employee, taxDependants: true },
      recurring: [{
        element: transport,
        amount: '50.000',
        quantity: null,
        validFrom: new Date('2026-01-01'),
        validTo: null,
      }],
    })!;
    expect(result.taxableIncome.toString()).toBe('1250');
    expect(result.incomeTax.toString()).toBe('0');
  });

  it('calculates the national contribution and annual exemption adjustment with Decimal rounding', () => {
    const standard = calculatePayroll({ ...base, salary: '20000.000', employee: { ...base.employee, sscCovered: false } })!;
    const otherExemption = calculatePayroll({
      ...base,
      salary: '20000.000',
      employee: { ...base.employee, sscCovered: false, taxOtherExemption: '2000.000' },
    })!;
    expect([standard.incomeTax.toString(), standard.nationalContribution.toString()])
      .toEqual(['4630.34', '25.84']);
    expect([otherExemption.incomeTax.toString(), otherExemption.nationalContribution.toString()])
      .toEqual(['4587.007', '24.173']);
  });

  it('stores taxable income but applies no automatic tax when the employee is not subject', () => {
    const result = calculatePayroll({
      ...base,
      salary: '20000.000',
      employee: { ...base.employee, taxSubject: false },
    })!;
    expect(result.taxableIncome.toString()).toBe('20000');
    expect([result.incomeTax.toString(), result.nationalContribution.toString()]).toEqual(['0', '0']);
  });

  it('uses six-place hourly/daily rates and applies element factors', () => {
    const result = calculatePayroll({
      ...base,
      inputs: [
        { element: overtime, quantity: '10', amount: null },
        { element: daily, quantity: '2', amount: null },
        { element: holiday, quantity: '2', amount: null },
      ],
    })!;
    expect(result.items.map((item) => item.amount.toString())).toEqual(['25', '32', '6']);
    expect(result.items[0].rate?.toString()).toBe('2');
    expect(result.items[1].rate?.toString()).toBe('16');
  });

  it('clamps covered employees to minimum wage and adds hazardous employer rate', () => {
    const result = calculatePayroll({
      ...base,
      salary: '100.000',
      employee: { ...base.employee, sscHazardous: true },
    })!;
    expect(result.sscBase.toString()).toBe('290');
    expect(result.sscEmployee.toString()).toBe('21.75');
    expect(result.sscEmployer.toString()).toBe('44.225');
  });

  it('sets SSC to zero for employees not covered', () => {
    const result = calculatePayroll({
      ...base,
      employee: { ...base.employee, sscCovered: false },
    })!;
    expect(result.sscBase.toString()).toBe('0');
    expect(result.sscEmployee.toString()).toBe('0');
    expect(result.sscEmployer.toString()).toBe('0');
  });

  it('returns a negative net for the posting workflow to reject', () => {
    const result = calculatePayroll({ ...base, incomeTax: '500.000' })!;
    expect(result.net.eq(new Decimal('-56'))).toBe(true);
  });
});

describe('calculateMovementPrice', () => {
  const common = {
    salary: '500.000',
    rateFactor: '1.000000',
    hoursPerMonth: '240.00',
    daysPerMonth: '30.00',
  };

  it('prices hourly, daily, and fixed movements with decimal rounding', () => {
    expect(calculateMovementPrice({
      ...common, amountType: 'PER_HOUR', amount: null, quantity: '10', rateFactor: '1.250000',
    }).amount.toString()).toBe('26.042');
    expect(calculateMovementPrice({
      ...common, amountType: 'PER_DAY', amount: null, quantity: '2',
    }).amount.toString()).toBe('33.333');
    expect(calculateMovementPrice({
      ...common, amountType: 'FIXED', amount: '10.000', quantity: null,
    }).amount.toString()).toBe('10');
  });

  it('uses the latest salary and settings effective on the movement date', () => {
    const movementDate = new Date('2026-11-10T00:00:00.000Z');
    const salary = latestEffectiveOnDate([
      { effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), basicSalary: '400.000' },
      { effectiveFrom: new Date('2026-10-01T00:00:00.000Z'), basicSalary: '500.000' },
      { effectiveFrom: new Date('2026-12-01T00:00:00.000Z'), basicSalary: '600.000' },
    ], movementDate);
    const settings = latestEffectiveOnDate([
      { effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), hoursPerMonth: '200.00', daysPerMonth: '25.00' },
      { effectiveFrom: new Date('2026-11-01T00:00:00.000Z'), hoursPerMonth: '240.00', daysPerMonth: '30.00' },
      { effectiveFrom: new Date('2026-12-01T00:00:00.000Z'), hoursPerMonth: '300.00', daysPerMonth: '31.00' },
    ], movementDate);

    expect(calculateMovementPrice({
      amountType: 'PER_HOUR',
      amount: null,
      quantity: '10',
      salary: salary!.basicSalary,
      rateFactor: '1.250000',
      hoursPerMonth: settings!.hoursPerMonth,
      daysPerMonth: settings!.daysPerMonth,
    }).amount.toString()).toBe('26.042');
  });

  it('keeps movements as fixed amount line items in payroll calculations', () => {
    const result = calculatePayroll({
      ...base,
      inputs: [{
        element: overtime,
        amount: '26.042',
        quantity: '10',
        rate: '2.604166',
        payrollMovementId: 17n,
      }],
    })!;
    expect(result.items[0]).toMatchObject({
      payrollMovementId: 17n,
      amount: new Decimal('26.042'),
    });
    expect(result.sscBase.toString()).toBe('506.042');
  });
});
