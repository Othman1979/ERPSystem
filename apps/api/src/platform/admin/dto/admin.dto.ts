import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED'] as const;

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

export class CreateSubscriptionDto {
  @IsString()
  planCode!: string;

  @IsOptional()
  @IsDateString()
  periodStart?: string;

  @IsDateString()
  periodEnd!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
