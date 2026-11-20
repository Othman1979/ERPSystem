import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { allocateInvoiceDiscount, computeLineAmounts, netOfTaxLine } from './invoice-math.js';

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

describe('allocateInvoiceDiscount', () => {
  it('puts the rounding remainder on the largest line, with ties going to the first line', () => {
    const allocation = allocateInvoiceDiscount(['1.000', '1.000', '2.000'], { amount: '0.002' });
    expect(allocation.amount.toFixed(3)).toBe('0.002');
    expect(allocation.shares.map((share) => share.toFixed(3))).toEqual(['0.001', '0.001', '0.000']);

    const tied = allocateInvoiceDiscount(['1.000', '1.000', '1.000'], { amount: '0.002' });
    expect(tied.shares.map((share) => share.toFixed(3))).toEqual(['0.000', '0.001', '0.001']);
  });

  it('allocates tax-inclusive shares using the price terms, then computes net and tax from the discounted total', () => {
    const weights = [
      computeLineAmounts({ qty: '1', factorToBase: '1', unitPrice: '116', taxRate: '16', pricesIncludeTax: true }).lineTotal,
      computeLineAmounts({
        qty: '1', factorToBase: '1', unitPrice: '58', discountPct: '10', taxRate: '16', pricesIncludeTax: true,
      }).lineTotal,
    ];
    const allocation = allocateInvoiceDiscount(weights, { pct: '10' });
    expect(allocation.amount.toFixed(3)).toBe('16.820');
    expect(allocation.shares.map((share) => share.toFixed(3))).toEqual(['11.600', '5.220']);

    const discounted = computeLineAmounts({
      qty: '1',
      factorToBase: '1',
      unitPrice: '116',
      taxRate: '16',
      pricesIncludeTax: true,
      invoiceDiscountShare: allocation.shares[0].toString(),
    });
    expect([discounted.discountAmount.toFixed(3), discounted.netAmount.toFixed(3), discounted.taxAmount.toFixed(3)])
      .toEqual(['11.600', '90.000', '14.400']);
  });

  it('accepts zero and the maximum discount', () => {
    expect(allocateInvoiceDiscount(['5', '7'], { amount: '0' }).shares.map((share) => share.toFixed(3)))
      .toEqual(['0.000', '0.000']);
    const maximum = allocateInvoiceDiscount(['5', '7'], { pct: '100' });
    expect(maximum.amount.toFixed(3)).toBe('12.000');
    expect(maximum.shares.map((share) => share.toFixed(3))).toEqual(['5.000', '7.000']);
  });

  it('rejects invalid combinations and amounts outside the line total', () => {
    for (const discount of [
      { pct: '-1' },
      { amount: '-0.001' },
      { amount: '12.001' },
      { pct: '10', amount: '1' },
    ]) {
      try {
        allocateInvoiceDiscount(['5', '7'], discount);
        throw new Error('expected invoice discount validation to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe(ErrorCode.INVOICE_DISCOUNT_INVALID);
      }
    }
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
