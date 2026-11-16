import { describe, expect, it } from 'vitest';
import { componentSearchParams, mergeOptions, OWNER_ITEM_KINDS } from './pickerRules';

describe('formula pickers (ADR-032 §6)', () => {
  it('the owner of a formula is a manufactured item or a recipe, and nothing else', () => {
    expect(OWNER_ITEM_KINDS).toEqual(['MANUFACTURED', 'RECIPE']);
  });

  it('a manufactured owner takes stocked components only, never a recipe', () => {
    expect(componentSearchParams('MANUFACTURED')).toEqual([{ stocked: 'true' }]);
    expect(componentSearchParams(undefined)).toEqual([{ stocked: 'true' }]);
  });

  it('a recipe owner takes stocked components and recipes', () => {
    expect(componentSearchParams('RECIPE')).toEqual([{ stocked: 'true' }, { itemKind: 'RECIPE' }]);
  });

  it('merges several searches into one list, each item once, in order', () => {
    const merged = mergeOptions([
      [
        { value: '1', label: 'A' },
        { value: '2', label: 'B' },
      ],
      [
        { value: '2', label: 'B' },
        { value: '3', label: 'C' },
      ],
    ]);
    expect(merged).toEqual([
      { value: '1', label: 'A' },
      { value: '2', label: 'B' },
      { value: '3', label: 'C' },
    ]);
    expect(mergeOptions([])).toEqual([]);
  });
});
