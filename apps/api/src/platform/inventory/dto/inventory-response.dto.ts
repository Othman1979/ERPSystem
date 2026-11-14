/**
 * Response shapes of the catalog, stock-report and warehouse routes (PLAT-15).
 * They describe what CatalogService, StockReportsService, StockLedgerService
 * and WarehousesService return today; nothing here changes a body.
 *
 * Stock documents (adjustments, transfers, counts) are in stock-documents-response.dto.ts.
 */
import { ApiExtraModels, ApiProperty, PickType, getSchemaPath } from '@nestjs/swagger';
import {
  BranchRow,
  ItemBarcodeRow,
  ItemCostRow,
  ItemGroupRow,
  ItemRow,
  ItemUnitRow,
  TaxCategoryRow,
  UnitRow,
  WarehouseRow,
} from '../../../common/openapi/prisma-models.js';
import { KeysetOf } from '../../../common/openapi/responses.js';
import { StockMovementType } from '../../../generated/prisma/enums.js';

// ------------------------------------------------------------------ refs

/** `{ code, nameAr }` of a unit, as the item barcode lookup and the item card send it (no id). */
export class UnitCodeNameDto extends PickType(UnitRow, ['code', 'nameAr'] as const) {}

/** `{ id, code, nameAr }` of a master row: the unit, item group or tax category an item points to. */
export class CatalogRefDto extends PickType(ItemGroupRow, ['id', 'code', 'nameAr'] as const) {}

/** `{ id, code, nameAr }` of a warehouse, as nested in the item card, goods notes and item defaults. */
export class WarehouseRefDto extends PickType(WarehouseRow, ['id', 'code', 'nameAr'] as const) {}

/** `{ id, code, nameAr }` of a branch, as nested in warehouse and goods note lists. */
export class BranchRefDto extends PickType(BranchRow, ['id', 'code', 'nameAr'] as const) {}

// --------------------------------------------------------------- catalog

/** `_count` of an item in the item list: its barcodes and unit rows. */
export class ItemCountDto {
  @ApiProperty({ type: 'integer' })
  barcodes!: number;

  @ApiProperty({ type: 'integer' })
  units!: number;
}

/** An item unit with its unit (ItemUnit + unit), as the item detail and set-units routes send it. */
export class ItemUnitWithUnitDto extends ItemUnitRow {
  @ApiProperty({ type: () => UnitRow })
  unit!: UnitRow;
}

/** An item unit with its unit as code and Arabic name only (barcode lookup). */
export class ItemUnitLookupDto extends ItemUnitRow {
  @ApiProperty({ type: () => UnitCodeNameDto })
  unit!: UnitCodeNameDto;
}

/** A barcode with the item unit it is bound to, or null (item detail). */
export class ItemBarcodeWithItemUnitDto extends ItemBarcodeRow {
  @ApiProperty({ type: () => ItemUnitWithUnitDto, nullable: true })
  itemUnit!: ItemUnitWithUnitDto | null;
}

/** An item as written: every column of `items` (CatalogService.updateItem, PATCH /items/:id). */
export class ItemDto extends ItemRow {}

/** A row of the item list: the item with its unit, group, tax category, default warehouse and counts (CatalogService.listItems). */
export class ItemListItemDto extends ItemRow {
  @ApiProperty({ type: () => CatalogRefDto })
  baseUnit!: CatalogRefDto;

  @ApiProperty({ type: () => CatalogRefDto, nullable: true })
  itemGroup!: CatalogRefDto | null;

  @ApiProperty({ type: () => CatalogRefDto, nullable: true })
  taxCategory!: CatalogRefDto | null;

  @ApiProperty({ type: () => WarehouseRefDto, nullable: true })
  defaultWarehouse!: WarehouseRefDto | null;

  @ApiProperty({ type: () => ItemCountDto })
  _count!: ItemCountDto;
}

/** One item with its units, barcodes and cost projection (CatalogService.getItem; also create and set-units). */
export class ItemDetailDto extends ItemRow {
  @ApiProperty({ type: () => UnitRow })
  baseUnit!: UnitRow;

  @ApiProperty({ type: () => ItemGroupRow, nullable: true })
  itemGroup!: ItemGroupRow | null;

  @ApiProperty({ type: () => TaxCategoryRow, nullable: true })
  taxCategory!: TaxCategoryRow | null;

  @ApiProperty({ type: () => ItemUnitWithUnitDto, isArray: true })
  units!: ItemUnitWithUnitDto[];

  @ApiProperty({ type: () => ItemBarcodeWithItemUnitDto, isArray: true })
  barcodes!: ItemBarcodeWithItemUnitDto[];

  @ApiProperty({ type: () => ItemCostRow, isArray: true, description: 'Normally zero or one row (per company).' })
  costs!: ItemCostRow[];

