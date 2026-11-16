import { isStocked, ITEM_KINDS, stockedItemKindFilter } from './item-kind.js';

describe('item kinds (ADR-031 §1)', () => {
  it('treats STOCK and MANUFACTURED as stocked, SERVICE as not', () => {
    expect(ITEM_KINDS.map((k) => [k, isStocked(k)])).toEqual([
      ['STOCK', true],
      ['SERVICE', false],
      ['MANUFACTURED', true],
    ]);
  });

  it('filters by the stocked kinds with a fresh array each call', () => {
    const first = stockedItemKindFilter();
    expect(first).toEqual({ in: ['STOCK', 'MANUFACTURED'] });
    first.in.push('SERVICE' as never);
    expect(stockedItemKindFilter()).toEqual({ in: ['STOCK', 'MANUFACTURED'] });
  });
});
