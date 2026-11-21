import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';

export type LeaveCountBasis = 'WORKING_DAYS' | 'CALENDAR_DAYS';

function utcDate(value: Date | string): Date {
  const text = typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
  const [year, month, day] = text.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dateText(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysBetweenInclusive(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

function addYears(value: Date, years: number): Date {
  return new Date(Date.UTC(value.getUTCFullYear() + years, value.getUTCMonth(), value.getUTCDate()));
}

export function countLeaveDays(input: {
  startDate: Date | string;
  endDate: Date | string;
  countBasis: LeaveCountBasis;
  weeklyRestDays: readonly number[];
  holidays: readonly (Date | string)[];
}): { days: Decimal; calendarDays: number } {
  const start = utcDate(input.startDate);
  const end = utcDate(input.endDate);
  if (end < start) throw new RangeError('Leave end date precedes start date');
  const calendarDays = daysBetweenInclusive(start, end);
  if (input.countBasis === 'CALENDAR_DAYS') return { days: new Decimal(calendarDays), calendarDays };

  const restDays = new Set(input.weeklyRestDays);
  const holidayDates = new Set(input.holidays.map((holiday) => dateText(utcDate(holiday))));
  let days = 0;
  for (let index = 0; index < calendarDays; index++) {
    const day = new Date(start.getTime() + index * 86_400_000);
    if (!restDays.has(day.getUTCDay()) && !holidayDates.has(dateText(day))) days++;
  }
  return { days: new Decimal(days), calendarDays };
}

export function annualLeaveEntitlement(input: {
  year: number;
  hireDate: Date | string;
  leaveDate?: Date | string | null;
  annualLeaveDays: Decimal.Value;
  annualLeaveDaysSenior: Decimal.Value;
  annualLeaveSeniorYears: number;
  asOfDate?: Date | string;
  adjustments?: Decimal.Value;
}): Decimal {
  const yearStart = new Date(Date.UTC(input.year, 0, 1));
  const yearEnd = new Date(Date.UTC(input.year, 11, 31));
  const hireDate = utcDate(input.hireDate);
  const serviceStart = hireDate > yearStart ? hireDate : yearStart;
  let serviceEnd = yearEnd;
  if (input.leaveDate) {
    const leaveDate = utcDate(input.leaveDate);
    if (leaveDate < serviceEnd) serviceEnd = leaveDate;
  }
  if (input.asOfDate) {
    const asOfDate = utcDate(input.asOfDate);
    if (asOfDate < serviceEnd) serviceEnd = asOfDate;
  }
  if (serviceStart > serviceEnd) return new Decimal(input.adjustments ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

  const serviceAnniversary = addYears(hireDate, input.annualLeaveSeniorYears);
  const daysInYear = new Decimal(new Date(Date.UTC(input.year + 1, 0, 1)).getTime() - yearStart.getTime())
    .div(86_400_000);
  let entitlement = new Decimal(0);
  const serviceDays = daysBetweenInclusive(serviceStart, serviceEnd);
  for (let index = 0; index < serviceDays; index++) {
    const day = new Date(serviceStart.getTime() + index * 86_400_000);
    const rate = day >= serviceAnniversary ? input.annualLeaveDaysSenior : input.annualLeaveDays;
    entitlement = entitlement.plus(new Decimal(rate).div(daysInYear));
  }
  return entitlement.plus(input.adjustments ?? 0).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function carryIntoYear(input: {
  year: number;
  startYear: number;
  entitlements: ReadonlyMap<number, Decimal.Value>;
  taken: ReadonlyMap<number, Decimal.Value>;
}): Decimal {
  let carry = new Decimal(0);
  for (let year = input.startYear; year < input.year; year++) {
    const entitlement = new Decimal(input.entitlements.get(year) ?? 0);
    const taken = new Decimal(input.taken.get(year) ?? 0);
    carry = Decimal.max(entitlement.minus(Decimal.max(taken.minus(carry), 0)), 0);
  }
  return carry.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function availableLeaveBalance(input: {
  carryInto: Decimal.Value;
  entitlement: Decimal.Value;
  adjustments?: Decimal.Value;
  taken: Decimal.Value;
}): Decimal {
  return new Decimal(input.carryInto)
    .plus(input.entitlement)
    .plus(input.adjustments ?? 0)
    .minus(input.taken)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function leavePeriodQuantity(input: {
  requestStart: Date | string;
  requestEnd: Date | string;
  periodStart: Date | string;
  periodEnd: Date | string;
  countBasis: LeaveCountBasis;
  weeklyRestDays: readonly number[];
  holidays: readonly (Date | string)[];
  daysPerMonth: Decimal.Value;
}): Decimal {
  const requestStart = utcDate(input.requestStart);
  const requestEnd = utcDate(input.requestEnd);
  const periodStart = utcDate(input.periodStart);
  const periodEnd = utcDate(input.periodEnd);
  if (requestStart <= periodStart && requestEnd >= periodEnd) return new Decimal(input.daysPerMonth);
  const start = requestStart > periodStart ? requestStart : periodStart;
  const end = requestEnd < periodEnd ? requestEnd : periodEnd;
  if (end < start) return new Decimal(0);
  const counted = countLeaveDays({
    startDate: start,
    endDate: end,
    countBasis: input.countBasis,
    weeklyRestDays: input.weeklyRestDays,
    holidays: input.holidays,
  }).days;
  return Decimal.min(counted, input.daysPerMonth);
}

export function leaveProvision(input: {
  unusedDays: Decimal.Value;
  basic: Decimal.Value;
  fixedAllowances: readonly Decimal.Value[];
  daysPerMonth: Decimal.Value;
}): Decimal {
  const wage = input.fixedAllowances.reduce<Decimal>(
    (sum, amount) => sum.plus(amount),
    new Decimal(input.basic),
  );
  const dailyWage = round6(wage.div(input.daysPerMonth));
  return round3(Decimal.max(new Decimal(input.unusedDays), 0).mul(dailyWage));
}
