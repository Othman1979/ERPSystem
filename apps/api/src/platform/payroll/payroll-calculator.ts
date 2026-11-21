import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';
import { calculateProration } from './settlement-calculator.js';

export interface PayrollElement {
  id: bigint;
  code: string;
  nameAr: string;
  nameEn: string | null;
  kind: 'EARNING' | 'DEDUCTION';
  amountType: 'FIXED' | 'PER_HOUR' | 'PER_DAY';
  rateFactor: Decimal.Value;
  sscSubject: boolean;
  taxSubject: boolean;
  isFixedAllowance?: boolean;
}

export interface PayrollTaxBracket {
  upTo: Decimal.Value | null;
  rate: Decimal.Value;
}

export interface PayrollElementEntry {
  element: PayrollElement;
  amount: Decimal.Value | null;
  quantity: Decimal.Value | null;
  rate?: Decimal.Value | null;
  payrollMovementId?: bigint;
  leaveRequestId?: bigint;
}

export interface PayrollRecurringEntry extends PayrollElementEntry {
  validFrom: Date;
  validTo: Date | null;
}

export interface PayrollCalculationInput {
  employee: {
    hireDate: Date;
    leaveDate: Date | null;
    sscCovered: boolean;
    sscHazardous: boolean;
    taxSubject: boolean;
    taxDependants: boolean;
    taxOtherExemption: Decimal.Value;
  };
  salary: Decimal.Value;
  periodStart: Date;
  periodEnd: Date;
  settings: {
    employeeRate: Decimal.Value;
    employerRate: Decimal.Value;
    hazardousExtra: Decimal.Value;
    minimumWage: Decimal.Value;
    maximumWage: Decimal.Value | null;
    hoursPerMonth: Decimal.Value;
    daysPerMonth: Decimal.Value;
    taxPersonalExemption: Decimal.Value;
    taxDependantsExemption: Decimal.Value;
    taxNationalThreshold: Decimal.Value;
    taxNationalRate: Decimal.Value;
    taxBrackets: PayrollTaxBracket[];
  };
  inputs: PayrollElementEntry[];
  recurring: PayrollRecurringEntry[];
  incomeTax?: Decimal.Value;
}

export interface PayrollCalculatedItem {
  element: PayrollElement;
  quantity: Decimal | null;
  rate: Decimal | null;
  amount: Decimal;
  payrollMovementId?: bigint;
  leaveRequestId?: bigint;
}

export interface PayrollCalculation {
  basic: Decimal;
  earnings: Decimal;
  gross: Decimal;
  sscBase: Decimal;
  sscEmployee: Decimal;
  sscEmployer: Decimal;
  taxableIncome: Decimal;
  incomeTax: Decimal;
  nationalContribution: Decimal;
  deductions: Decimal;
  net: Decimal;
  items: PayrollCalculatedItem[];
}

type ElementAccumulator = {
  element: PayrollElement;
  amount: Decimal;
  quantity: Decimal;
};

export function latestEffectiveOnDate<T extends { effectiveFrom: Date }>(rows: readonly T[], date: Date): T | undefined {
  return rows.reduce<T | undefined>((latest, row) => {
    if (row.effectiveFrom > date) return latest;
    return !latest || row.effectiveFrom > latest.effectiveFrom ? row : latest;
  }, undefined);
}

export function calculateMovementPrice(input: {
  amountType: PayrollElement['amountType'];
  amount: Decimal.Value | null;
  quantity: Decimal.Value | null;
  salary: Decimal.Value;
  rateFactor: Decimal.Value;
  hoursPerMonth: Decimal.Value;
  daysPerMonth: Decimal.Value;
}) {
  if (input.amountType === 'FIXED') {
    return { quantity: null, rate: null, amount: round3(input.amount ?? 0) };
  }
  const units = input.amountType === 'PER_HOUR' ? input.hoursPerMonth : input.daysPerMonth;
  const baseRate = round6(new Decimal(input.salary).div(units));
  const rate = round6(baseRate.mul(input.rateFactor));
  const quantity = round6(input.quantity ?? 0);
  return { quantity, rate, amount: round3(quantity.mul(rate)) };
}

