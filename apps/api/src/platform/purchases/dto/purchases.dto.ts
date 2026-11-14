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

export class PurchaseInvoiceLineDto {
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
  unitCost!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  taxCategoryId?: string;
}

export class CreatePurchaseInvoiceDto {
  @IsDateString()
  invoiceDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsString()
  @Matches(INT_STRING)
  supplierId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNo?: string;

  @IsOptional()
  @IsDateString()
  supplierInvoiceDate?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  warehouseId?: string;

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
  @Type(() => PurchaseInvoiceLineDto)
  lines!: PurchaseInvoiceLineDto[];

  /**
   * A posted goods receipt note (GRN) this invoice bills (TRADE-02, ADR-016):
   * its stock lines then clear account 2104 instead of receiving the goods a
   * second time. A GRN is billed by one invoice only.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  receivedGrnId?: string;
}

export class PurchaseReturnLineDto {
  @IsString()
  @Matches(INT_STRING)
  originalLineId!: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;
}

export class CreatePurchaseReturnDto {
  @IsDateString()
  returnDate!: string;

  @IsString()
  @Matches(INT_STRING)
  originalInvoiceId!: string;

  @IsString()
  @Matches(INT_STRING)
  warehouseId!: string;

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
  @Type(() => PurchaseReturnLineDto)
  lines!: PurchaseReturnLineDto[];
}

export const PURCHASE_INVOICE_SORT_KEYS = ['invoiceDate', 'invoiceNo', 'grandTotal'] as const;
export const PURCHASE_INVOICE_SORTS = sortValues(PURCHASE_INVOICE_SORT_KEYS);

/**
 * GET /purchase-invoices (ADR-022 §2): a numbered page, newest first by default.
 * `q` matches the invoice number, the supplier's invoice number and the supplier's code and names.
 */
export class ListPurchaseInvoicesQueryDto extends PageQueryDto {
  @SortParam(PURCHASE_INVOICE_SORTS, '-invoiceDate')
  sort?: (typeof PURCHASE_INVOICE_SORTS)[number];

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
  supplierId?: string;

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
   * the paid amount), for the allocation picker.
   */
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  open?: 'true' | 'false';
}

export const PURCHASE_RETURN_SORT_KEYS = ['returnDate', 'returnNo', 'grandTotal'] as const;
export const PURCHASE_RETURN_SORTS = sortValues(PURCHASE_RETURN_SORT_KEYS);

/**
 * GET /purchase-returns (ADR-022 §2): a numbered page, newest first by default.
 * `q` matches the return number, the original invoice number and the supplier's code and names.
 */
export class ListPurchaseReturnsQueryDto extends PageQueryDto {
  @SortParam(PURCHASE_RETURN_SORTS, '-returnDate')
  sort?: (typeof PURCHASE_RETURN_SORTS)[number];

  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'POSTED'])
  status?: 'DRAFT' | 'POSTED';

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  supplierId?: string;

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
