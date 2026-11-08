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
  ValidateNested,
} from 'class-validator';

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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
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
}