  @ApiProperty({ type: () => WarehouseRefDto, nullable: true })
  defaultWarehouse!: WarehouseRefDto | null;
}

/** The item a barcode belongs to, with its base unit and units by code and name (CatalogService.findByBarcode). */
export class ItemByBarcodeDto extends ItemRow {
  @ApiProperty({ type: () => UnitCodeNameDto })
  baseUnit!: UnitCodeNameDto;

  @ApiProperty({ type: () => ItemUnitLookupDto, isArray: true })
  units!: ItemUnitLookupDto[];
}

/** A barcode row (CatalogService.addBarcode). */
export class ItemBarcodeDto extends ItemBarcodeRow {}

/** An item group (CatalogService.listGroups, createGroup, updateGroup). */
export class ItemGroupDto extends ItemGroupRow {}

// ------------------------------------------------------------ warehouses

/** `_count` of a warehouse: its balance rows. */
export class WarehouseCountDto {
  @ApiProperty({ type: 'integer' })
  balances!: number;
}

/** A warehouse in the list, with its branch and balance count (WarehousesService.list). */
export class WarehouseListItemDto extends WarehouseRow {
  @ApiProperty({ type: () => BranchRefDto, nullable: true })
  branch!: BranchRefDto | null;

  @ApiProperty({ type: () => WarehouseCountDto })
  _count!: WarehouseCountDto;
}

/** A warehouse with its full branch (WarehousesService.get). */
export class WarehouseDetailDto extends WarehouseRow {
  @ApiProperty({ type: () => BranchRow, nullable: true })
  branch!: BranchRow | null;
}

/** A warehouse as written: every column of `warehouses` (create and update). */
export class WarehouseDto extends WarehouseRow {}

// ---------------------------------------------------------- stock reports

/** One on-hand row of GET /stock/balances (StockReportsService.balances), JSON form. */
export class StockReportBalanceDto {
  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ type: 'string' })
  warehouseCode!: string;

  @ApiProperty({ type: 'string', description: 'Warehouse name in Arabic.' })
  warehouseName!: string;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  itemCode!: string;

  @ApiProperty({ type: 'string', description: 'Item name in Arabic.' })
  itemName!: string;

  @ApiProperty({ type: 'string', description: 'Code of the base unit.' })
  unit!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOnHand!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  minStock!: string;

  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  lastMovementDate!: string | null;
}

/** One row of GET /stock/movements (StockReportsService.movements). */
export class StockReportMovementDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'date-time', description: 'Movement date (a DATE column, so 00:00 UTC).' })
  movementDate!: string;

  @ApiProperty({ type: 'string' })
  warehouseCode!: string;

  @ApiProperty({ type: 'string' })
  itemCode!: string;

  @ApiProperty({ type: 'string', description: 'Item name in Arabic.' })
  itemName!: string;

  @ApiProperty({ enum: StockMovementType, enumName: 'StockMovementType' })
  movementType!: StockMovementType;

  @ApiProperty({ type: 'string', description: 'Free text naming the source document, e.g. STOCK_ADJUSTMENT.' })
  sourceType!: string;

  @ApiProperty({ type: 'string', nullable: true })
  sourceId!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyIn!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOut!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unitCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  balanceQtyAfter!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  avgCostAfter!: string;
}

/** The item of an item card: id, codes, names, kind and base unit (StockReportsService.itemLedgerPage). */
export class ItemCardItemDto extends PickType(ItemRow, ['id', 'code', 'nameAr', 'nameEn', 'itemKind'] as const) {
  @ApiProperty({ type: () => UnitCodeNameDto })
  baseUnit!: UnitCodeNameDto;
}

/** A quantity and its value, both as strings (opening and closing of an item card). */
export class ItemCardQtyValueDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  value!: string;
}

/** Totals of the movements in the card's period (quantities and values in and out). */
export class ItemCardTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyIn!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOut!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  valueIn!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  valueOut!: string;
}

/** The quantity on hand of the item in one warehouse with stock (non-zero only). */
export class ItemCardBalanceDto {
  @ApiProperty({ type: () => WarehouseRefDto })
  warehouse!: WarehouseRefDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOnHand!: string;
}

/** The card's summary: opening, period totals, closing, and balances per warehouse (StockReportsService.cardSummary). */
export class ItemCardSummaryDto {
  @ApiProperty({ type: () => ItemCardQtyValueDto })
  opening!: ItemCardQtyValueDto;

  @ApiProperty({ type: () => ItemCardTotalsDto })
  totals!: ItemCardTotalsDto;

  @ApiProperty({ type: () => ItemCardQtyValueDto })
  closing!: ItemCardQtyValueDto;

  @ApiProperty({ type: () => ItemCardBalanceDto, isArray: true })
  balances!: ItemCardBalanceDto[];
}