function bracketTax(excess: Decimal, brackets: PayrollTaxBracket[]): Decimal {
  let lower = new Decimal(0);
  let tax = new Decimal(0);
  for (const [index, bracket] of brackets.entries()) {
    const rate = new Decimal(bracket.rate);
    if (bracket.upTo === null) {
      tax = tax.plus(Decimal.max(excess.minus(lower), 0).mul(rate));
      break;
    }
    const upper = new Decimal(bracket.upTo);
    tax = tax.plus(Decimal.max(Decimal.min(excess, upper).minus(lower), 0).mul(rate));
    if (excess.lte(upper)) break;
    lower = upper;
    if (index === brackets.length - 1) tax = tax.plus(excess.minus(upper).mul(rate));
  }
  return tax;
}

export function calculatePayroll(input: PayrollCalculationInput): PayrollCalculation | null {
  if (input.employee.hireDate > input.periodEnd || (input.employee.leaveDate && input.employee.leaveDate < input.periodStart)) {
    return null;
  }

  const fullBasic = round3(input.salary);
  const proration = calculateProration({
    hireDate: input.employee.hireDate,
    leaveDate: input.employee.leaveDate,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    daysPerMonth: input.settings.daysPerMonth,
  });
  const activeDays = new Decimal(proration.activeDays);
  const daysPerMonth = new Decimal(input.settings.daysPerMonth);
  const prorate = (amount: Decimal) =>
    proration.fullPeriod || activeDays.gte(daysPerMonth)
      ? amount
      : round3(amount.mul(activeDays).div(daysPerMonth));
  const basic = prorate(fullBasic);
  const hourlyRate = round6(fullBasic.div(input.settings.hoursPerMonth));
  const dailyRate = round6(fullBasic.div(input.settings.daysPerMonth));
  const grouped = new Map<bigint, ElementAccumulator>();

  const add = (entry: PayrollElementEntry) => {
    const existing = grouped.get(entry.element.id) ?? {
      element: entry.element,
      amount: new Decimal(0),
      quantity: new Decimal(0),
    };
    if (entry.element.amountType === 'FIXED') {
      if (entry.amount === null) throw new Error(`Fixed pay element ${entry.element.code} requires an amount`);
      existing.amount = existing.amount.plus(round3(entry.amount));
    } else {
      if (entry.quantity === null) throw new Error(`Variable pay element ${entry.element.code} requires a quantity`);
      existing.quantity = existing.quantity.plus(round6(entry.quantity));
    }
    grouped.set(entry.element.id, existing);
  };

  input.inputs
    .filter((entry) => entry.payrollMovementId === undefined && entry.leaveRequestId === undefined)
    .forEach(add);
  input.recurring
    .filter((entry) => entry.validFrom <= input.periodEnd && (!entry.validTo || entry.validTo >= input.periodStart))
    .forEach((entry) => add({
      ...entry,
      amount: entry.element.isFixedAllowance && entry.amount !== null
        ? prorate(new Decimal(entry.amount))
        : entry.amount,
    }));

  let earnings = new Decimal(0);
  let deductions = new Decimal(0);
  let sscBase = basic;
  const movementItems = input.inputs
    .filter((entry) => entry.payrollMovementId !== undefined)
    .map((entry): PayrollCalculatedItem => {
      if (entry.amount === null) throw new Error(`Payroll movement ${entry.payrollMovementId} requires a fixed amount`);
      const amount = round3(entry.amount);
      if (entry.element.kind === 'EARNING') {
        earnings = earnings.plus(amount);
        if (entry.element.sscSubject) sscBase = sscBase.plus(amount);
      } else {
        deductions = deductions.plus(amount);
        if (entry.element.sscSubject) sscBase = sscBase.minus(amount);
      }
      return {
        element: entry.element,
        quantity: entry.quantity === null ? null : round6(entry.quantity),
        rate: entry.rate == null ? null : round6(entry.rate),
        amount,
        payrollMovementId: entry.payrollMovementId,
      };
    });
  const leaveItems = input.inputs
    .filter((entry) => entry.leaveRequestId !== undefined)
    .map((entry): PayrollCalculatedItem => {
      const quantity = round6(entry.quantity ?? 0);
      const rate = dailyRate;
      const amount = round3(quantity.mul(rate).mul(entry.element.rateFactor));
      if (entry.element.kind === 'EARNING') {
        earnings = earnings.plus(amount);
        if (entry.element.sscSubject) sscBase = sscBase.plus(amount);
      } else {
        deductions = deductions.plus(amount);
        if (entry.element.sscSubject) sscBase = sscBase.minus(amount);
      }
      return { element: entry.element, quantity, rate, amount, leaveRequestId: entry.leaveRequestId };
    });
  const items = [...movementItems, ...leaveItems, ...[...grouped.values()].map(({ element, amount, quantity }) => {
    const rate =
      element.amountType === 'PER_HOUR' ? hourlyRate : element.amountType === 'PER_DAY' ? dailyRate : null;
    const calculatedAmount =
      element.amountType === 'FIXED'
        ? round3(amount)
        : round3(quantity.mul(rate ?? 0).mul(element.rateFactor));

    if (element.kind === 'EARNING') {
      earnings = earnings.plus(calculatedAmount);
      if (element.sscSubject) sscBase = sscBase.plus(calculatedAmount);
    } else {
      deductions = deductions.plus(calculatedAmount);
      if (element.sscSubject) sscBase = sscBase.minus(calculatedAmount);
    }

    return {
      element,
      quantity: element.amountType === 'FIXED' ? null : round6(quantity),
      rate,
      amount: calculatedAmount,
    };
  })];

  const taxableBase = items.reduce((base, item) => {
    if (!item.element.taxSubject) return base;
    return item.element.kind === 'EARNING' ? base.plus(item.amount) : base.minus(item.amount);
  }, basic);
  const taxableIncome = round3(taxableBase);
  const monthlyExemption = round3(
    new Decimal(input.settings.taxPersonalExemption)
      .plus(input.employee.taxDependants ? input.settings.taxDependantsExemption : 0)
      .plus(input.employee.taxOtherExemption)
      .div(12),
  );
  const excess = Decimal.max(taxableIncome.minus(monthlyExemption), 0);
  const subjectToTax = input.employee.taxSubject;
  const national = subjectToTax
    ? Decimal.max(excess.minus(input.settings.taxNationalThreshold), 0).mul(input.settings.taxNationalRate)
    : new Decimal(0);
  const nationalContribution = round3(national);
  const automaticIncomeTax = subjectToTax
    ? round3(bracketTax(excess, input.settings.taxBrackets).plus(national))
    : new Decimal(0);

  earnings = round3(earnings);
  deductions = round3(deductions);
  const gross = round3(basic.plus(earnings));
  let sscEmployee = new Decimal(0);
  let sscEmployer = new Decimal(0);
  if (input.employee.sscCovered) {
    if (sscBase.gt(0)) sscBase = Decimal.max(sscBase, new Decimal(input.settings.minimumWage));
    if (input.settings.maximumWage !== null) sscBase = Decimal.min(sscBase, new Decimal(input.settings.maximumWage));
    sscBase = round3(sscBase);
    sscEmployee = round3(sscBase.mul(input.settings.employeeRate));
    const employerRate = new Decimal(input.settings.employerRate).plus(
      input.employee.sscHazardous ? input.settings.hazardousExtra : 0,
    );
    sscEmployer = round3(sscBase.mul(employerRate));
  } else {
    sscBase = new Decimal(0);
  }

  const incomeTax = round3(input.incomeTax ?? automaticIncomeTax);
  const net = round3(gross.minus(sscEmployee).minus(incomeTax).minus(deductions));
  return {
    basic,
    earnings,
    gross,
    sscBase,
    sscEmployee,
    sscEmployer,
    taxableIncome,
    incomeTax,
    nationalContribution,
    deductions,
    net,
    items,
  };
}
