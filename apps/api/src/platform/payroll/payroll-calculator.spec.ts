import { Decimal } from '../../common/decimal/decimal.utils.js';
import { calculatePayroll, type PayrollElement } from './payroll-calculator.js';

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
