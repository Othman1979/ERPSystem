import type { CreateItemDto, CreateItemDtoItemKind, UpdateItemDto } from '@erp/api-client';

/**
 * The item form's values, as antd's `onFinish` hands them over. Disabled
 * fields are included: when editing, `code`, `itemKind` and `baseUnitId` are
 * shown disabled but still present. A cleared input is `''`, a cleared
 * number `null`, a cleared select `undefined`.
 */
export interface ItemFormValues {
  code: string;
  itemKind: CreateItemDtoItemKind;
  nameAr: string;
  nameEn?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  baseUnitId: string;
  itemGroupId?: string | null;
  taxCategoryId?: string | null;
  salePrice?: string | null;
  purchasePrice?: string | null;
  minStock?: string | null;
  maxStock?: string | null;
  defaultWarehouseId?: string | null;
  salePriceIncludesTax: boolean;
}

/** An emptied optional field: null, so an edit clears it (UpdateItemDto takes null for each of these). */
const cleared = (v: string | null | undefined): string | null => (v === undefined || v === null || v === '' ? null : v);
/** An empty optional field on create: absent. */
const absent = (v: string | null | undefined): string | undefined => (v === undefined || v === null || v === '' ? undefined : v);

/**
 * The body of PATCH /items/:id. Only UpdateItemDto's fields: the API refuses
 * any other (forbidNonWhitelisted), so spreading the form values, with their
 * fixed code, kind and base unit, made every edit fail with 400. The edit
 * form holds every field, so an empty one is sent as null and clears it.
 */
export function itemUpdateBody(v: ItemFormValues): UpdateItemDto {
  const body: UpdateItemDto = {
    nameAr: v.nameAr,
    nameEn: cleared(v.nameEn),
    description: cleared(v.description),
    itemGroupId: cleared(v.itemGroupId),
    taxCategoryId: cleared(v.taxCategoryId),
    salePrice: cleared(v.salePrice),
    purchasePrice: cleared(v.purchasePrice),
    // Not nullable in UpdateItemDto: an empty minimum leaves the stored one unchanged.
    minStock: absent(v.minStock),
    maxStock: cleared(v.maxStock),
    defaultWarehouseId: cleared(v.defaultWarehouseId),
    salePriceIncludesTax: v.salePriceIncludesTax,
    imageUrl: cleared(v.imageUrl),
  };
  return body;
}

/** The body of POST /items: empty optional fields absent, plus code, kind and base unit, fixed after creation. */
export function itemCreateBody(v: ItemFormValues): CreateItemDto {
  const body: CreateItemDto = {
    code: v.code,
    itemKind: v.itemKind,
    baseUnitId: v.baseUnitId,
    nameAr: v.nameAr,
    nameEn: absent(v.nameEn),
    description: absent(v.description),
    itemGroupId: absent(v.itemGroupId),
    taxCategoryId: absent(v.taxCategoryId),
    salePrice: absent(v.salePrice),
    purchasePrice: absent(v.purchasePrice),
    minStock: absent(v.minStock),
    maxStock: absent(v.maxStock),
    defaultWarehouseId: absent(v.defaultWarehouseId),
    salePriceIncludesTax: v.salePriceIncludesTax,
    imageUrl: absent(v.imageUrl),
  };
  return body;
}
