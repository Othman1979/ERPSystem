import { describe, expect, it } from 'vitest';
import { countLabel, countsInOrder } from './consumptionRules';

describe('consumption report counts (ADR-032 §3)', () => {
  it('names a count by its number and its date', () => {
    expect(countLabel({ id: '9', docNo: 'CNT-0007', countDate: '2026-11-03T00:00:00.000Z' })).toBe('CNT-0007 · 2026-11-03');
    expect(countLabel({ id: '9', docNo: null, countDate: '2026-11-03' })).toBe('#9 · 2026-11-03');
  });

  it('accepts the first count earlier than or on the same day as the second', () => {
    expect(countsInOrder({ countDate: '2026-11-01' }, { countDate: '2026-11-03' })).toBe(true);
    expect(countsInOrder({ countDate: '2026-11-03' }, { countDate: '2026-11-03T10:00:00.000Z' })).toBe(true);
  });

  it('refuses a first count later than the second, and a missing count', () => {
    expect(countsInOrder({ countDate: '2026-11-05' }, { countDate: '2026-11-03' })).toBe(false);
    expect(countsInOrder(undefined, { countDate: '2026-11-03' })).toBe(false);
    expect(countsInOrder({ countDate: '2026-11-01' }, undefined)).toBe(false);
  });
});
