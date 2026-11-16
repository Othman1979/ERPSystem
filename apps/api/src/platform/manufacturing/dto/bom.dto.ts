import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { OmitType } from '@nestjs/swagger';
import { AMOUNT_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto } from '../../../common/paging/page-query.dto.js';

/** The web sends '' for a filter it does not set: a blank value counts as not given. */
const blankToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** A quantity: up to 12 digits and 6 decimals (ADR-031 §10). */
export const QTY_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
/** A waste percentage: 0 to 100 with 4 decimals; the 0–100 range is checked in the service. */
export const WASTE_PATTERN = /^\d{1,3}(\.\d{1,4})?$/;
/** Lines per version (a loose ceiling; a real BOM is far smaller). */
export const MAX_BOM_LINES = 200;

export const BOM_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE'] as const;

/** One component line. Quantities are strings (CLAUDE.md money rules). */
export class BomLineDto {
  @IsString()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  componentItemId!: string;

  /** Absent: the item's base unit (no item unit row). */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemUnitId?: string;

  /** Quantity per output batch, in itemUnitId (or the base unit). */
  @Matches(QTY_PATTERN, { message: '$property must be a quantity with up to 6 decimals' })
  qty!: string;

  /** Extra consumption in percent (ADR-031 §5); defaults to 0. */
  @IsOptional()
  @Matches(WASTE_PATTERN, { message: '$property must be a percentage with up to 4 decimals' })
  wastePct?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateBomDto {
  @IsString()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemId!: string;

  /** The output quantity as entered, e.g. 10 for «تنتج 10 كراسٍ». */
  @Matches(QTY_PATTERN, { message: '$property must be a quantity with up to 6 decimals' })
  outputQty!: string;

  /** Absent: the item's base unit. */
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  outputItemUnitId?: string;

  /** Fixed applied cost per output batch (ADR-031 §2); defaults to 0. */
  @IsOptional()
  @Matches(AMOUNT_PATTERN, { message: '$property must be an amount with up to 3 decimals' })
  appliedCostPerUnit?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BOM_LINES)
  @ValidateNested({ each: true })
  @Type(() => BomLineDto)
  lines!: BomLineDto[];
}

/** A draft is replaced as a whole: the item stays the one it was created for. */
export class UpdateBomDto extends OmitType(CreateBomDto, ['itemId'] as const) {}

export class ListBomsQueryDto extends PageQueryDto {
  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  itemId?: string;

  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(BOM_STATUSES)
  status?: (typeof BOM_STATUSES)[number];
}

/** `?qty=` on the requirements preview: the quantity to produce, in the BOM's output unit. */
export class BomRequirementsQueryDto {
  @Matches(QTY_PATTERN, { message: '$property must be a quantity with up to 6 decimals' })
  qty!: string;
}
