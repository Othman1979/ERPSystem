import {
  calculateEos,
  calculateEosTax,
  calculateLeaveEncashment,
  calculateProrationFactor,
  calculateServiceYears,
} from './settlement-calculator.js';

describe('settlement calculator', () => {
  it('prorates inclusive hire and leave dates and caps a full month at one', () => {
    expect(calculateProrationFactor({
      hireDate: new Date('2026-07-01Z'), leaveDate: null,
      periodStart: new Date('2026-07-01Z'), periodEnd: new Date('2026-07-31Z'), daysPerMonth: '30',
    }).toString()).toBe('1');
    expect(calculateProrationFactor({
      hireDate: new Date('2026-07-15Z'), leaveDate: new Date('2026-07-31Z'),
      periodStart: new Date('2026-07-01Z'), periodEnd: new Date('2026-07-31Z'), daysPerMonth: '30',
    }).toString()).toBe('0.566667');
  });

  it('splits EOS service days and calculates the EOS1 entitlement and tax', () => {
    const service = calculateServiceYears({
      hireDate: new Date('2008-01-01Z'), leaveDate: new Date('2026-12-31Z'), unpaidLeaveRanges: [],
    });
    expect([
      service.serviceYears.toString(), service.daysBefore2010, service.days2010To2014, service.daysFrom2015,
    ]).toEqual(['19', 731, 1826, 4383]);
    const eos = calculateEos('1100', service.serviceYears);
    const tax = calculateEosTax({
      eosAmount: eos,
      daysBefore2010: service.daysBefore2010,
      days2010To2014: service.days2010To2014,
      daysFrom2015: service.daysFrom2015,
      exemption: '15000', taxRate: '0.09', nationalThreshold: '200000', nationalRate: '0.01',
    });
    expect([eos.toString(), tax.taxableAmount.toString(), tax.eosTax.toString(), tax.nationalContribution.toString()])
      .toEqual(['20900', '2749.524', '247.457', '0']);
  });

  it('subtracts unpaid calendar days from the residual service year and computes EOS2', () => {
    const service = calculateServiceYears({
      hireDate: new Date('2020-03-01Z'), leaveDate: new Date('2026-08-31Z'),
      unpaidLeaveRanges: [{ startDate: new Date('2026-05-01Z'), endDate: new Date('2026-05-10Z') }],
    });
    expect(service.serviceYears.toString()).toBe('6.476712');
    expect(calculateEos('3000', service.serviceYears).toString()).toBe('19430.136');
  });

  it('encashes only positive unused days using a six-place daily wage', () => {
    expect(calculateLeaveEncashment({ unusedDays: '1.5', lastWage: '640', daysPerMonth: '30' }).toString())
      .toBe('32');
    expect(calculateLeaveEncashment({ unusedDays: '-1', lastWage: '640', daysPerMonth: '30' }).toString())
      .toBe('0');
  });
});
