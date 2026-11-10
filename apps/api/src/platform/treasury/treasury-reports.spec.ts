import { Decimal } from '../../common/decimal/decimal.utils.js';
import { ageResidual, agingBucket, daysOverdue, todayUtc } from './treasury-reports.service.js';

describe('ageResidual', () => {
  const asOf = new Date('2025-03-01');
  const items = [
    { entryDate: new Date('2025-01-01'), amount: new Decimal('200') }, // 59 days
    { entryDate: new Date('2025-02-20'), amount: new Decimal('40') }, // 9 days
  ];
  const nonZero = (b: Record<string, Decimal>) =>
    Object.fromEntries(Object.entries(b).filter(([, v]) => !v.isZero()).map(([k, v]) => [k, v.toFixed(3)]));

  it('ages a positive residual newest item first', () => {
    const r = ageResidual(new Decimal('90'), items, asOf);
    expect(nonZero(r.buckets)).toEqual({ d1_30: '40.000', d31_60: '50.000' });
    expect(r.unapplied.toFixed(3)).toBe('0.000');
  });

  it('reports what the items cannot cover as unapplied', () => {
    const r = ageResidual(new Decimal('300'), items, asOf);
    expect(nonZero(r.buckets)).toEqual({ d1_30: '40.000', d31_60: '200.000' });
    expect(r.unapplied.toFixed(3)).toBe('60.000');
  });

  it('leaves a zero or negative residual unaged', () => {
    expect(nonZero(ageResidual(new Decimal('0'), items, asOf).buckets)).toEqual({});
    const r = ageResidual(new Decimal('-42'), items, asOf);
    expect(nonZero(r.buckets)).toEqual({});
    expect(r.unapplied.toFixed(3)).toBe('-42.000');
  });
});

describe('aging buckets', () => {
  it.each([
    [-5, 'notDue'],
    [0, 'notDue'],
    [1, 'd1_30'],
    [30, 'd1_30'],
    [31, 'd31_60'],
    [60, 'd31_60'],
    [61, 'd61_90'],
    [90, 'd61_90'],
    [91, 'd90plus'],
  ] as const)('%i days past due → %s', (days, bucket) => {
    expect(agingBucket(days)).toBe(bucket);
  });

  it('counts calendar days, ignoring the time of day', () => {
    expect(daysOverdue(new Date('2025-02-09'), new Date('2025-02-20'))).toBe(11);
    expect(daysOverdue(new Date('2025-02-09'), new Date('2025-02-09T23:59:59Z'))).toBe(0);
    expect(daysOverdue(new Date('2025-02-28'), new Date('2025-03-01'))).toBe(1);
  });

  it('today is the UTC calendar date at midnight', () => {
    expect(todayUtc(new Date('2025-06-30T22:15:00Z')).toISOString()).toBe('2025-06-30T00:00:00.000Z');
  });
});
