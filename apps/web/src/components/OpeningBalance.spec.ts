import { describe, expect, it } from 'vitest';
import { sameSides, sideValue, toSides } from './OpeningBalance';

describe('opening balance form values', () => {
  it('sends only positive sides, as plain decimals', () => {
    expect(toSides({ debit: '1000.000', credit: '' })).toEqual({ debit: '1000', credit: undefined });
    expect(toSides({ debit: '0', credit: '25.5' })).toEqual({ debit: undefined, credit: '25.5' });
    expect(toSides(undefined)).toEqual({ debit: undefined, credit: undefined });
  });

  it('compares balances by amount and side', () => {
    expect(sameSides({ debit: '50' }, { debit: '50.000', credit: '0' })).toBe(true);
    expect(sameSides({}, { debit: '0', credit: '0' })).toBe(true);
    expect(sameSides({ credit: '50' }, { debit: '50', credit: '0' })).toBe(false);
    expect(sameSides({ debit: '50.001' }, { debit: '50', credit: '0' })).toBe(false);
  });

  it('shows zero as an empty field', () => {
    expect(sideValue('0')).toBeUndefined();
    expect(sideValue('0.000')).toBeUndefined();
    expect(sideValue('12.500')).toBe('12.5');
    expect(sideValue(null)).toBeUndefined();
  });
});
