import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { computeLineAmounts, netOfTaxLine } from './invoice-math.js';

const s = (d: Decimal) => d.toString();

describe('computeLineAmounts', () => {
  it('prices net of tax: tax added on top (unchanged rule)', () => {
    const a = computeLineAmounts({ qty: '1', factorToBase: '1', unitPrice: '116', taxRate: '16' });
    expect([s(a.netAmount), s(a.taxAmount), s(a.lineTotal)]).toEqual(['116', '18.56', '134.56']);
  });

  it('prices including tax (ADR-017): net = round3(gross / (1 + rate)), tax = gross − net', () => {
    const a = computeLineAmounts({ qty: '1', factorToBase: '1', unitPrice: '116', taxRate: '16', pricesIncludeTax: true });
    expect([s(a.netAmount), s(a.taxAmount), s(a.lineTotal)]).toEqual(['100', '16', '116']);
    // Rounding: 3 × 9.990 = 29.970 → net 25.836 (25.8362…), tax 4.134; the total is what was typed.
    const b = computeLineAmounts({ qty: '3', factorToBase: '1', unitPrice: '9.990', taxRate: '16', pricesIncludeTax: true });
    expect([s(b.netAmount), s(b.taxAmount), s(b.lineTotal)]).toEqual(['25.836', '4.134', '29.97']);
  });

  it('prices including tax with a discount: the discounted gross is the line total', () => {
    const a = computeLineAmounts({
      qty: '2', factorToBase: '12', unitPrice: '58', discountPct: '10', taxRate: '16', pricesIncludeTax: true,
    });
    expect([s(a.qtyBase), s(a.discountAmount), s(a.lineTotal), s(a.netAmount), s(a.taxAmount)]).toEqual(['24', '11.6', '104.4', '90', '14.4']);
  });

  it('zero-rated lines are the same either way', () => {
    const a = computeLineAmounts({ qty: '2', factorToBase: '1', unitPrice: '5', taxRate: '0', pricesIncludeTax: true });
    expect([s(a.netAmount), s(a.taxAmount)]).toEqual(['10', '0']);
  });

  it('refuses a discount outside 0–100% (TRADE-23)', () => {
    expect(() => computeLineAmounts({ qty: '1', factorToBase: '1', unitPrice: '10', discountPct: '150' })).toThrow(/discountPct/);
    expect(() => computeLineAmounts({ qty: '1', factorToBase: '1', unitPrice: '10', discountPct: '100' })).not.toThrow();
  });
});

describe('netOfTaxLine (JoFotara, ADR-017)', () => {
  it('writes a tax-inclusive line so price × qty − discount = net exactly, discount ≥ 0', () => {
    for (const [qty, price, rate] of [['3', '9.990', '16'], ['7', '1.150', '16'], ['1', '116', '16'], ['12', '0.333', '4']]) {
      const a = computeLineAmounts({ qty, factorToBase: '1', unitPrice: price, taxRate: rate, pricesIncludeTax: true });
      const l = netOfTaxLine({ quantity: qty, discountAmount: a.discountAmount, netAmount: a.netAmount, taxRate: rate });
      expect(l.discount.gte(0)).toBe(true);
      expect(s(round3(new Decimal(qty).times(l.unitPrice)).minus(l.discount))).toBe(s(a.netAmount));
    }
  });
});
