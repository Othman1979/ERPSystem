import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, Matches } from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';
import { ITEM_KINDS } from '../../../common/inventory/item-kind.js';

/** The web sends '' for a filter it does not set: a blank value counts as not given. */
const blankToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

const DOCUMENT_STATUSES = ['DRAFT', 'POSTED'] as const;
/** A physical count also has SUBMITTED (ADR-030 §5). */
const COUNT_STATUSES = ['DRAFT', 'SUBMITTED', 'POSTED'] as const;
const ADJUSTMENT_TYPES = ['OPENING', 'IN', 'OUT', 'COUNT_ADJUSTMENT'] as const;
const NOTE_TYPES = ['GRN', 'GIN'] as const;


/** Sort keys of a stock document list: its document date and its number. */
export const STOCK_DOCUMENT_SORT_KEYS = ['date', 'docNo'] as const;
export const STOCK_DOCUMENT_SORTS = sortValues(STOCK_DOCUMENT_SORT_KEYS);

/** Sort keys of the item list (master data). */
export const ITEM_SORT_KEYS = ['code', 'nameAr'] as const;
export const ITEM_SORTS = sortValues(ITEM_SORT_KEYS);

/**
 * Filters shared by the stock document lists and goods notes (ADR-022 §2):
 * the document date range, the status, and `q` (inherited) on the document
 * number and description.
 */
export class StockDocumentListQueryDto extends PageQueryDto {
  @SortParam(STOCK_DOCUMENT_SORTS, '-date')
  sort?: (typeof STOCK_DOCUMENT_SORTS)[number];

  /** Document date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Document date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}

/** GET /stock-adjustments (ADR-022). */
export class ListStockAdjustmentsQueryDto extends StockDocumentListQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: (typeof DOCUMENT_STATUSES)[number];

  @ApiPropertyOptional({ enum: ADJUSTMENT_TYPES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(ADJUSTMENT_TYPES)
  adjustmentType?: (typeof ADJUSTMENT_TYPES)[number];

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  warehouseId?: string;
}

/** GET /stock-transfers (ADR-022): `warehouseId` matches the source or the destination. */
export class ListStockTransfersQueryDto extends StockDocumentListQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: (typeof DOCUMENT_STATUSES)[number];

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  warehouseId?: string;
}

/** GET /stock-counts (ADR-022). */
export class ListStockCountsQueryDto extends StockDocumentListQueryDto {
  @ApiPropertyOptional({ enum: COUNT_STATUSES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(COUNT_STATUSES)
  status?: (typeof COUNT_STATUSES)[number];

  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  warehouseId?: string;
}

/** GET /goods-notes (ADR-022): note type on top of the shared stock document filters. */
export class ListGoodsNotesQueryDto extends StockDocumentListQueryDto {
  @ApiPropertyOptional({ enum: DOCUMENT_STATUSES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(DOCUMENT_STATUSES)
  status?: (typeof DOCUMENT_STATUSES)[number];

  @ApiPropertyOptional({ enum: NOTE_TYPES })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(NOTE_TYPES)
  noteType?: (typeof NOTE_TYPES)[number];

  /** The receipts of one purchase order (ADR-026 §5). */
  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  purchaseOrderId?: string;

  /** The issues of one issue request (ADR-026 §9). */
  @ApiPropertyOptional()
  @Transform(blankToUndefined)
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  issueRequestId?: string;
}

/**
 * GET /items (ADR-022). Master data: not limited to the caller's branches.
 * `q` matches the code and both names.
 */
export class ListItemsQueryDto extends PageQueryDto {
  @SortParam(ITEM_SORTS, 'code')
  sort?: (typeof ITEM_SORTS)[number];

  @ApiPropertyOptional({ enum: ITEM_KINDS })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(ITEM_KINDS)
  itemKind?: (typeof ITEM_KINDS)[number];

  /** `true`: only the stocked kinds, STOCK and MANUFACTURED (ADR-031 §1), for the stock pickers. */
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(['true', 'false'])
  stocked?: 'true' | 'false';

  /** `true`: the kinds a purchase document takes, all but RECIPE (ADR-032 §5), for the purchase pickers. */
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(['true', 'false'])
  purchasable?: 'true' | 'false';

  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @Transform(blankToUndefined)
  @IsOptional()
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';
}
