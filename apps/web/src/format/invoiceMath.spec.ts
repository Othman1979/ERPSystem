import { describe, expect, it } from 'vitest';
import { lineAmounts } from './invoiceMath';

const str = (a: ReturnType<typeof lineAmounts>) => ({
  discount: a.discount.toFixed(3),
  net: a.net.toFixed(3),
  tax: a.tax.toFixed(3),
  total: a.total.toFixed(3),
});

describe('lineAmounts (mirrors the API invoice-math)', () => {
  it('computes net, 16% tax and total', () => {
    expect(str(lineAmounts({ qty: '3', price: '2.8', taxRate: '16' }))).toEqual({
      discount: '0.000',
      net: '8.400',
      tax: '1.344',
      total: '9.744',
    });
  });

  it('applies the discount before tax and rounds each step half up', () => {
    // gross 10 × 1.2345 = 12.345; discount 12.345 × 7.5% = 0.925875 → 0.926
    // net 11.419; tax 11.419 × 16% = 1.82704 → 1.827
    expect(
      str(lineAmounts({ qty: '10', price: '1.2345', discountPct: '7.5', taxRate: '16' })),
    ).toEqual({ discount: '0.926', net: '11.419', tax: '1.827', total: '13.246' });
  });

  it('treats blank inputs as zero', () => {
    expect(str(lineAmounts({ qty: null, price: undefined }))).toEqual({
      discount: '0.000',
      net: '0.000',
      tax: '0.000',
      total: '0.000',
    });
  });

  it('keeps 3-decimal precision that 2-decimal rounding lost', () => {
    // 1 × 0.0005 rounds to 0.001 (the old grid rounded the same line to 0.00)
    expect(lineAmounts({ qty: '1', price: '0.0005' }).total.toFixed(3)).toBe('0.001');
  });
});
