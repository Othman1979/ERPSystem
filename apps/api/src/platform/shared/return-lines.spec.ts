import { Decimal } from '../../common/decimal/decimal.utils.js';
import { computeReturnLines, returnedByLine } from './return-lines.js';

const line = { id: 1n, lineNo: 1, itemId: 7n, qty: '3', qtyBase: '3', discountAmount: '0', netAmount: '100', taxAmount: '16' };
const s = (d: Decimal) => d.toString();

describe('computeReturnLines (§7.7)', () => {
  it('three returns of 1 from 3 add up to the line exactly (TRADE-22)', () => {
    const rows: { originalLineId: bigint; qtyBase: string; discountAmount: string; netAmount: string; taxAmount: string }[] = [];
    for (let i = 0; i < 3; i += 1) {
      const [r] = computeReturnLines([line], [{ originalLineId: '1', qty: '1' }], returnedByLine(rows));
      rows.push({ originalLineId: 1n, qtyBase: s(r.qtyBase), discountAmount: s(r.discountAmount), netAmount: s(r.netAmount), taxAmount: s(r.taxAmount) });
    }
    expect(rows.map((r) => r.netAmount)).toEqual(['33.333', '33.333', '33.334']);
    expect(rows.map((r) => r.taxAmount)).toEqual(['5.333', '5.333', '5.334']);
  });

  it('refuses more than remains, and a line twice in one return', () => {
    const done = returnedByLine([{ originalLineId: 1n, qtyBase: '2', discountAmount: '0', netAmount: '66.667', taxAmount: '10.667' }]);
    expect(() => computeReturnLines([line], [{ originalLineId: '1', qty: '2' }], done)).toThrow(/remaining 1/);
    expect(() =>
      computeReturnLines([line], [{ originalLineId: '1', qty: '1' }, { originalLineId: '1', qty: '1' }], new Map()),
    ).toThrow(/more than once/);
  });

  it('stores the quantity in the original line unit (TRADE-13)', () => {
    const box = { ...line, qty: '2', qtyBase: '24', netAmount: '240', taxAmount: '38.4' };
    const [r] = computeReturnLines([box], [{ originalLineId: '1', qty: '12' }], new Map());
    expect([s(r.qty), s(r.qtyBase), s(r.netAmount)]).toEqual(['1', '12', '120']);
  });
});
