import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

/** Quantities and unit prices: up to 6 decimals (CLAUDE.md «المال والأرقام»). */
const QTY = /^\d{1,12}(\.\d{1,6})?$/;
const PRICE = /^\d{1,12}(\.\d{1,3})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const ID_MESSAGE = { message: '$property must be a positive integer id' };
const DATE_MESSAGE = { message: '$property must be a yyyy-mm-dd date' };
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** One line of a sales quote or order; amounts are computed by the server (ADR-027 §2). */
export class SalesLineDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** A quote's content (draft create and update share it, ADR-027 §2). */
export class SalesQuoteInputDto {
  /** Defaults to today when the quote is created. */
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  quoteDate?: string;

  /** Omitted: the company default (quote_validity_days) from the quote date; null: no expiry. */
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  validUntil?: string | null;

  @Matches(ID_PATTERN, ID_MESSAGE)
  customerId!: string;

  /** Optional: the warehouse the quote is for (its branch applies, ADR-003). */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId?: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SalesLineDto)
  lines!: SalesLineDto[];
}

export class CreateSalesQuoteDto extends SalesQuoteInputDto {}

export class UpdateSalesQuoteDto extends SalesQuoteInputDto {}

export const SALES_QUOTE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'] as const;
export const SALES_QUOTE_SORTS = sortValues(['quoteDate', 'quoteNo', 'grandTotal'] as const);

/** GET /sales-quotes: a numbered page, newest first; `q` matches the number and the customer. */
export class ListSalesQuotesQueryDto extends PageQueryDto {
  @SortParam(SALES_QUOTE_SORTS, '-quoteDate')
  sort?: (typeof SALES_QUOTE_SORTS)[number];

  @ApiPropertyOptional({ enum: SALES_QUOTE_STATUSES })
  @IsOptional()
  @IsIn(SALES_QUOTE_STATUSES)
  status?: (typeof SALES_QUOTE_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  customerId?: string;

  /** Quote date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from?: string;

  /** Quote date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to?: string;
}

/** Converting an accepted quote: the order's own warehouse and dates (ADR-027 §2). */
export class ConvertSalesQuoteDto {
  /** Required when the quote names no warehouse. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  orderDate?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  expectedDate?: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;
}

/** A sales order's content (ADR-027 §3). */
export class SalesOrderInputDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  orderDate!: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  expectedDate?: string;

  @Matches(ID_PATTERN, ID_MESSAGE)
  customerId!: string;

  /** The warehouse the goods leave from; the order's branch is its branch (ADR-003). */
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId!: string;

  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SalesLineDto)
  lines!: SalesLineDto[];
}

export class CreateSalesOrderDto extends SalesOrderInputDto {}

export class UpdateSalesOrderDto extends SalesOrderInputDto {}

export const SALES_ORDER_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PARTIALLY_INVOICED', 'INVOICED', 'CLOSED', 'CANCELLED'] as const;
export const SALES_ORDER_SORTS = sortValues(['orderDate', 'orderNo', 'grandTotal'] as const);

/** GET /sales-orders: a numbered page, newest first; `q` matches the number and the customer. */
export class ListSalesOrdersQueryDto extends PageQueryDto {
  @SortParam(SALES_ORDER_SORTS, '-orderDate')
  sort?: (typeof SALES_ORDER_SORTS)[number];

  @ApiPropertyOptional({ enum: SALES_ORDER_STATUSES })
  @IsOptional()
  @IsIn(SALES_ORDER_STATUSES)
  status?: (typeof SALES_ORDER_STATUSES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to?: string;
}

/** GET /sales-orders/reservation: reserved and available quantities of items in one warehouse (ADR-027 §5). */
export class SalesReservationQueryDto {
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId!: string;

  /** Comma-separated item ids, at most 500. */
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  itemIds!: string;
}

export { ReasonDto } from '../../procurement/dto/procurement.dto.js';

/** The invoice made from a sales order (ADR-027 §4): the order's own terms; the payment and dates are chosen here. */
export class CreateInvoiceFromOrderDto {
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  invoiceDate?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  dueDate?: string;

  /** Defaults to CREDIT. */
  @IsOptional()
  @IsIn(['CASH', 'CREDIT'])
  paymentType?: 'CASH' | 'CREDIT';

  /** Required for a cash invoice. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}
