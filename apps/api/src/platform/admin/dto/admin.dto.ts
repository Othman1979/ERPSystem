import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

const TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;

export const ADMIN_TENANT_SORT_KEYS = ['id', 'name', 'createdAt'] as const;
export const ADMIN_TENANT_SORTS = sortValues(ADMIN_TENANT_SORT_KEYS);

/**
 * GET /admin/tenants (ADR-022 §2): a numbered page of tenants, newest first by
 * default. `q` matches the tenant name.
 */
export class ListTenantsQueryDto extends PageQueryDto {
  @SortParam(ADMIN_TENANT_SORTS, '-id')
  sort?: (typeof ADMIN_TENANT_SORTS)[number];

  @ApiPropertyOptional({ enum: TENANT_STATUSES })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (value === '' ? undefined : value))
  @IsIn(TENANT_STATUSES)
  status?: (typeof TENANT_STATUSES)[number];
}

/** Amounts as decimal strings, up to 3 decimals (JOD). */
const AMOUNT = /^\d{1,12}(\.\d{1,3})?$/;

export class UpdateTenantStatusDto {
  @IsIn(TENANT_STATUSES)
  status!: (typeof TENANT_STATUSES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class ExtendTrialDto {
  @IsInt()
  @Min(1)
  @Max(365)
  days!: number;
}

/** A paid period (manual payment: bank transfer / CliQ, ADR-009). */
export class CreateSubscriptionDto {
  @IsString()
  planCode!: string;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsDateString()
  periodEnd!: string;

  /** Amount received for the period. */
  @IsOptional()
  @Matches(AMOUNT)
  amount?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Plan prices and limits, edited by the platform owner (ADR-009 §1). */
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxUsers?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxBranches?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  maxWarehouses?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  maxInvoicesPerMonth?: number;

  /** null clears the price (e.g. the trial plan). */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(AMOUNT)
  priceMonthly?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @Matches(AMOUNT)
  priceYearly?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
