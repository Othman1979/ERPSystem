import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const;
const NORMAL_BALANCES = ['DEBIT', 'CREDIT'] as const;
const CONTROL_TYPES = ['CUSTOMERS', 'SUPPLIERS', 'CASH', 'BANK'] as const;

export class CreateAccountDto {
  /** Optional when parentId is set — the server auto-generates `parent-NN`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsIn(ACCOUNT_TYPES)
  accountType!: (typeof ACCOUNT_TYPES)[number];

  @IsOptional()
  @IsIn(NORMAL_BALANCES)
  normalBalance?: (typeof NORMAL_BALANCES)[number];

  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;

  @IsOptional()
  @IsBoolean()
  isControl?: boolean;

  @IsOptional()
  @IsIn(CONTROL_TYPES)
  controlType?: (typeof CONTROL_TYPES)[number] | null;
}

export class UpdateAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateFiscalYearDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  code!: string;

  @IsString()
  startDate!: string;

  @IsString()
  endDate!: string;
}

export class SetPeriodStatusDto {
  @IsIn(['OPEN', 'CLOSED'])
  status!: 'OPEN' | 'CLOSED';
}

export class UpsertMappingDto {
  @IsString()
  mappingKey!: string;

  @IsString()
  accountId!: string;
}

export class BulkMappingsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => UpsertMappingDto)
  mappings!: UpsertMappingDto[];
}

export class CreateUnitDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr!: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string;
}

export class UpdateLookupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(191)
  nameEn?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateTaxCategoryDto extends CreateUnitDto {
  @IsString()
  rate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  einvoiceCode?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateTaxCategoryDto extends UpdateLookupDto {
  @IsOptional()
  @IsString()
  rate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  einvoiceCode?: string | null;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

