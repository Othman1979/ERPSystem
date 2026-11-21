import { Decimal, round3, round6 } from '../../common/decimal/decimal.utils.js';

const DAY_MS = 86_400_000;

function utcDate(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addDays(value: Date, days: number): Date {
  const result = utcDate(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function daysBetween(start: Date, endExclusive: Date): number {
  return Math.max(0, (utcDate(endExclusive).getTime() - utcDate(start).getTime()) / DAY_MS);
}

function overlapDays(start: Date, endExclusive: Date, rangeStart: Date, rangeEnd: Date): number {
  const clippedStart = new Date(Math.max(utcDate(start).getTime(), utcDate(rangeStart).getTime()));
  const clippedEnd = new Date(Math.min(utcDate(endExclusive).getTime(), utcDate(rangeEnd).getTime()));
  return daysBetween(clippedStart, clippedEnd);
}

function addAnniversaryYears(date: Date, years: number): Date {
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

export function calculateProrationFactor(input: {
  hireDate: Date;
  leaveDate: Date | null;
  periodStart: Date;
  periodEnd: Date;
  daysPerMonth: Decimal.Value;
}): Decimal {
  const activeStart = new Date(Math.max(utcDate(input.hireDate).getTime(), utcDate(input.periodStart).getTime()));
  const activeEndExclusive = new Date(Math.min(
    addDays(input.leaveDate ?? input.periodEnd, 1).getTime(),
    addDays(input.periodEnd, 1).getTime(),
  ));
  const activeDays = daysBetween(activeStart, activeEndExclusive);
  return round6(Decimal.min(new Decimal(activeDays).div(input.daysPerMonth), 1));
}

export function calculateServiceYears(input: {
  hireDate: Date;
  leaveDate: Date;
  unpaidLeaveRanges: Array<{ startDate: Date; endDate: Date }>;
}): { serviceYears: Decimal; daysBefore2010: number; days2010To2014: number; daysFrom2015: number } {
  const hireDate = utcDate(input.hireDate);
  const serviceEndExclusive = addDays(input.leaveDate, 1);
  let fullYears = 0;
  while (addAnniversaryYears(hireDate, fullYears + 1) <= serviceEndExclusive) fullYears++;
  const anniversary = addAnniversaryYears(hireDate, fullYears);
  const remainingDays = daysBetween(anniversary, serviceEndExclusive);
  const unpaidDays = input.unpaidLeaveRanges.reduce(
    (total, range) => total + overlapDays(
      range.startDate, addDays(range.endDate, 1), hireDate, serviceEndExclusive,
    ),
    0,
  );
  const serviceYears = round6(new Decimal(fullYears).plus(new Decimal(remainingDays - unpaidDays).div(365)));
  return {
    serviceYears,
    daysBefore2010: overlapDays(hireDate, serviceEndExclusive, new Date('0001-01-01Z'), new Date('2010-01-01Z')),
    days2010To2014: overlapDays(hireDate, serviceEndExclusive, new Date('2010-01-01Z'), new Date('2015-01-01Z')),
    daysFrom2015: overlapDays(hireDate, serviceEndExclusive, new Date('2015-01-01Z'), serviceEndExclusive),
  };
}

export function calculateEos(lastWage: Decimal.Value, serviceYears: Decimal.Value): Decimal {
  return round3(new Decimal(lastWage).mul(serviceYears));
}

export function calculateEosTax(input: {
  eosAmount: Decimal.Value;
  days2010To2014: number;
  daysFrom2015: number;
  daysBefore2010: number;
  exemption: Decimal.Value;
  taxRate: Decimal.Value;
  nationalThreshold: Decimal.Value;
  nationalRate: Decimal.Value;
}): { taxableAmount: Decimal; eosTax: Decimal; nationalContribution: Decimal } {
  const totalDays = input.daysBefore2010 + input.days2010To2014 + input.daysFrom2015;
  const eos = new Decimal(input.eosAmount);
  const taxableAmount = totalDays === 0
    ? new Decimal(0)
    : round3(
      eos.mul(input.days2010To2014).div(totalDays).mul('0.5')
        .plus(Decimal.max(eos.mul(input.daysFrom2015).div(totalDays).minus(input.exemption), 0)),
    );
  const nationalContribution = round3(
    Decimal.max(taxableAmount.minus(input.nationalThreshold), 0).mul(input.nationalRate),
  );
  return {
    taxableAmount,
    eosTax: round3(taxableAmount.mul(input.taxRate).plus(nationalContribution)),
    nationalContribution,
  };
}

export function calculateLeaveEncashment(input: {
  unusedDays: Decimal.Value;
  lastWage: Decimal.Value;
  daysPerMonth: Decimal.Value;
}): Decimal {
  const dailyWage = round6(new Decimal(input.lastWage).div(input.daysPerMonth));
  return round3(Decimal.max(input.unusedDays, 0).mul(dailyWage));
}
