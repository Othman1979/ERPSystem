import type { CreateItemDto, CreateItemDtoItemKind, UpdateItemDto } from '@erp/api-client';

/**
 * The item form's values, as antd's `onFinish` hands them over. Disabled
 * fields are included: when editing, `code`, `itemKind` and `baseUnitId` are
 * shown disabled but still present.
 */
export interface ItemFormValues {
  code: string;
  itemKind: CreateItemDtoItemKind;
  nameAr: string;
  nameEn?: string;
  description?: string;
  imageUrl?: string;
  baseUnitId: string;
  itemGroupId?: string;
  taxCategoryId?: string;
  salePrice?: string | null;
  purchasePrice?: string | null;
  minStock?: string | null;
  maxStock?: string | null;
  defaultWarehouseId?: string;
  salePriceIncludesTax: boolean;
}

/** The fields create and update both take. */
function editableFields(v: ItemFormValues) {
  return {
    nameAr: v.nameAr,
    nameEn: v.nameEn || undefined,
    description: v.description || undefined,
    itemGroupId: v.itemGroupId || undefined,
    taxCategoryId: v.taxCategoryId || undefined,
    salePrice: v.salePrice ?? undefined,
    purchasePrice: v.purchasePrice ?? undefined,
    minStock: v.minStock ?? undefined,
    maxStock: v.maxStock ?? undefined,
    defaultWarehouseId: v.defaultWarehouseId || undefined,
    salePriceIncludesTax: v.salePriceIncludesTax,
    imageUrl: v.imageUrl || undefined,
  };
}

/**
 * The body of PATCH /items/:id. Only UpdateItemDto's fields: the API refuses
 * any other (forbidNonWhitelisted), so spreading the form values, with their
 * fixed code, kind and base unit, made every edit fail with 400.
 */
export function itemUpdateBody(v: ItemFormValues): UpdateItemDto {
  return editableFields(v) satisfies UpdateItemDto;
}

/** The body of POST /items: the update fields plus code, kind and base unit, fixed after creation. */
export function itemCreateBody(v: ItemFormValues): CreateItemDto {
  return { ...editableFields(v), code: v.code, itemKind: v.itemKind, baseUnitId: v.baseUnitId } satisfies CreateItemDto;
}
