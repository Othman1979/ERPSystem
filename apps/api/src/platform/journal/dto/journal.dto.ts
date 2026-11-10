import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER'] as const;
const VOUCHER_TYPES = ['JOURNAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER'] as const;

export class JournalLineDto {
  @IsString()
  accountId!: string;

  /** Debit amount (string decimal, e.g. "10.500"). Exactly one of debit/credit > 0. */
  @IsOptional()
  @IsString()
  debit?: string;

  @IsOptional()
  @IsString()
  credit?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}

export class CreateJournalEntryDto {
  @IsDateString()
  entryDate!: string;

  /** JOURNAL = plain journal; RECEIPT/PAYMENT = cash-bank vouchers (سند قبض/صرف). */
  @IsOptional()
  @IsIn(VOUCHER_TYPES)
  voucherType?: (typeof VOUCHER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  branchId?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class ReverseJournalEntryDto {
  @IsDateString()
  reversalDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class OpeningLineDto {
  @IsString()
  accountId!: string;

  @IsOptional()
  @IsString()
  debit?: string;

  @IsOptional()
  @IsString()
  credit?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateOpeningEntryDto {
  @IsDateString()
  entryDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OpeningLineDto)
  lines!: OpeningLineDto[];
}

export class ReportQueryDto extends ExportQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @IsString()
  partyId?: string;
}
