import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { CatalogLineRefs } from '../inventory/catalog.service.js';
import { assertWithinRemaining, documentTotals, priceLine, remainingQty, resolveItem } from './procurement-lines.js';

const refs: CatalogLineRefs = {
  items: new Map([
    [1n, { id: 1n, code: 'I1', itemKind: 'STOCK', taxCategory: { id: 10n, rate: new Decimal(16) } }],
    [2n, { id: 2n, code: 'I2', itemKind: 'SERVICE', taxCategory: null }],
  ]),
  units: new Map([[5n, { id: 5n, itemId: 1n, factorToBase: new Decimal(12) }]]),
  defaultTax: { id: 11n, rate: new Decimal(8) },
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as DomainError).code;
  }
};

describe('procurement lines (ADR-025 §11, ADR-017)', () => {
  it('takes the tax from the item, else the default category; the unit factor gives the base quantity', () => {
    const a = resolveItem(refs, { itemId: '1', itemUnitId: '5', qty: '2.5' });
    expect([a.taxCategoryId, a.taxRate.toString(), a.qtyBase.toString(), a.itemUnitId]).toEqual([10n, '16', '30', 5n]);
    const b = resolveItem(refs, { itemId: '2', qty: '1' });
    expect([b.taxCategoryId, b.taxRate.toString(), b.itemUnitId]).toEqual([11n, '8', null]);
  });

  it('refuses another item’s unit, an unknown item and a zero quantity', () => {
    expect(codeOf(() => resolveItem(refs, { itemId: '2', itemUnitId: '5', qty: '1' }))).toBe(ErrorCode.VALIDATION);
    expect(codeOf(() => resolveItem(refs, { itemId: '9', qty: '1' }))).toBe(ErrorCode.NOT_FOUND);
    expect(codeOf(() => resolveItem(refs, { itemId: '1', qty: '0' }))).toBe(ErrorCode.VALIDATION);
  });

  it('prices a line net of tax: discount, then 3-decimal tax, and adds up the header', () => {
    const l1 = priceLine(resolveItem(refs, { itemId: '1', qty: '3' }), '33.333333', '10', false);
    // 3 × 33.333333 = 99.999999 → 100.000; −10% = 90.000; tax 16% = 14.400.
    expect([l1.amounts.discountAmount, l1.amounts.netAmount, l1.amounts.taxAmount, l1.amounts.lineTotal].map(String)).toEqual([
      '10',
      '90',
      '14.4',
      '104.4',
    ]);
    const l2 = priceLine(resolveItem(refs, { itemId: '2', qty: '1' }), '0.005', undefined, false);
    // 0.005 → 0.005 net, 8% = 0.0004 → 0.000 tax.
    expect([l2.amounts.netAmount.toString(), l2.amounts.taxAmount.toString()]).toEqual(['0.005', '0']);
    const totals = documentTotals([l1, l2]);
    expect([totals.netTotal, totals.taxTotal, totals.grandTotal].map(String)).toEqual(['90.005', '14.4', '104.405']);
  });

  it('extracts the tax from a tax-inclusive price (company setting frozen on the document)', () => {
    const l = priceLine(resolveItem(refs, { itemId: '1', qty: '1' }), '116', undefined, true);
    expect([l.amounts.netAmount, l.amounts.taxAmount, l.amounts.lineTotal].map(String)).toEqual(['100', '16', '116']);
  });

  it('what is left on a request line, and the sum per line kept within it', () => {
    expect(remainingQty({ qty: '20', orderedQty: '12.5' }).toString()).toBe('7.5');
    const left = new Map([
      [1n, new Decimal('10')],
      [2n, new Decimal('0.000001')],
    ]);
    const ok = assertWithinRemaining(
      [
        { requestLineId: 1n, qty: new Decimal('4') },
        { requestLineId: 1n, qty: new Decimal('6') },
        { requestLineId: 2n, qty: new Decimal('0.000001') },
      ],
      left,
    );
    expect([...ok].map(([k, v]) => [k, v.toString()])).toEqual([
      [1n, '10'],
      [2n, '0.000001'],
    ]);
    try {
      assertWithinRemaining([{ requestLineId: 1n, qty: new Decimal('6') }, { requestLineId: 1n, qty: new Decimal('4.000001') }], left);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.PURCHASE_REQUEST_QTY_EXCEEDED);
      expect((e as DomainError).details).toEqual({ requestLineId: '1', remaining: '10.000000', wanted: '10.000001' });
    }
    expect(codeOf(() => assertWithinRemaining([{ requestLineId: 3n, qty: new Decimal(1) }], left))).toBe(ErrorCode.NOT_FOUND);
  });
});
