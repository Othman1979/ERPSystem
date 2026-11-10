import { IsDateString, IsIn, IsOptional, Matches } from 'class-validator';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `?from&to` (yyyy-mm-dd, inclusive); a missing end comes from the fiscal year (see ReportPeriods). */
export class PeriodQueryDto extends ExportQueryDto {
  @IsOptional()
  @Matches(DATE)
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @Matches(DATE)
  @IsDateString({ strict: true })
  to?: string;
}

export class AsOfQueryDto extends ExportQueryDto {
  /** yyyy-mm-dd, inclusive; defaults to today in the company's timezone. */
  @IsOptional()
  @Matches(DATE)
  @IsDateString({ strict: true })
  asOf?: string;
}

export const SALES_GROUPS = ['day', 'month', 'customer', 'item'] as const;
export const PURCHASE_GROUPS = ['day', 'month', 'supplier', 'item'] as const;

export class SalesSummaryQueryDto extends PeriodQueryDto {
  @IsOptional()
  @IsIn(SALES_GROUPS)
  groupBy?: (typeof SALES_GROUPS)[number];
}

export class PurchasesSummaryQueryDto extends PeriodQueryDto {
  @IsOptional()
  @IsIn(PURCHASE_GROUPS)
  groupBy?: (typeof PURCHASE_GROUPS)[number];
}

export class DashboardQueryDto {
  /** yyyy-mm-dd; defaults to today in the company's timezone. */
  @IsOptional()
  @Matches(DATE)
  @IsDateString({ strict: true })
  date?: string;
}
