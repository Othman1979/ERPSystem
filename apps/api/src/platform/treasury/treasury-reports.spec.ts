import { agingBucket, daysOverdue, todayUtc } from './treasury-reports.service.js';

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
