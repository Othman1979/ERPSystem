import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

const PAYMENT_TYPES = ['CASH', 'CREDIT'] as const;
const DECIMAL = /^\d+(\.\d{1,6})?$/;
const MONEY = /^\d+(\.\d{1,3})?$/;
const INT_STRING = /^\d+$/;

export class SalesInvoiceLineDto {
  @IsString()
  @Matches(INT_STRING)
  itemId!: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  itemUnitId?: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  @IsString()
  @Matches(MONEY)
  unitPrice!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  taxCategoryId?: string;
}

export class CreateSalesInvoiceDto {
  @IsDateString()
  invoiceDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsString()
  @Matches(INT_STRING)
  customerId!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

  @IsIn(PAYMENT_TYPES)
  paymentType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesInvoiceLineDto)
  lines!: SalesInvoiceLineDto[];
}

export class SalesReturnLineDto {
  @IsString()
  @Matches(INT_STRING)
  originalLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

export class CreateSalesReturnDto {
  @IsDateString()
  returnDate!: string;

  @IsString()
  @Matches(INT_STRING)
  originalInvoiceId!: string;

  @IsIn(PAYMENT_TYPES)
  refundType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => SalesReturnLineDto)
  lines!: SalesReturnLineDto[];
}

export const SALES_INVOICE_SORT_KEYS = ['invoiceDate', 'invoiceNo', 'grandTotal'] as const;
export const SALES_INVOICE_SORTS = sortValues(SALES_INVOICE_SORT_KEYS);

/**
 * GET /sales-invoices (ADR-022 §2): a numbered page, newest first by default.
 * `q` matches the invoice number and the customer's code and names.
 */
export class ListSalesInvoicesQueryDto extends PageQueryDto {
  @SortParam(SALES_INVOICE_SORTS, '-invoiceDate')
  sort?: (typeof SALES_INVOICE_SORTS)[number];

  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'POSTED'])
  status?: 'DRAFT' | 'POSTED';

  @ApiPropertyOptional({ enum: PAYMENT_TYPES })
  @IsOptional()
  @IsIn(PAYMENT_TYPES)
  paymentType?: (typeof PAYMENT_TYPES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  customerId?: string;

  /** Invoice date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Invoice date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;

  /**
   * `true`: posted credit invoices that still owe something (grand total above
   * the paid amount), for the allocation picker. An invoice settled only by
   * credit returns can still be listed, with `outstanding` 0.
   */
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  open?: 'true' | 'false';
}

export const SALES_RETURN_SORT_KEYS = ['returnDate', 'returnNo', 'grandTotal'] as const;
export const SALES_RETURN_SORTS = sortValues(SALES_RETURN_SORT_KEYS);

/**
 * GET /sales-returns (ADR-022 §2): a numbered page, newest first by default.
 * `q` matches the return number, the original invoice number and the customer's code and names.
 */
export class ListSalesReturnsQueryDto extends PageQueryDto {
  @SortParam(SALES_RETURN_SORTS, '-returnDate')
  sort?: (typeof SALES_RETURN_SORTS)[number];

  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'POSTED'])
  status?: 'DRAFT' | 'POSTED';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  customerId?: string;

  /** Return date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Return date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}
