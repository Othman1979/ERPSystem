import {
  annualLeaveEntitlement,
  availableLeaveBalance,
  carryIntoYear,
  countLeaveDays,
  leavePeriodQuantity,
  leaveProvision,
} from './leave-calculator.js';

describe('leave calculator', () => {
  it('counts working days after weekly rests and holidays, and counts calendar days unchanged', () => {
    const dates = {
      startDate: '2026-12-06',
      endDate: '2026-12-12',
      weeklyRestDays: [5],
      holidays: ['2026-12-08'],
    };
    const working = countLeaveDays({ ...dates, countBasis: 'WORKING_DAYS' });
    const calendar = countLeaveDays({ ...dates, countBasis: 'CALENDAR_DAYS' });
    expect([working.days.toString(), working.calendarDays]).toEqual(['5', 7]);
    expect(calendar.days.toString()).toBe('7');
  });

  it('accrues annual leave by service day and switches to the senior rate on the anniversary', () => {
    const firstYear = annualLeaveEntitlement({
      year: 2026, hireDate: '2026-07-01', annualLeaveDays: '14', annualLeaveDaysSenior: '21',
      annualLeaveSeniorYears: 5,
    });
    const seniorYear = annualLeaveEntitlement({
      year: 2026, hireDate: '2021-04-01', annualLeaveDays: '14', annualLeaveDaysSenior: '21',
      annualLeaveSeniorYears: 5,
    });
    const nextSeniorYear = annualLeaveEntitlement({
      year: 2027, hireDate: '2021-04-01', annualLeaveDays: '14', annualLeaveDaysSenior: '21',
      annualLeaveSeniorYears: 5,
    });
    expect([firstYear.toString(), seniorYear.toString(), nextSeniorYear.toString()])
      .toEqual(['7.06', '19.27', '21']);
  });

  it('uses accrued-to-date, carries only the previous year, and lapses older balances', () => {
    const accrued = annualLeaveEntitlement({
      year: 2027, hireDate: '2026-07-01', asOfDate: '2027-01-31',
      annualLeaveDays: '14', annualLeaveDaysSenior: '21', annualLeaveSeniorYears: 5,
    });
    const entitlements = new Map([[2026, '7.06'], [2027, '14.00'], [2028, '14.00']]);
    const taken = new Map([[2026, '2.00'], [2027, '3.00']]);
    const carry2027 = carryIntoYear({ year: 2027, startYear: 2026, entitlements, taken });
    const available2027 = availableLeaveBalance({
      carryInto: carry2027, entitlement: '14.00', taken: '0.00',
    });
    const carry2028 = carryIntoYear({ year: 2028, startYear: 2026, entitlements, taken });
    const available2028 = availableLeaveBalance({
      carryInto: carry2028, entitlement: '14.00', taken: '0.00',
    });
    expect([accrued.toString(), carry2027.toString(), available2027.toString(), carry2028.toString(), available2028.toString()])
      .toEqual(['1.19', '5.06', '19.06', '14', '28']);
  });

  it('uses period day counts, a full-period monthly cap, and the LV4 period quantities', () => {
    const common = {
      requestStart: '2026-11-15',
      requestEnd: '2027-01-23',
      weeklyRestDays: [5],
      holidays: [],
      daysPerMonth: '30',
    };
    const november = leavePeriodQuantity({
      ...common, periodStart: '2026-11-01', periodEnd: '2026-11-30', countBasis: 'CALENDAR_DAYS',
    });
    const december = leavePeriodQuantity({
      ...common, periodStart: '2026-12-01', periodEnd: '2026-12-31', countBasis: 'CALENDAR_DAYS',
    });
    const january = leavePeriodQuantity({
      ...common, periodStart: '2027-01-01', periodEnd: '2027-01-31', countBasis: 'CALENDAR_DAYS',
    });
    expect([november.toString(), december.toString(), january.toString()]).toEqual(['16', '30', '23']);
    expect(leavePeriodQuantity({
      ...common,
      requestStart: '2026-12-01',
      requestEnd: '2026-12-31',
      periodStart: '2026-12-01',
      periodEnd: '2026-12-31',
      countBasis: 'CALENDAR_DAYS',
    }).toString()).toBe('30');
  });

  it('rounds the daily wage to six places and provision to three', () => {
    const december = leaveProvision({
      unusedDays: '7.06', basic: '600', fixedAllowances: ['40'], daysPerMonth: '30',
    });
    const january = leaveProvision({
      unusedDays: '8.25', basic: '600', fixedAllowances: ['40'], daysPerMonth: '30',
    });
    expect([december.toString(), january.toString()]).toEqual(['150.613', '176']);
  });
});
