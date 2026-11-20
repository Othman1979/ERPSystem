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
  employee: { hireDate: new Date('2025-01-01'), leaveDate: null, sscCovered: true, sscHazardous: false },
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
  },
  inputs: [],
  recurring: [],
};

describe('calculatePayroll', () => {
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
