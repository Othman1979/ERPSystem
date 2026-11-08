import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

const NOTE_TYPES = ['GRN', 'GIN'] as const;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MONEY = /^\d+(\.\d{1,3})?$/;
const INT_STRING = /^\d+$/;

export class GoodsNoteLineDto {
  @IsString()
  @Matches(INT_STRING)
  itemId!: string;

  /** Base-unit quantity. */
  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  /** Required for GRN (receipt cost per base unit); ignored for GIN. */
  @IsOptional()
  @Matches(MONEY)
  unitCost?: string;
}

export class CreateGoodsNoteDto {
  @IsDateString()
  noteDate!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

  @IsIn(NOTE_TYPES)
  noteType!: (typeof NOTE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsNoteLineDto)
  lines!: GoodsNoteLineDto[];
}
