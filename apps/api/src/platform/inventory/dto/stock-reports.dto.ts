import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

// The web sends empty strings for unset filters, so '' is accepted everywhere.
// @ApiPropertyOptional keeps these filters in the OpenAPI document (and so in
// the generated api-client) now that the routes take a DTO instead of @Query('x').
const OPTIONAL_ID = /^(\d+)?$/;
const OPTIONAL_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

export class StockBalancesQueryDto extends ExportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  itemId?: string;

  /** 'true' → only items whose total over all warehouses is below their minimum. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  lowStock?: string;
}

export class ItemLedgerQueryDto extends ExportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sourceType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  to?: string;
}

export class ItemBalancesQueryDto extends ExportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_DATE)
  to?: string;
}

export class StockValuationQueryDto extends ExportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;
}
