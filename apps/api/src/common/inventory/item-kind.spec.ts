import { isRecipe, isStocked, ITEM_KINDS, stockedItemKindFilter } from './item-kind.js';

describe('item kinds (ADR-031 §1, ADR-032 §5)', () => {
  it('treats STOCK and MANUFACTURED as stocked; SERVICE and RECIPE as not', () => {
    expect(ITEM_KINDS.map((k) => [k, isStocked(k)])).toEqual([
      ['STOCK', true],
      ['SERVICE', false],
      ['MANUFACTURED', true],
      ['RECIPE', false],
    ]);
  });

  it('marks only RECIPE as a recipe', () => {
    expect(ITEM_KINDS.filter((k) => isRecipe(k))).toEqual(['RECIPE']);
  });

  it('filters by the stocked kinds with a fresh array each call', () => {
    const first = stockedItemKindFilter();
    expect(first).toEqual({ in: ['STOCK', 'MANUFACTURED'] });
    first.in.push('SERVICE' as never);
    expect(stockedItemKindFilter()).toEqual({ in: ['STOCK', 'MANUFACTURED'] });
  });
});
