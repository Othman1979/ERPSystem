/**
 * Response shapes of the accounting settings, fiscal, chart-of-accounts and
 * account-mapping routes (PLAT-15). They describe what the services return
 * today; nothing here changes a body.
 */
import { ApiProperty, PickType } from '@nestjs/swagger';
import {
  AccountMappingRow,
  AccountRow,
  DocumentSequenceRow,
  FiscalPeriodRow,
  FiscalYearRow,
  PaymentMethodRow,
  TaxCategoryRow,
  UnitRow,
} from '../../../common/openapi/prisma-models.js';
import type { AccountMappingKey } from '../chart-template.js';
import { ACCOUNT_MAPPING_KEYS } from '../chart-template.js';

// ---- settings (SettingsService: the Prisma row, returned unchanged) ----

/** A unit of measure: every column of `units` (SettingsService.list, create, update). */
export class UnitDto extends UnitRow {}

/** A tax category: every column of `tax_categories`; `rate` is a decimal string. */
export class TaxCategoryDto extends TaxCategoryRow {}

/** A payment method: every column of `payment_methods`. */
export class PaymentMethodDto extends PaymentMethodRow {}

// ---- fiscal (FiscalService) ----

/** `_count` of a fiscal year: how many periods it has. */
export class FiscalYearCountDto {
  @ApiProperty({ type: 'integer' })
  periods!: number;
}

export class FiscalYearActiveClosingDto {
  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', nullable: true })
  journalEntryId!: string | null;

  @ApiProperty({ type: 'string' })
  netResult!: string;

  @ApiProperty({ type: 'string', format: 'date-time' })
  closedAt!: string;
}

/** A fiscal year in the list (FiscalService.listYears): no periods array. */
export class FiscalYearListItemDto extends FiscalYearRow {
  @ApiProperty({ type: () => FiscalYearActiveClosingDto, isArray: true })
  closings!: FiscalYearActiveClosingDto[];

  @ApiProperty({ type: () => FiscalYearActiveClosingDto, nullable: true })
  activeClosing!: FiscalYearActiveClosingDto | null;

  @ApiProperty({ type: () => FiscalYearCountDto })
  _count!: FiscalYearCountDto;
}

/** One period of a fiscal year (FiscalService.setPeriodStatus, the close and open routes). */
export class FiscalPeriodDto extends FiscalPeriodRow {}

/** A fiscal year with its periods (FiscalService.getYear, and the create, close and open results). */
export class FiscalYearDetailDto extends FiscalYearRow {
  @ApiProperty({ type: () => FiscalPeriodDto, isArray: true })
  periods!: FiscalPeriodDto[];

  @ApiProperty({ type: () => FiscalYearActiveClosingDto, isArray: true })
  closings!: FiscalYearActiveClosingDto[];

  @ApiProperty({ type: () => FiscalYearActiveClosingDto, nullable: true })
  activeClosing!: FiscalYearActiveClosingDto | null;

  @ApiProperty({ type: () => FiscalYearCountDto })
  _count!: FiscalYearCountDto;
}

export class YearClosingLineDto {
  @ApiProperty({ type: 'string' })
  accountId!: string;

  @ApiProperty({ type: 'string' })
  accountCode!: string;

  @ApiProperty({ type: 'string' })
  accountNameAr!: string;

  @ApiProperty({ type: 'string', nullable: true })
  accountNameEn!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  branchId!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  costCenterId!: string | null;

  @ApiProperty({ type: 'string' })
  debit!: string;

  @ApiProperty({ type: 'string' })
  credit!: string;
}

export class YearClosingDraftDto {
  @ApiProperty({ type: 'string' })
  type!: string;

  @ApiProperty({ type: 'string' })
  id!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  date!: string;

  @ApiProperty({ type: 'string', nullable: true })
  reference!: string | null;

  @ApiProperty({ type: 'string', nullable: true })
  description!: string | null;
}

export class YearClosingWarningDto {
  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  details!: Record<string, unknown>;
}

export class YearClosingPreviewDto {
  @ApiProperty({ type: 'string' })
  fiscalYearId!: string;

  @ApiProperty({ type: 'string' })
  code!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  startDate!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  endDate!: string;

  @ApiProperty({ type: 'boolean' })
  canClose!: boolean;

  @ApiProperty({ type: 'string' })
  netResult!: string;

  @ApiProperty({ type: () => YearClosingLineDto, isArray: true })
  lines!: YearClosingLineDto[];

  @ApiProperty({ type: () => YearClosingDraftDto, isArray: true })
  drafts!: YearClosingDraftDto[];

  @ApiProperty({ type: () => YearClosingWarningDto, isArray: true })
  warnings!: YearClosingWarningDto[];
}

/** The numbering sequence of one document type for a fiscal year (FiscalService.listSequences). */
export class DocumentSequenceDto extends DocumentSequenceRow {}

// ---- chart of accounts (AccountsService) ----

/** An account of the chart: every column of `accounts` (AccountsService.list, create, update). */
export class AccountDto extends AccountRow {}

/** The account a mapping points at, as MappingsService.list selects it. */
export class AccountMappingAccountRefDto extends PickType(AccountRow, ['id', 'code', 'nameAr', 'nameEn'] as const) {}

/** One fixed mapping key with its account, or nulls when the key is not mapped (MappingsService.list). */
export class AccountMappingSlotDto {
  @ApiProperty({ type: 'string', enum: [...ACCOUNT_MAPPING_KEYS] })
  mappingKey!: AccountMappingKey;

  @ApiProperty({ type: 'string', nullable: true })
  accountId!: string | null;

  @ApiProperty({ type: () => AccountMappingAccountRefDto, nullable: true })
  account!: AccountMappingAccountRefDto | null;
}

/** A saved account mapping: every column of `account_mappings` (MappingsService.upsert, bulk). */
export class AccountMappingDto extends AccountMappingRow {}

/** Counts of a chart provisioning run (ChartProvisioningService.provision). */
export class ChartProvisionResultDto {
  @ApiProperty({ type: 'integer', description: 'Newly created accounts only.' })
  accounts!: number;

  @ApiProperty({ type: 'integer', description: 'Mappings written, new or already existing.' })
  mappings!: number;

  @ApiProperty({ type: 'integer', description: 'Units written, new or already existing.' })
  units!: number;

  @ApiProperty({ type: 'integer', description: 'Tax categories written, new or already existing.' })
  taxCategories!: number;

  @ApiProperty({ type: 'integer', description: 'Payment methods written, new or already existing.' })
  paymentMethods!: number;
}
