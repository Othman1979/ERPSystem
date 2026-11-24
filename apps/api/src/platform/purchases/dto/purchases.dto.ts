import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
const INT_STRING = /^\d+$/;
/** A unit cost: at most 12 integer digits and 6 decimals, the range of DECIMAL(18, 6), so a 400 and never a 500. */
const UNIT_COST = /^\d{1,12}(\.\d{1,6})?$/;

export class PurchaseInvoiceLineDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  itemId?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  itemUnitId?: string;

  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  /** Price per unit, up to 12 integer digits and 6 decimals (an order price, ADR-026 §5; CLAUDE.md unit costs). */
  @IsString()
  @Matches(UNIT_COST)
  @IsOptional()
  unitCost?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(UNIT_COST)
  unitPrice?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  consignmentSaleId?: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  taxCategoryId?: string;

  /**
   * ADR-026 §7: the GRN line of the invoice's purchase order this line bills
   * (an invoice with purchaseOrderId; every stocked line names one, in base units).
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  grnLineId?: string;
}

export class CreatePurchaseInvoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  consignmentSettlement?: boolean;

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

  /**
   * Cost centre of the document (ADR-024 §1.2): an active leaf of the company,
   * copied onto every income-statement line of its entry.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  costCenterId?: string;

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

  /**
   * ADR-026 §3/§7: the purchase order whose posted receipts this invoice
   * bills: its supplier and warehouse, every stocked line naming a GRN line
   * of the order. Set at creation, never changed; not with receivedGrnId.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  purchaseOrderId?: string;
}

/** One received line billed: its base quantity and price (ADR-026 §7). */
export class BillLineDto {
  @IsString()
  @Matches(INT_STRING)
  grnLineId!: string;

  /** Base quantity, within what is received and not billed yet. */
  @IsString()
  @Matches(DECIMAL)
  qty!: string;

  /** The supplier's price per base unit (the order's by default, GET …/billable); 12 integer digits, 6 decimals at most. */
  @IsString()
  @Matches(UNIT_COST)
  unitCost!: string;

  @IsOptional()
  @Matches(/^\d+(\.\d{1,4})?$/)
  discountPct?: string;
}

/**
 * POST /purchase-orders/:id/bill: a draft purchase invoice from the order's
 * posted receipts (ADR-026 §7), with the order's supplier, warehouse and
 * cost centre (unless another is given).
 */
export class BillPurchaseOrderDto {
  @IsDateString()
  invoiceDate!: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  supplierInvoiceNo?: string;

  @IsOptional()
  @IsDateString()
  supplierInvoiceDate?: string;

  @IsIn(PAYMENT_TYPES)
  paymentType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  costCenterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BillLineDto)
  lines!: BillLineDto[];
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

  /**
   * The warehouse the goods leave from: the original invoice's (ADR-016 §5).
   * Omitted, it is taken from the invoice; another one is refused. A
   * service-only invoice has none, so its return names none either.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  warehouseId?: string;

  @IsIn(PAYMENT_TYPES)
  refundType!: (typeof PAYMENT_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  cashAccountId?: string;

  /**
   * Cost centre of the document (ADR-024 §1.2): an active leaf of the company,
   * copied onto every income-statement line of its entry.
   */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  costCenterId?: string;

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

  /** The invoices of one purchase order (ADR-026 §7). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  purchaseOrderId?: string;

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
