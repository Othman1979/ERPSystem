import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { DATE_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

export const EINVOICE_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export const EINVOICE_TRACKS = ['INCOME', 'GENERAL_SALES'] as const;
export const EINVOICE_STATUSES = ['PENDING', 'SENDING', 'ACCEPTED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;

export class UpdateEInvoiceSettingsDto {
  /** Seller tax number (companies.tax_number, manual p.13): digits. */
  @IsOptional()
  @Matches(/^\d{1,50}$/)
  sellerTaxNumber?: string;

  /** Seller name as registered with ISTD (companies.legal_name_ar). */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(191)
  sellerName?: string;

  @IsIn(EINVOICE_ENVIRONMENTS)
  environment!: (typeof EINVOICE_ENVIRONMENTS)[number];

  /** SANDBOX only: the local mock, e.g. http://127.0.0.1:8080. Empty = that default. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  baseUrl?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  clientId?: string | null;

  /** Write-only. Empty or missing keeps the stored one; it is never returned. */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  secretKey?: string;

  /** Income source sequence from the portal (manual p.16): digits. */
  @IsOptional()
  @Matches(/^\d{0,50}$/)
  incomeSourceSequence?: string | null;

  @IsIn(EINVOICE_TRACKS)
  track!: (typeof EINVOICE_TRACKS)[number];

  @IsBoolean()
  isEnabled!: boolean;
}

export const EINVOICE_SUBMISSION_SORT_KEYS = ['createdAt', 'documentNo'] as const;
export const EINVOICE_SUBMISSION_SORTS = sortValues(EINVOICE_SUBMISSION_SORT_KEYS);

/** An empty filter value (`?status=`) counts as "not given", as in the other lists. */
const blankToUndefined = ({ value }: { value: unknown }) => (value === '' ? undefined : value);

/**
 * GET /einvoice/submissions (ADR-022 §2): a numbered page, newest first by
 * default. `from`/`to` bound the creation date (yyyy-mm-dd, `to` inclusive);
 * `q` matches the document number. Branch scope from the member (ADR-003 §10).
 */
export class ListEInvoiceSubmissionsQueryDto extends PageQueryDto {
  @SortParam(EINVOICE_SUBMISSION_SORTS, '-createdAt')
  sort?: (typeof EINVOICE_SUBMISSION_SORTS)[number];

  @ApiPropertyOptional({ enum: EINVOICE_STATUSES })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(EINVOICE_STATUSES)
  status?: (typeof EINVOICE_STATUSES)[number];

  @ApiPropertyOptional({ enum: ['SALES_INVOICE', 'SALES_RETURN'] })
  @IsOptional()
  @Transform(blankToUndefined)
  @IsIn(['SALES_INVOICE', 'SALES_RETURN'])
  documentType?: 'SALES_INVOICE' | 'SALES_RETURN';

  /** Created on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  from?: string;

  /** Created on or before (yyyy-mm-dd), the whole day included. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(blankToUndefined)
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  to?: string;
}
