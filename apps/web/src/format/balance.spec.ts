import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { balanceView, drCrColumns, netBalance } from './balance';

describe('balanceView (credit balance display)', () => {
  it('shows a debit balance plain, on the right side for a debit account', () => {
    expect(balanceView('1250.5', 'DEBIT')).toEqual({ amount: '1,250.500', side: 'DR', wrongSide: false });
  });

  it('shows a credit balance without a minus sign, not red, for a credit account', () => {
    // The review's case: liabilities −520.000 shown in red.
    expect(balanceView('-520', 'CREDIT')).toEqual({ amount: '520.000', side: 'CR', wrongSide: false });
  });

  it('flags only a balance on the wrong side of the account nature', () => {
    expect(balanceView('-50', 'DEBIT').wrongSide).toBe(true); // cash in credit
    expect(balanceView('75', 'CREDIT').wrongSide).toBe(true); // supplier in debit
  });

  it('never flags without a nature, and treats zero (and sub-fils residue) as no side', () => {
    expect(balanceView('-50').wrongSide).toBe(false);
    expect(balanceView('0', 'DEBIT')).toEqual({ amount: '0.000', side: null, wrongSide: false });
    expect(balanceView('-0.0004', 'DEBIT')).toEqual({ amount: '0.000', side: null, wrongSide: false });
  });

  it('rounds half up to 3 decimals before formatting', () => {
    expect(balanceView('-0.0005').amount).toBe('0.001');
    expect(balanceView(new Decimal('1234567.8915')).amount).toBe('1,234,567.892');
  });
});

describe('netBalance and drCrColumns (trial balance columns)', () => {
  it('nets debit minus credit with decimals, never floats', () => {
    expect(netBalance('0.1', '0.3').toString()).toBe('-0.2');
  });

  it('puts the amount in exactly one column', () => {
    expect(drCrColumns('120.5')).toEqual({ debit: new Decimal('120.5'), credit: null });
    expect(drCrColumns('-120.5')).toEqual({ debit: null, credit: new Decimal('120.5') });
    expect(drCrColumns('0')).toEqual({ debit: null, credit: null });
  });
});
