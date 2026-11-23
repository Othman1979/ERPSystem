export type GoodsNoteWarehouseNoteType = 'GRN' | 'GIN' | 'CONSIGNMENT_IN' | 'CONSIGNMENT_OUT';

export interface GoodsNoteWarehouse {
  consignmentSupplierId: string | null;
}

export const isConsignmentNoteType = (type: GoodsNoteWarehouseNoteType): boolean =>
  type === 'CONSIGNMENT_IN' || type === 'CONSIGNMENT_OUT';

export function goodsNoteWarehouses<T extends GoodsNoteWarehouse>(
  type: GoodsNoteWarehouseNoteType,
  warehouses: T[],
  consignmentEnabled: boolean,
): T[] {
  const consignmentType = isConsignmentNoteType(type);
  if (consignmentType && !consignmentEnabled) return [];
  return warehouses.filter((warehouse) => (warehouse.consignmentSupplierId != null) === consignmentType);
}
