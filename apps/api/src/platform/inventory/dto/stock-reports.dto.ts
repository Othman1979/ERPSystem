import { IsOptional, IsString, Matches } from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

// The web sends empty strings for unset filters, so '' is accepted everywhere.
const OPTIONAL_ID = /^(\d+)?$/;
const OPTIONAL_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

export class StockBalancesQueryDto extends ExportQueryDto {
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  itemId?: string;

  /** 'true' → only items whose total over all warehouses is below their minimum. */
  @IsOptional()
  @IsString()
  lowStock?: string;
}

export class ItemLedgerQueryDto extends ExportQueryDto {
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  to?: string;
}

export class StockValuationQueryDto extends ExportQueryDto {
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;
}
