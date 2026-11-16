import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { OmitType } from '@nestjs/swagger';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto } from '../../../common/paging/page-query.dto.js';
import { QTY_PATTERN } from './bom.dto.js';

/** The web sends '' for a filter it does not set: a blank value counts as not given. */
const blankToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

export const PRODUCTION_STATUSES = ['DRAFT', 'POSTED'] as const;
/** Consumption lines per voucher (a loose ceiling, as for a BOM). */
export const MAX_PRODUCTION_LINES = 200;

/**
 * One consumed component line (ADR-031 §3): the actual quantity in the line's
 * unit. Quantities are strings (CLAUDE.md money rules).
 */
export class ProductionLineDto {
  @IsString()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemId!: string;

  /** Absent: the component's base unit. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemUnitId?: string;

  @Matches(QTY_PATTERN, { message: '$property must be a quantity with up to 6 decimals' })
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateProductionVoucherDto {
  @IsString()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemId!: string;

  /** Absent: the item's ACTIVE version. Given: that version, ACTIVE or INACTIVE (never a draft). */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  bomId?: string;

  /** The produced quantity in itemUnitId (or the base unit when absent). */
  @Matches(QTY_PATTERN, { message: '$property must be a quantity with up to 6 decimals' })
  qty!: string;

  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemUnitId?: string;

  @IsString()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  materialsWarehouseId!: string;

  /** Absent: the materials warehouse (ADR-031 §7). */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  outputWarehouseId?: string;

  @Matches(DATE_PATTERN, { message: '$property must be a date (yyyy-mm-dd)' })
  voucherDate!: string;

  /** Cost centre of the applied-cost journal line only (ADR-031 §7). */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  costCenterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * The actual consumption (ADR-031 §3). Absent: the standard requirements of
   * the version, in the components' line units.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PRODUCTION_LINES)
  @ValidateNested({ each: true })
  @Type(() => ProductionLineDto)
  lines?: ProductionLineDto[];
}

/** A draft is replaced as a whole: the item stays the one it was created for. */
export class UpdateProductionVoucherDto extends OmitType(CreateProductionVoucherDto, ['itemId'] as const) {}

export class ListProductionVouchersQueryDto extends PageQueryDto {
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(PRODUCTION_STATUSES)
  status?: (typeof PRODUCTION_STATUSES)[number];

  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemId?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(DATE_PATTERN, { message: '$property must be a date (yyyy-mm-dd)' })
  from?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(DATE_PATTERN, { message: '$property must be a date (yyyy-mm-dd)' })
  to?: string;
}
