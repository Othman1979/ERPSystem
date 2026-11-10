import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

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

export class EInvoiceSubmissionsQueryDto {
  @IsOptional()
  @IsIn(EINVOICE_STATUSES)
  status?: (typeof EINVOICE_STATUSES)[number];

  @IsOptional()
  @IsIn(['SALES_INVOICE', 'SALES_RETURN'])
  documentType?: 'SALES_INVOICE' | 'SALES_RETURN';
}
