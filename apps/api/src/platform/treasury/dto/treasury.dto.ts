import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

const INT_STRING = /^\d+$/;
const MONEY = /^\d+(\.\d{1,3})?$/;
const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER'] as const;
const DOC_TYPES = ['SALES_INVOICE', 'PURCHASE_INVOICE'] as const;

export class CreateCashBoxDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  name!: string;

  @IsString()
  @Matches(INT_STRING)
  accountId!: string;

  /** The branch the box belongs to; absent = every branch (ADR-003). */
  @IsOptional()
  @Matches(INT_STRING)
  branchId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Update body (PUT /cash-boxes/:id): every field is optional, and an absent
 * field is unchanged. A null is refused for a field that cannot be cleared.
 */
export class UpdateCashBoxDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  name?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @Matches(INT_STRING)
  accountId?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;

  /** null puts the box on every branch again. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  branchId?: string | null;
}

export class CreateBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  bankName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNoMasked?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  ibanMasked?: string;

  @IsString()
  @Matches(INT_STRING)
  accountId!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Update body (PUT /bank-accounts/:id). A null clears accountNoMasked or
 * ibanMasked; the other fields cannot be cleared, so a null is refused.
 */
export class UpdateBankAccountDto {
  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  bankName?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNoMasked?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ibanMasked?: string | null;

  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsString()
  @Matches(INT_STRING)
  accountId?: string;

  @ApiPropertyOptional()
  @ValidateIf((_o, value: unknown) => value !== undefined)
  @IsBoolean()
  isActive?: boolean;
}

export class AllocationDto {
  @IsIn(DOC_TYPES)
  documentType!: (typeof DOC_TYPES)[number];

  @IsString()
  @Matches(INT_STRING)
  documentId!: string;

  @Matches(MONEY)
  amount!: string;
}

export class CreateReceiptDto {
  @IsDateString()
  receiptDate!: string;

  @IsIn(PARTY_TYPES)
  partyType!: (typeof PARTY_TYPES)[number];

  @IsString()
  @Matches(INT_STRING)
  partyId!: string;

  @IsString()
  @Matches(INT_STRING)
  cashAccountId!: string;

  @Matches(MONEY)
  amount!: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  paymentMethodId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  /** Allocate to the party's oldest open invoices (ignored when `allocations` is given). */
  @IsOptional()
  @IsBoolean()
  autoAllocate?: boolean;
}

export class CreatePaymentDto {
  @IsDateString()
  paymentDate!: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  partyId?: string;

  /** Required when no party (direct expense payment). */
  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  expenseAccountId?: string;

  @IsString()
  @Matches(INT_STRING)
  cashAccountId!: string;

  @Matches(MONEY)
  amount!: string;

  @IsOptional()
  @IsString()
  @Matches(INT_STRING)
  paymentMethodId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  /** Allocate to the party's oldest open invoices (ignored when `allocations` is given). */
  @IsOptional()
  @IsBoolean()
  autoAllocate?: boolean;
}

/** Allocate an existing voucher's unallocated amount (Phase 6). */
export class AllocateVoucherDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];

  /** Oldest open invoices first, up to the unallocated amount. */
  @IsOptional()
  @IsBoolean()
  auto?: boolean;
}

export class ReverseVoucherDto {
  @IsDateString()
  reversalDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateCashTransferDto {
  @IsDateString()
  transferDate!: string;

  /** Cash/bank account money leaves. */
  @IsString()
  @Matches(INT_STRING)
  fromAccountId!: string;

  /** Cash/bank account money arrives. */
  @IsString()
  @Matches(INT_STRING)
  toAccountId!: string;

  @Matches(MONEY)
  amount!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  referenceNo?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class AgingQueryDto extends ExportQueryDto {
  @IsIn(PARTY_TYPES)
  partyType!: (typeof PARTY_TYPES)[number];

  /** yyyy-mm-dd, inclusive; defaults to today (UTC). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  @IsDateString({ strict: true })
  asOf?: string;
}

export const RECEIPT_SORT_KEYS = ['receiptDate', 'receiptNo', 'amount'] as const;
export const RECEIPT_SORTS = sortValues(RECEIPT_SORT_KEYS);
export const PAYMENT_SORT_KEYS = ['paymentDate', 'paymentNo', 'amount'] as const;
export const PAYMENT_SORTS = sortValues(PAYMENT_SORT_KEYS);
export const CASH_TRANSFER_SORT_KEYS = ['transferDate', 'transferNo', 'amount'] as const;
export const CASH_TRANSFER_SORTS = sortValues(CASH_TRANSFER_SORT_KEYS);

/** Date range on a voucher's date (yyyy-mm-dd, inclusive) plus the numbered-page parameters. */
export class VoucherDateRangeQueryDto extends PageQueryDto {
  /** Voucher date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Voucher date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}

/**
 * GET /receipts (ADR-022 §2): a numbered page, newest first by default. `q`
 * matches the receipt number, the reference and the party's code and names.
 */
export class ListReceiptsQueryDto extends VoucherDateRangeQueryDto {
  @SortParam(RECEIPT_SORTS, '-receiptDate')
  sort?: (typeof RECEIPT_SORTS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  partyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  cashAccountId?: string;
}

/**
 * GET /payments (ADR-022 §2): a numbered page, newest first by default. `q`
 * matches the payment number, the reference and the party's code and names.
 */
export class ListPaymentsQueryDto extends VoucherDateRangeQueryDto {
  @SortParam(PAYMENT_SORTS, '-paymentDate')
  sort?: (typeof PAYMENT_SORTS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  partyId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  cashAccountId?: string;
}

/**
 * GET /cash-transfers (ADR-022 §2): a numbered page, newest first by default.
 * `q` matches the transfer number, the reference and the description.
 */
export class ListCashTransfersQueryDto extends VoucherDateRangeQueryDto {
  @SortParam(CASH_TRANSFER_SORTS, '-transferDate')
  sort?: (typeof CASH_TRANSFER_SORTS)[number];
}
