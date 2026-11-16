/**
 * Response shapes of the production voucher routes (ADR-023): what
 * ProductionVouchersService returns. Ids, quantities and amounts are strings
 * (CLAUDE.md).
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import { ProductionVoucherLineRow, ProductionVoucherRow } from '../../../common/openapi/prisma-models.js';
import { BomItemRefDto, BomItemUnitRefDto } from './bom-response.dto.js';

/** A warehouse as a short reference (code and Arabic name). */
export class ProductionWarehouseRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;
}

/** The bill of materials version a voucher was made with. */
export class ProductionBomRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'integer' })
  versionNo!: number;

  @ApiProperty({ enum: ['DRAFT', 'ACTIVE', 'INACTIVE'] })
  status!: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
}

/** Shortage of one line (drafts only): stock on hand in the materials warehouse (ADR-031 §6). */
export class ProductionShortageDto {
  @ApiProperty({ type: 'string', format: 'decimal' })
  availableQtyBase!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  shortageQtyBase!: string;

  /** True for a MANUFACTURED component that has an ACTIVE version to produce it from. */
  @ApiProperty({ type: 'boolean' })
  canProduce!: boolean;
}

/** One voucher in a list page (ADR-022). */
export class ProductionVoucherListItemDto extends PickType(ProductionVoucherRow, [
  'id',
  'docNo',
  'status',
  'voucherDate',
  'itemId',
  'bomId',
  'qty',
  'itemUnitId',
  'qtyBase',
  'materialsWarehouseId',
  'outputWarehouseId',
  'materialsTotal',
  'appliedTotal',
  'outputTotal',
  'reversalOfId',
  'postedAt',
  'createdAt',
  'updatedAt',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  item!: BomItemRefDto;

  /** Null when the quantity is in the base unit. */
  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  itemUnit!: BomItemUnitRefDto | null;

  @ApiProperty({ type: () => ProductionBomRefDto })
  bom!: ProductionBomRefDto;

  @ApiProperty({ type: () => ProductionWarehouseRefDto })
  materialsWarehouse!: ProductionWarehouseRefDto;

  @ApiProperty({ type: () => ProductionWarehouseRefDto })
  outputWarehouse!: ProductionWarehouseRefDto;
}

/** One consumption line with its standard, its cost once posted and its shortage while a draft. */
export class ProductionVoucherLineDetailDto extends PickType(ProductionVoucherLineRow, [
  'id',
  'lineNo',
  'itemId',
  'itemUnitId',
  'qty',
  'qtyBase',
  'standardQtyBase',
  'unitCost',
  'totalCost',
  'note',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  item!: BomItemRefDto;

  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  itemUnit!: BomItemUnitRefDto | null;

  /** Null once posted, and on a line of a posted voucher. */
  @ApiProperty({ type: () => ProductionShortageDto, nullable: true })
  shortage!: ProductionShortageDto | null;
}

/** A journal entry as a short reference (number and id). */
class ProductionJournalRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  entryNo!: string;
}

/** Another voucher as a short reference: a reversal, or the vouchers reversing this one. */
class ProductionVoucherRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', nullable: true })
  docNo!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'POSTED'] })
  status!: 'DRAFT' | 'POSTED';
}

class ProductionCostCentreRefDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string' })
  nameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  nameEn!: string | null;
}

/** One voucher with its lines and references (get, create, update, post, reverse). */
export class ProductionVoucherDetailDto extends PickType(ProductionVoucherRow, [
  'id',
  'docNo',
  'status',
  'voucherDate',
  'itemId',
  'bomId',
  'qty',
  'itemUnitId',
  'qtyBase',
  'materialsWarehouseId',
  'outputWarehouseId',
  'branchId',
  'costCenterId',
  'description',
  'appliedCostPerUnit',
  'appliedTotal',
  'materialsTotal',
  'outputTotal',
  'outputUnitCost',
  'journalEntryId',
  'reversalOfId',
  'postedAt',
  'createdAt',
  'updatedAt',
] as const) {
  @ApiProperty({ type: () => BomItemRefDto })
  item!: BomItemRefDto;

  @ApiProperty({ type: () => BomItemUnitRefDto, nullable: true })
  itemUnit!: BomItemUnitRefDto | null;

  @ApiProperty({ type: () => ProductionBomRefDto })
  bom!: ProductionBomRefDto;

  @ApiProperty({ type: () => ProductionWarehouseRefDto })
  materialsWarehouse!: ProductionWarehouseRefDto;

  @ApiProperty({ type: () => ProductionWarehouseRefDto })
  outputWarehouse!: ProductionWarehouseRefDto;

  @ApiProperty({ type: () => ProductionCostCentreRefDto, nullable: true })
  costCenter!: ProductionCostCentreRefDto | null;

  @ApiProperty({ type: () => ProductionVoucherLineDetailDto, isArray: true })
  lines!: ProductionVoucherLineDetailDto[];

  @ApiProperty({ type: () => ProductionJournalRefDto, nullable: true })
  journalEntry!: ProductionJournalRefDto | null;

  @ApiProperty({ type: () => ProductionVoucherRefDto, nullable: true })
  reversalOf!: ProductionVoucherRefDto | null;

  @ApiProperty({ type: () => ProductionVoucherRefDto, isArray: true })
  reversals!: ProductionVoucherRefDto[];
}
