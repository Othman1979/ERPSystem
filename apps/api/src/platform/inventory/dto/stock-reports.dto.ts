import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';
import { DATE_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { KeysetQueryDto } from '../../../common/paging/page-query.dto.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

// The web sends empty strings for unset filters, so '' is accepted everywhere.
// @ApiPropertyOptional keeps these filters in the OpenAPI document (and so in
// the generated api-client) now that the routes take a DTO instead of @Query('x').
const OPTIONAL_ID = /^(\d+)?$/;
const OPTIONAL_DATE = /^(\d{4}-\d{2}-\d{2})?$/;

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

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
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
