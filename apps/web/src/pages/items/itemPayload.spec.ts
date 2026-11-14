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

/** What antd's onFinish hands over when editing: the disabled code, kind and base unit included. */
const editValues: ItemFormValues = {
  code: 'A',
  itemKind: 'STOCK',
  baseUnitId: '7',
  nameAr: 'الصنف أ',
  nameEn: '',
  description: 'Note',
  itemGroupId: undefined,
  taxCategoryId: '3',
  salePrice: '8.000',
  purchasePrice: null,
  minStock: '0',
  maxStock: null,
  defaultWarehouseId: '',
  salePriceIncludesTax: false,
  imageUrl: '',
};

/** The keys a request body would send: JSON drops undefined values. */
const sentKeys = (body: object) => Object.keys(JSON.parse(JSON.stringify(body)) as object);

describe('item form bodies (the Items page edit bug)', () => {
  it('an edit sends only UpdateItemDto fields, never the fixed code, kind or base unit', () => {
    const keys = sentKeys(itemUpdateBody(editValues));
    expect(keys).not.toContain('code');
    expect(keys).not.toContain('itemKind');
    expect(keys).not.toContain('baseUnitId');
    for (const key of keys) expect(UPDATE_KEYS).toContain(key);
  });

  it('an edit sends the edited values, and empty optional fields as absent', () => {
    expect(JSON.parse(JSON.stringify(itemUpdateBody(editValues)))).toEqual({
      nameAr: 'الصنف أ',
      description: 'Note',
      taxCategoryId: '3',
      salePrice: '8.000',
      minStock: '0',
      salePriceIncludesTax: false,
    });
  });

  it('a create also sends code, kind and base unit', () => {
    expect(itemCreateBody(editValues)).toMatchObject({ code: 'A', itemKind: 'STOCK', baseUnitId: '7', nameAr: 'الصنف أ' });
  });
});
