import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsString, Matches, ValidateNested } from 'class-validator';

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

export class OpeningStockLineDto {
  @IsString()
  warehouseId!: string;

  /** Quantity in the item's base unit, > 0. */
  @Matches(DECIMAL)
  qty!: string;

  /** Cost per base unit. */
  @Matches(DECIMAL)
  unitCost!: string;
}

/** The item's whole opening stock, one line per warehouse; empty clears it. */
export class SetOpeningStockDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => OpeningStockLineDto)
  lines!: OpeningStockLineDto[];
}
