import { describe, expect, it } from 'vitest';
import { openingPlug } from './openingPlug';

describe('opening entry plug preview', () => {
  it('credits equity with the excess of debits', () => {
    const p = openingPlug([{ debit: '1500' }, { debit: '25000.5' }, { credit: '10000' }]);
    expect(p.totalDebit.toFixed(3)).toBe('26500.500');
    expect(p.totalCredit.toFixed(3)).toBe('10000.000');
    expect(p.side).toBe('CREDIT');
    expect(p.amount.toFixed(3)).toBe('16500.500');
  });

  it('debits equity with the excess of credits', () => {
    const p = openingPlug([{ debit: '100' }, { credit: '250.125' }]);
    expect(p.side).toBe('DEBIT');
    expect(p.amount.toFixed(3)).toBe('150.125');
  });

  it('adds no line when the entry already balances', () => {
    const p = openingPlug([{ debit: '0.1' }, { debit: '0.2' }, { credit: '0.3' }]);
    expect(p.side).toBeNull();
    expect(p.amount.isZero()).toBe(true);
  });

  it('ignores blank cells', () => {
    const p = openingPlug([{ debit: null, credit: undefined }, {}, { debit: '' }]);
    expect(p.side).toBeNull();
    expect(p.totalDebit.isZero()).toBe(true);
  });
});
