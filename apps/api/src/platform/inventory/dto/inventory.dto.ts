import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ITEM_KINDS } from '../../../common/inventory/item-kind.js';


const ADJUSTMENT_TYPES = ['OPENING', 'IN', 'OUT', 'COUNT_ADJUSTMENT'] as const;

export class CreateItemGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

export class UpdateItemGroupDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ItemUnitInputDto {
  @IsString()
  unitId!: string;

  /** Units of this unit per ONE base unit (e.g. BOX=12 for PCS base). */
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  factorToBase!: string;

  @IsOptional()
  @IsBoolean()
  isDefaultSale?: boolean;

  @IsOptional()
  @IsBoolean()
  isDefaultPurchase?: boolean;
}

export class CreateItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  itemGroupId?: string;

  @IsOptional()
  @IsIn(ITEM_KINDS)
  itemKind?: (typeof ITEM_KINDS)[number];

  @IsString()
  baseUnitId!: string;

  @IsOptional()
  @IsString()
  taxCategoryId?: string;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  salePrice?: string;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  purchasePrice?: string;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  minStock?: string;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  maxStock?: string;

  @IsOptional()
  @IsString()
  defaultWarehouseId?: string;

  @IsOptional()
  @IsBoolean()
  salePriceIncludesTax?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ItemUnitInputDto)
  units?: ItemUnitInputDto[];
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  itemGroupId?: string | null;

  @IsOptional()
  @IsString()
  taxCategoryId?: string | null;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  salePrice?: string | null;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  purchasePrice?: string | null;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  minStock?: string;

  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  maxStock?: string | null;

  @IsOptional()
  @IsString()
  defaultWarehouseId?: string | null;

  @IsOptional()
  @IsBoolean()
  salePriceIncludesTax?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  imageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateWarehouseDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsOptional()
  @IsString()
  consignmentSupplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsString()
  branchId?: string | null;

  @IsOptional()
  @IsString()
  consignmentSupplierId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  address?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AdjustmentLineDto {
  @IsString()
  itemId!: string;

  /** Base-unit qty for IN lines; for OUT lines this is qty issued. */
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  qty!: string;

  /** Required for IN/OPENING lines; ignored for OUT. */
  @IsOptional()
  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  unitCost?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateStockAdjustmentDto {
  @IsDateString()
  adjustmentDate!: string;

  @IsIn(ADJUSTMENT_TYPES)
  adjustmentType!: (typeof ADJUSTMENT_TYPES)[number];

  @IsString()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentLineDto)
  lines!: AdjustmentLineDto[];
}

export class TransferLineDto {
  @IsString()
  itemId!: string;

  @Matches(/^[0-9]+(\.[0-9]+)?$/)
  qty!: string;
}

export class CreateStockTransferDto {
  @IsDateString()
  transferDate!: string;

  @IsString()
  fromWarehouseId!: string;

  @IsString()
  toWarehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  lines!: TransferLineDto[];
}

/** Scope of a physical count (ADR-030 §7). */
const COUNT_SCOPES = ['WAREHOUSE', 'GROUP', 'ITEMS'] as const;

export class CreateStockCountDto {
  @IsDateString()
  countDate!: string;

  @IsString()
  warehouseId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** A blind count hides the book qty and the difference until the count is submitted (ADR-030 §6). */
  @IsOptional()
  @IsBoolean()
  blind?: boolean;

  /** WAREHOUSE (default), GROUP (a group and its subgroups) or ITEMS (the chosen items). */
  @IsOptional()
  @IsIn(COUNT_SCOPES)
  scope?: (typeof COUNT_SCOPES)[number];

  /** GROUP scope: the group whose items are counted. */
  @IsOptional()
  @Matches(/^[1-9]\d{0,17}$/)
  itemGroupId?: string;

  /** ITEMS scope: the stock items to count. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @Matches(/^[1-9]\d{0,17}$/, { each: true })
  itemIds?: string[];

  /** WAREHOUSE scope: also count the stock items with no book balance at the count date. */
  @IsOptional()
  @IsBoolean()
  includeZero?: boolean;
}

/** A line added to a DRAFT count for an item found on the shelf (ADR-030 §7). */
export class AddCountLineDto {
  @Matches(/^[1-9]\d{0,17}$/)
  itemId!: string;
}

/** A barcode scanned in a DRAFT count (ADR-030 §9). */
export class ScanCountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  barcode!: string;
}

/**
 * The counted quantity of one line, in the unit given (ADR-030 §8). `countedQty`
 * null clears the line. Without `itemUnitId` the quantity is in the base unit.
 */
export class UpdateCountLineDto {
  @IsOptional()
  @Matches(/^[1-9]\d{0,17}$/)
  itemUnitId?: string;

  @Matches(/^[0-9]+(\.[0-9]+)?$/, { message: 'countedQty must be a non-negative number' })
  @IsOptional()
  countedQty!: string | null;
}

export class SetItemUnitsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ItemUnitInputDto)
  units!: ItemUnitInputDto[];
}

export class ReverseStockDocumentDto {
  @IsDateString()
  reversalDate!: string;
}

export class BarcodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  barcode!: string;

  @IsOptional()
  @IsString()
  itemUnitId?: string;
}