/** One movement row of an item card (StockReportsService cardRow). Carries a warehouse object, unlike /stock/movements. */
export class ItemCardRowDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  movementDate!: string;

  @ApiProperty({ type: () => WarehouseRefDto })
  warehouse!: WarehouseRefDto;

  @ApiProperty({ enum: StockMovementType, enumName: 'StockMovementType' })
  movementType!: StockMovementType;

  @ApiProperty({ type: 'string' })
  sourceType!: string;

  @ApiProperty({ type: 'string', nullable: true })
  sourceId!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyIn!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qtyOut!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  unitCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  totalCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  balanceQtyAfter!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  avgCostAfter!: string;
}

/**
 * One keyset page of an item card (GET /stock/items/:itemId/ledger, JSON).
 * `summary` is sent on the first page and null after it; `item` on every page.
 */
export class ItemLedgerPageDto extends KeysetOf(ItemCardRowDto, {
  summary: ItemCardSummaryDto,
  summaryMode: 'nullable',
  name: 'ItemCardKeyset',
}) {
  @ApiProperty({ type: () => ItemCardItemDto })
  item!: ItemCardItemDto;
}

/** One row of GET /stock/item-balances (StockReportsService.itemBalances). */
export class ItemBalanceRowDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string', description: 'Item name in Arabic.' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: () => UnitCodeNameDto })
  unit!: UnitCodeNameDto;

  @ApiProperty({ type: 'string', format: 'decimal' })
  openingQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  openingValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  inQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  inValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  outValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingQty!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  closingValue!: string;
}

/** The totals of the item balances report, each fixed to 3 decimal places. */
export class ItemBalanceTotalsDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  openingValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  inValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  outValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  closingValue!: string;
}

/** GET /stock/item-balances, JSON form: the rows and their totals. */
export class ItemBalancesReportDto {
  @ApiProperty({ type: () => ItemBalanceRowDto, isArray: true })
  rows!: ItemBalanceRowDto[];

  @ApiProperty({ type: () => ItemBalanceTotalsDto })
  totals!: ItemBalanceTotalsDto;
}

/** One row of GET /stock/valuation (StockReportsService.valuation). */
export class StockValuationRowDto {
  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string', description: 'Item name in Arabic.' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  qty!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  avgCost!: string;

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  value!: string;
}

/** GET /stock/valuation, JSON form: the rows and the total value. */
export class StockValuationReportDto {
  @ApiProperty({ type: () => StockValuationRowDto, isArray: true })
  rows!: StockValuationRowDto[];

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Fixed 3 decimal places.' })
  totalValue!: string;
}

/** A stock:verify difference between a balance row and its movements. */
export class StockVerifyQtyMismatchDto {
  @ApiProperty({ type: 'string', enum: ['QTY'] })
  kind!: 'QTY';

  @ApiProperty({ type: 'string' })
  warehouseId!: string;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  expected!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  actual!: string;
}

/** A stock:verify difference between an item cost projection and its movements. */
export class StockVerifyCostMismatchDto {
  @ApiProperty({ type: 'string', enum: ['COST_QTY', 'COST_VALUE'] })
  kind!: 'COST_QTY' | 'COST_VALUE';

  @ApiProperty({ type: 'string' })
  companyId!: string;

  @ApiProperty({ type: 'string' })
  itemId!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  expected!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  actual!: string;
}

/** A stock:verify difference between the stock value and the inventory account in the ledger. */
export class StockVerifyGlMismatchDto {
  @ApiProperty({ type: 'string', enum: ['GL_INVENTORY'] })
  kind!: 'GL_INVENTORY';

  @ApiProperty({ type: 'string' })
  companyId!: string;

  @ApiProperty({ type: 'string', nullable: true })
  accountCode!: string | null;

  @ApiProperty({ type: 'string', format: 'decimal' })
  expected!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  actual!: string;
}

/** GET /stock/verify: the result of the stock integrity check (StockLedgerService.verify). */
@ApiExtraModels(StockVerifyQtyMismatchDto, StockVerifyCostMismatchDto, StockVerifyGlMismatchDto)
export class StockVerifyResultDto {
  @ApiProperty({ type: 'integer', description: 'Number of (warehouse, item) and (company, item) pairs checked.' })
  checked!: number;

  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath(StockVerifyQtyMismatchDto) },
        { $ref: getSchemaPath(StockVerifyCostMismatchDto) },
        { $ref: getSchemaPath(StockVerifyGlMismatchDto) },
      ],
    },
  })
  mismatches!: (StockVerifyQtyMismatchDto | StockVerifyCostMismatchDto | StockVerifyGlMismatchDto)[];

  @ApiProperty({ type: 'string', format: 'decimal', description: 'Stock value rounded to 3 decimal places.' })
  stockValue!: string;

  @ApiProperty({ type: 'string', format: 'decimal', nullable: true, description: 'Null when no inventory account is mapped.' })
  inventoryAccountBalance!: string | null;
}
