import { describe, expect, it } from 'vitest';
import { ar, en } from '../../i18n/locales';
import { holdsStock, isRecipe, ITEM_KIND_LABEL_KEY, ITEM_KINDS, ownsFormula } from './itemKinds';

const lookup = (dict: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);

describe('item kind selectors (ADR-031 §1, ADR-032 §5)', () => {
  it('offer a manufactured item and a recipe at create and in the filter, between the stock kinds and the service', () => {
    expect(ITEM_KINDS).toEqual(['STOCK', 'MANUFACTURED', 'RECIPE', 'SERVICE']);
  });

  it('name every kind in both languages', () => {
    for (const kind of ITEM_KINDS) {
      const key = ITEM_KIND_LABEL_KEY[kind];
      expect(typeof lookup(ar, key)).toBe('string');
      expect(typeof lookup(en, key)).toBe('string');
    }
    expect(lookup(ar, ITEM_KIND_LABEL_KEY.MANUFACTURED)).toBe('مُصنَّع');
    expect(lookup(en, ITEM_KIND_LABEL_KEY.MANUFACTURED)).toBe('Manufactured');
    expect(lookup(ar, ITEM_KIND_LABEL_KEY.RECIPE)).toBe('وصفة');
    expect(lookup(en, ITEM_KIND_LABEL_KEY.RECIPE)).toBe('Recipe');
  });
});

describe('holdsStock (ADR-031 §1, ADR-032 §5)', () => {
  it('is true for a stock item and for a manufactured one', () => {
    expect(holdsStock('STOCK')).toBe(true);
    expect(holdsStock('MANUFACTURED')).toBe(true);
  });

  it('is false for a recipe, a service, and for no kind at all', () => {
    expect(holdsStock('RECIPE')).toBe(false);
    expect(holdsStock('SERVICE')).toBe(false);
    expect(holdsStock(undefined)).toBe(false);
    expect(holdsStock(null)).toBe(false);
  });
});

describe('isRecipe and ownsFormula (ADR-032 §5, §6)', () => {
  it('a recipe is a recipe and owns a formula; a manufactured item owns one too but is not a recipe', () => {
    expect(isRecipe('RECIPE')).toBe(true);
    expect(isRecipe('MANUFACTURED')).toBe(false);
    expect(ownsFormula('RECIPE')).toBe(true);
    expect(ownsFormula('MANUFACTURED')).toBe(true);
  });

  it('a stock item, a service or no kind owns no formula', () => {
    expect(ownsFormula('STOCK')).toBe(false);
    expect(ownsFormula('SERVICE')).toBe(false);
    expect(ownsFormula(undefined)).toBe(false);
  });
});
