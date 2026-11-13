import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';

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
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
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
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
  startDate!: string;

  @IsString()
  @Matches(DATE_PATTERN, { message: '$property must be a yyyy-mm-dd date' })
  @IsDateString({ strict: true })
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
  @Matches(ID_PATTERN, { message: '$property must be a positive integer id' })
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

  /** UN/ECE Rec.20 code used by JoFotara/ZATCA e-invoicing (e.g. PCE, KGM, LTR). */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  unEceCode?: string;
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
  @IsString()
  @MaxLength(10)
  unEceCode?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateTaxCategoryDto extends CreateUnitDto {
  @IsString()
  rate!: string;

  /** JoFotara tax category (0005 §6): S taxed, Z exempt, O zero-rated. */
  @IsOptional()
  @IsIn(['S', 'Z', 'O'])
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
  @IsIn(['S', 'Z', 'O', null])
  einvoiceCode?: string | null;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

