import { describe, expect, it } from 'vitest';
import { ar, en } from '../../i18n/locales';
import { holdsStock, ITEM_KIND_LABEL_KEY, ITEM_KINDS } from './itemKinds';

const lookup = (dict: unknown, key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), dict);

describe('item kind selectors (ADR-031 §1)', () => {
  it('offer a manufactured item at create and in the filter, between stock and service', () => {
    expect(ITEM_KINDS).toEqual(['STOCK', 'MANUFACTURED', 'SERVICE']);
  });

  it('name every kind in both languages', () => {
    for (const kind of ITEM_KINDS) {
      const key = ITEM_KIND_LABEL_KEY[kind];
      expect(typeof lookup(ar, key)).toBe('string');
      expect(typeof lookup(en, key)).toBe('string');
    }
    expect(lookup(ar, ITEM_KIND_LABEL_KEY.MANUFACTURED)).toBe('مُصنَّع');
    expect(lookup(en, ITEM_KIND_LABEL_KEY.MANUFACTURED)).toBe('Manufactured');
  });
});

describe('holdsStock (ADR-031 §1)', () => {
  it('is true for a stock item and for a manufactured one', () => {
    expect(holdsStock('STOCK')).toBe(true);
    expect(holdsStock('MANUFACTURED')).toBe(true);
  });

  it('is false for a service, and for no kind at all', () => {
    expect(holdsStock('SERVICE')).toBe(false);
    expect(holdsStock(undefined)).toBe(false);
    expect(holdsStock(null)).toBe(false);
  });
});
