import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

/** Quantities and unit prices: up to 6 decimals (CLAUDE.md «المال والأرقام»). */
const QTY = /^\d{1,12}(\.\d{1,6})?$/;
const PRICE = /^\d{1,12}(\.\d{1,6})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const ID_MESSAGE = { message: '$property must be a positive integer id' };
const DATE_MESSAGE = { message: '$property must be a yyyy-mm-dd date' };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** A written reason (reject, cancel): 1 to 500 characters after trimming. */
export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

// --------------------------------------------------------- purchase requests

export class PurchaseRequestLineDto {
  @Matches(ID_PATTERN, ID_MESSAGE)
  itemId!: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  itemUnitId?: string;

  /** In the line's unit (the item's base unit without itemUnitId). */
  @IsString()
  @Matches(QTY)
  qty!: string;

  /** Optional estimate per unit; not binding (ADR-025 §2). */
  @IsOptional()
  @IsString()
  @Matches(PRICE)
  estimatedPrice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreatePurchaseRequestDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  requestDate!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  neededBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseRequestLineDto)
  lines!: PurchaseRequestLineDto[];
}

export const PURCHASE_REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'] as const;
export const PURCHASE_REQUEST_SORTS = sortValues(['requestDate', 'requestNo'] as const);

/** GET /purchase-requests: a numbered page, newest first; `q` matches the number and the notes. */
export class ListPurchaseRequestsQueryDto extends PageQueryDto {
  @SortParam(PURCHASE_REQUEST_SORTS, '-requestDate')
  sort?: (typeof PURCHASE_REQUEST_SORTS)[number];

  @ApiPropertyOptional({ enum: PURCHASE_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(PURCHASE_REQUEST_STATUSES)
  status?: (typeof PURCHASE_REQUEST_STATUSES)[number];

  /** Request date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from?: string;

  /** Request date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to?: string;
}

// ---------------------------------------------------- requests for quotation

export class PurchaseQuoteLineInputDto {
  /** A line of the quote's request. */
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestLineId!: string;

  /** In the request line's unit; omitted: what is left to order on it. */
  @IsOptional()
  @IsString()
  @Matches(QTY)
  qty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class UpdatePurchaseQuoteDto {
  @Matches(ID_PATTERN, ID_MESSAGE)
  supplierId!: string;

  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  quoteDate!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  validUntil?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /** Omitted on create: every request line with something left to order. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseQuoteLineInputDto)
  lines?: PurchaseQuoteLineInputDto[];
}

export class CreatePurchaseQuoteDto extends UpdatePurchaseQuoteDto {
  /** An approved purchase request. */
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestId!: string;
}

export class ReceivedQuoteLineDto {
  /** A line of this quote. */
  @Matches(ID_PATTERN, ID_MESSAGE)
  lineId!: string;

  /** Per unit of the line, in the company's base currency; tax-inclusive when the company enters prices so (ADR-017). */
  @IsString()
  @Matches(PRICE)
  unitPrice!: string;

  @IsOptional()
  @IsString()
  @Matches(PERCENT)
  discountPct?: string;
}

/** The supplier's answer: a price for every line of the quote. */
export class ReceivePurchaseQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierRef?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  validUntil?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceivedQuoteLineDto)
  lines!: ReceivedQuoteLineDto[];
}

export const PURCHASE_QUOTE_STATUSES = ['DRAFT', 'SENT', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const;
export const PURCHASE_QUOTE_SORTS = sortValues(['quoteDate', 'quoteNo', 'grandTotal'] as const);

/** GET /purchase-quotes: a numbered page, newest first; `q` matches the number and the supplier. */
export class ListPurchaseQuotesQueryDto extends PageQueryDto {
  @SortParam(PURCHASE_QUOTE_SORTS, '-quoteDate')
  sort?: (typeof PURCHASE_QUOTE_SORTS)[number];

  @ApiPropertyOptional({ enum: PURCHASE_QUOTE_STATUSES })
  @IsOptional()
  @IsIn(PURCHASE_QUOTE_STATUSES)
  status?: (typeof PURCHASE_QUOTE_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  supplierId?: string;
}

// ------------------------------------------------------------ purchase orders

export class PurchaseOrderLineDto {
  @Matches(ID_PATTERN, ID_MESSAGE)
  itemId!: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  itemUnitId?: string;

  @IsString()
  @Matches(QTY)
  qty!: string;

  /** Per unit of the line; tax-inclusive when the company enters prices so (ADR-017). */
  @IsString()
  @Matches(PRICE)
  unitPrice!: string;

  @IsOptional()
  @IsString()
  @Matches(PERCENT)
  discountPct?: string;

  /**
   * The request line this orders (required at FULL): same item and unit, and
   * no more than is left on it (ADR-025 §9).
   */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestLineId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreatePurchaseOrderDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  orderDate!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  expectedDate?: string;

  @Matches(ID_PATTERN, ID_MESSAGE)
  supplierId!: string;

  /** The receiving warehouse; the order's branch is its branch (ADR-025 §12). */
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId!: string;

  /** Optional cost centre (an active leaf), copied to the invoice in phase 13. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  /** The approved request it orders from: required at FULL, refused at MEDIUM (ADR-025 §1). Set at creation only. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  lines!: PurchaseOrderLineDto[];
}

/** A draft order's new content; its request stays the one it was created from. */
export class UpdatePurchaseOrderDto extends OmitType(CreatePurchaseOrderDto, ['requestId'] as const) {}

export class ConvertSelectionDto {
  /** A line of a received quote of this request: the supplier and price chosen for its request line. */
  @Matches(ID_PATTERN, ID_MESSAGE)
  quoteLineId!: string;

  /** Omitted: the quoted quantity, capped at what is left on the request line. */
  @IsOptional()
  @IsString()
  @Matches(QTY)
  qty?: string;
}

/** «Create orders» from the comparison: one draft order per chosen supplier (ADR-025 §10). */
export class ConvertPurchaseRequestDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  orderDate!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  expectedDate?: string;

  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId!: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ConvertSelectionDto)
  selections!: ConvertSelectionDto[];
}

export const PURCHASE_ORDER_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED'] as const;
export const PURCHASE_ORDER_SORTS = sortValues(['orderDate', 'orderNo', 'grandTotal'] as const);

/** GET /purchase-orders: a numbered page, newest first; `q` matches the number and the supplier. */
export class ListPurchaseOrdersQueryDto extends PageQueryDto {
  @SortParam(PURCHASE_ORDER_SORTS, '-orderDate')
  sort?: (typeof PURCHASE_ORDER_SORTS)[number];

  @ApiPropertyOptional({ enum: PURCHASE_ORDER_STATUSES })
  @IsOptional()
  @IsIn(PURCHASE_ORDER_STATUSES)
  status?: (typeof PURCHASE_ORDER_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  supplierId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  requestId?: string;

  /** Order date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from?: string;

  /** Order date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to?: string;
}
