import type { UpdateItemDto } from '@erp/api-client';
import { describe, expect, it } from 'vitest';
import { itemCreateBody, itemUpdateBody, type ItemFormValues } from './itemPayload';

/**
 * Every key UpdateItemDto takes. `satisfies` makes a key that the API does not
 * have a type error, so the list cannot drift from the generated DTO.
 */
const UPDATE_KEYS = [
  'nameAr',
  'nameEn',
  'description',
  'itemGroupId',
  'taxCategoryId',
  'salePrice',
  'purchasePrice',
  'minStock',
  'maxStock',
  'defaultWarehouseId',
  'salePriceIncludesTax',
  'imageUrl',
  'isActive',
] as const satisfies readonly (keyof UpdateItemDto)[];

/**
 * What antd's onFinish hands over when editing: the disabled code, kind and
 * base unit included, and every optional field emptied the way its control
 * empties (input '', number null, select undefined).
 */
const emptied: ItemFormValues = {
  code: 'A',
  itemKind: 'STOCK',
  baseUnitId: '7',
  nameAr: 'الصنف أ',
  nameEn: '',
  description: '',
  itemGroupId: undefined,
  taxCategoryId: undefined,
  salePrice: null,
  purchasePrice: null,
  minStock: null,
  maxStock: null,
  defaultWarehouseId: undefined,
  salePriceIncludesTax: false,
  imageUrl: '',
};

const filled: ItemFormValues = {
  ...emptied,
  nameEn: 'Item A',
  description: 'Note',
  itemGroupId: '4',
  taxCategoryId: '3',
  salePrice: '8.000',
  purchasePrice: '5.000',
  minStock: '0',
  maxStock: '100',
  defaultWarehouseId: '9',
  imageUrl: 'https://example.test/a.png',
};

/** The body as JSON sends it: undefined keys disappear, null stays. */
const sent = (body: object) => JSON.parse(JSON.stringify(body)) as Record<string, unknown>;

describe('item form bodies (the Items page edit bug)', () => {
  it('an edit sends only UpdateItemDto fields, never the fixed code, kind or base unit', () => {
    for (const values of [emptied, filled]) {
      const keys = Object.keys(sent(itemUpdateBody(values)));
      expect(keys).not.toContain('code');
      expect(keys).not.toContain('itemKind');
      expect(keys).not.toContain('baseUnitId');
      for (const key of keys) expect(UPDATE_KEYS).toContain(key);
    }
  });

  it('an edit sends every emptied optional field as null, so it is cleared', () => {
    expect(sent(itemUpdateBody(emptied))).toEqual({
      nameAr: 'الصنف أ',
      nameEn: null,
      description: null,
      itemGroupId: null,
      taxCategoryId: null,
      salePrice: null,
      purchasePrice: null,
      maxStock: null,
      defaultWarehouseId: null,
      salePriceIncludesTax: false,
      imageUrl: null,
    });
  });

  it('an edit sends the filled values as they are', () => {
    expect(sent(itemUpdateBody(filled))).toEqual({
      nameAr: 'الصنف أ',
      nameEn: 'Item A',
      description: 'Note',
      itemGroupId: '4',
      taxCategoryId: '3',
      salePrice: '8.000',
      purchasePrice: '5.000',
      minStock: '0',
      maxStock: '100',
      defaultWarehouseId: '9',
      salePriceIncludesTax: false,
      imageUrl: 'https://example.test/a.png',
    });
  });

  it('a create sends code, kind and base unit, and leaves empty optional fields out', () => {
    expect(sent(itemCreateBody(emptied))).toEqual({
      code: 'A',
      itemKind: 'STOCK',
      baseUnitId: '7',
      nameAr: 'الصنف أ',
      salePriceIncludesTax: false,
    });
  });
});
