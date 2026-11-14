import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { DATE_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { KeysetQueryDto } from '../../../common/paging/page-query.dto.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

// The web sends empty strings for unset filters, so '' is accepted everywhere.
// @ApiPropertyOptional keeps these filters in the OpenAPI document (and so in
// the generated api-client) now that the routes take a DTO instead of @Query('x').
const OPTIONAL_ID = /^(\d+)?$/;
const OPTIONAL_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

/**
 * The sourceType values stock_movements is written with (each stock document
 * posts under its own type; REVALUATION is the write-off/revaluation row of
 * StockLedgerService). A filter outside this list is a 400 VALIDATION.
 */
export const STOCK_SOURCE_TYPES = [
  'GOODS_RECEIPT',
  'GOODS_ISSUE',
  'PURCHASE_INVOICE',
  'PURCHASE_RETURN',
  'REVALUATION',
  'SALES_INVOICE',
  'SALES_RETURN',
  'STOCK_ADJUSTMENT',
  'STOCK_TRANSFER',
] as const;

/** Optional sourceType filter: '' means "not given" (the web sends it empty). */
const optionalSourceType = () =>
  applyDecorators(
    ApiPropertyOptional({ enum: STOCK_SOURCE_TYPES }),
    IsOptional(),
    ValidateIf((_, value: unknown) => value !== ''),
    IsIn(STOCK_SOURCE_TYPES),
    MaxLength(30),
  ) as PropertyDecorator;

/**
 * Movement ledger (ADR-022 §4): a keyset read, newest first. `limit` and
 * `cursor` come from KeysetQueryDto. An empty filter means "not given".
 */
export class StockMovementsQueryDto extends KeysetQueryDto {
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

  @optionalSourceType()
  sourceType?: string;

  /** Movement date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== '')
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Movement date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== '')
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}

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

/**
 * Item card (ADR-022 §4): a keyset read in ascending order. `limit` and
 * `cursor` come from KeysetQueryDto. `format` and `lang` are ExportQueryDto's
 * (kept here because a class extends only one base): pdf and xlsx read the
 * whole card instead and ignore the keyset parameters (ADR-022 §6).
 */
export class ItemLedgerQueryDto extends KeysetQueryDto {
  @IsOptional()
  @IsIn(['json', 'pdf', 'xlsx'])
  format?: 'json' | 'pdf' | 'xlsx';

  @IsOptional()
  @IsIn(['ar', 'en'])
  lang?: 'ar' | 'en';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(OPTIONAL_ID)
  warehouseId?: string;

  @optionalSourceType()
  sourceType?: string;

  /** Movement date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== '')
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Movement date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((_, value: unknown) => value !== '')
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
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
