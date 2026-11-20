import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';

export interface PayrollElement {
  id: bigint;
  code: string;
  nameAr: string;
  nameEn: string | null;
  kind: 'EARNING' | 'DEDUCTION';
  amountType: 'FIXED' | 'PER_HOUR' | 'PER_DAY';
  rateFactor: Decimal.Value;
  sscSubject: boolean;
}

export interface PayrollElementEntry {
  element: PayrollElement;
  amount: Decimal.Value | null;
  quantity: Decimal.Value | null;
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
}

export interface PayrollCalculation {
  basic: Decimal;
  earnings: Decimal;
  gross: Decimal;
  sscBase: Decimal;
  sscEmployee: Decimal;
  sscEmployer: Decimal;
  incomeTax: Decimal;
  deductions: Decimal;
  net: Decimal;
  items: PayrollCalculatedItem[];
}

type ElementAccumulator = {
  element: PayrollElement;
  amount: Decimal;
  quantity: Decimal;
};

export function calculatePayroll(input: PayrollCalculationInput): PayrollCalculation | null {
  if (input.employee.hireDate > input.periodEnd || (input.employee.leaveDate && input.employee.leaveDate < input.periodStart)) {
    return null;
  }

  const basic = round3(input.salary);
  const hourlyRate = round6(basic.div(input.settings.hoursPerMonth));
  const dailyRate = round6(basic.div(input.settings.daysPerMonth));
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

  input.inputs.forEach(add);
  input.recurring
    .filter((entry) => entry.validFrom <= input.periodEnd && (!entry.validTo || entry.validTo >= input.periodStart))
    .forEach(add);

  let earnings = new Decimal(0);
  let deductions = new Decimal(0);
  let sscBase = basic;
  const items = [...grouped.values()].map(({ element, amount, quantity }) => {
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
  });

  earnings = round3(earnings);
  deductions = round3(deductions);
  const gross = round3(basic.plus(earnings));
  let sscEmployee = new Decimal(0);
  let sscEmployer = new Decimal(0);
  if (input.employee.sscCovered) {
    sscBase = Decimal.max(sscBase, new Decimal(input.settings.minimumWage));
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

  const incomeTax = round3(input.incomeTax ?? 0);
  const net = round3(gross.minus(sscEmployee).minus(incomeTax).minus(deductions));
  return {
    basic,
    earnings,
    gross,
    sscBase,
    sscEmployee,
    sscEmployer,
    incomeTax,
    deductions,
    net,
    items,
  };
}
