import { ApiPropertyOptional, IntersectionType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';
import { KeysetQueryDto, PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';
import {
  AMOUNT_PATTERN,
  DATE_PATTERN,
  ID_PATTERN,
} from '../../../common/pipes/parse-id.pipe.js';

const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER'] as const;
const VOUCHER_TYPES = ['JOURNAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER'] as const;

export class JournalLineDto {
  @IsString()
  @Matches(ID_PATTERN, { message: 'accountId must be a positive integer id' })
  accountId!: string;

  /** Debit amount (string decimal, e.g. "10.500"). Exactly one of debit/credit > 0. */
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: '$property must be a positive amount with at most 3 decimals' })
  debit?: string;

  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: '$property must be a positive amount with at most 3 decimals' })
  credit?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: 'partyId must be a positive integer id' })
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

}

export class CreateJournalEntryDto {
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  entryDate!: string;

  /** JOURNAL = plain journal; RECEIPT/PAYMENT = cash-bank vouchers (سند قبض/صرف). */
  @IsOptional()
  @IsIn(VOUCHER_TYPES)
  voucherType?: (typeof VOUCHER_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;


  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}

export class ReverseJournalEntryDto {
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  reversalDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class OpeningLineDto {
  @IsString()
  @Matches(ID_PATTERN, { message: 'accountId must be a positive integer id' })
  accountId!: string;

  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: '$property must be a positive amount with at most 3 decimals' })
  debit?: string;

  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN, { message: '$property must be a positive amount with at most 3 decimals' })
  credit?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number] | null;

  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN, { message: 'partyId must be a positive integer id' })
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class CreateOpeningEntryDto {
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
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
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;

  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  accountId?: string;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: (typeof PARTY_TYPES)[number];

  @IsOptional()
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
  partyId?: string;
}

/**
 * Account statement and party statement (ADR-022 §4): the report filters plus
 * `limit` / `cursor` for the JSON pages. PDF / XLSX ignore `limit` and `cursor`.
 */
export class StatementQueryDto extends IntersectionType(ReportQueryDto, KeysetQueryDto) {}

export const JOURNAL_SORT_KEYS = ['entryDate', 'entryNo'] as const;
export const JOURNAL_SORTS = sortValues(JOURNAL_SORT_KEYS);
const JOURNAL_SOURCES = ['MANUAL_JOURNAL', 'OPENING_ENTRY'] as const;

/**
 * GET /journal-entries (ADR-022 §2, LEDGER-08): a numbered page, newest first.
 * `q` matches the entry number and the description.
 */
export class ListJournalEntriesQueryDto extends PageQueryDto {
  @SortParam(JOURNAL_SORTS, '-entryDate')
  sort?: (typeof JOURNAL_SORTS)[number];

  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'POSTED'])
  status?: 'DRAFT' | 'POSTED';

  @ApiPropertyOptional({ enum: VOUCHER_TYPES })
  @IsOptional()
  @IsIn(VOUCHER_TYPES)
  voucherType?: (typeof VOUCHER_TYPES)[number];

  /** MANUAL_JOURNAL or OPENING_ENTRY (the opening balances screen). */
  @ApiPropertyOptional({ enum: JOURNAL_SOURCES })
  @IsOptional()
  @IsIn(JOURNAL_SOURCES)
  sourceType?: (typeof JOURNAL_SOURCES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}
