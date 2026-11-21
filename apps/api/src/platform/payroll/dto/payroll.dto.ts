import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Decimal } from '../../../common/decimal/decimal.utils.js';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';
import { DEFAULT_PAYROLL_TAX_BRACKETS } from '../../accounting/chart-template.js';

const DECIMAL_PATTERN = /^\d+(?:\.\d{1,6})?$/;
const DATE_MESSAGE = { message: '$property must be a yyyy-mm-dd date' };

export class CreateEmployeeDto {
  @IsString() @MaxLength(50) code!: string;
  @IsString() @MaxLength(191) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(191) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(50) nationalId?: string;
  @IsOptional() @IsString() @MaxLength(50) sscNumber?: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  hireDate!: string;
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  leaveDate?: string;
  @IsOptional() @Matches(ID_PATTERN) branchId?: string;
  @IsOptional() @Matches(ID_PATTERN) costCenterId?: string;
  @IsIn(['BANK', 'CASH']) payMethod!: 'BANK' | 'CASH';
  @IsOptional() @IsString() @MaxLength(50) iban?: string;
  @IsOptional() @IsBoolean() sscCovered?: boolean;
  @IsOptional() @IsBoolean() sscHazardous?: boolean;
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() taxSubject?: boolean;
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() taxDependants?: boolean;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) taxOtherExemption?: string;
}

export class UpdateEmployeeDto extends PartialType(OmitType(CreateEmployeeDto, [
  'nameEn', 'nationalId', 'sscNumber', 'leaveDate', 'branchId', 'costCenterId', 'iban',
] as const)) {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(191) nameEn?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(50) nationalId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(50) sscNumber?: string | null;
  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  leaveDate?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @Matches(ID_PATTERN) branchId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @Matches(ID_PATTERN) costCenterId?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional() @IsString() @MaxLength(50) iban?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class CreateSalaryDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  effectiveFrom!: string;
  @Matches(DECIMAL_PATTERN) basicSalary!: string;
}

export class CreateRecurringElementDto {
  @Matches(ID_PATTERN) payElementId!: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) amount?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) quantity?: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  validFrom!: string;
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  validTo?: string;
}

export class CreatePayElementDto {
  @IsString() @MaxLength(50) code!: string;
  @IsString() @MaxLength(191) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(191) nameEn?: string;
  @IsIn(['EARNING', 'DEDUCTION']) kind!: 'EARNING' | 'DEDUCTION';
  @IsIn(['FIXED', 'PER_HOUR', 'PER_DAY']) amountType!: 'FIXED' | 'PER_HOUR' | 'PER_DAY';
  @Matches(DECIMAL_PATTERN) rateFactor!: string;
  @IsOptional() @IsBoolean() sscSubject?: boolean;
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() taxSubject?: boolean;
  @IsOptional() @IsBoolean() isFixedAllowance?: boolean;
  @Matches(ID_PATTERN) accountId!: string;
}

export class UpdatePayElementDto extends PartialType(OmitType(CreatePayElementDto, ['code'] as const)) {
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ValidatorConstraint({ name: 'PayrollSettingsRange', async: false })
class PayrollSettingsRange implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments) {
    try {
      const dto = args.object as CreatePayrollSettingsDto;
      const zero = new Decimal('0');
      const one = new Decimal('1');
      const rates = [dto.sscEmployeeRate, dto.sscEmployerRate, dto.sscHazardousExtra]
        .filter((value): value is string => value != null)
        .map((value) => new Decimal(value));
      const minimum = dto.sscMinWage == null ? null : new Decimal(dto.sscMinWage);
      const maximum = dto.sscMaxWage == null ? null : new Decimal(dto.sscMaxWage);
      const hours = dto.hoursPerMonth == null ? new Decimal('240') : new Decimal(dto.hoursPerMonth);
      const days = dto.daysPerMonth == null ? new Decimal('30') : new Decimal(dto.daysPerMonth);
      const taxAmounts = [dto.taxPersonalExemption, dto.taxDependantsExemption, dto.taxNationalThreshold]
        .filter((value): value is string => value != null)
        .map((value) => new Decimal(value));
      const nationalRate = dto.taxNationalRate == null ? new Decimal('0.01') : new Decimal(dto.taxNationalRate);
      const eosAmounts = [dto.eosTaxExemption, dto.eosNationalThreshold]
        .filter((value): value is string => value != null)
        .map((value) => new Decimal(value));
      const eosRates = [dto.eosTaxRate, dto.eosNationalRate]
        .filter((value): value is string => value != null)
        .map((value) => new Decimal(value));
      const brackets = dto.taxBrackets ?? DEFAULT_PAYROLL_TAX_BRACKETS.map(({ upTo, rate }) => ({ upTo, rate }));
      let previous: Decimal | null = null;
      let sawUnbounded = false;
      const validBrackets = brackets.length > 0 && brackets.every((bracket, index) => {
        const rate = new Decimal(bracket.rate);
        if (rate.lt(zero) || rate.gt(one) || bracket.upTo === undefined || sawUnbounded) return false;
        if (bracket.upTo === null) {
          sawUnbounded = true;
          return index === brackets.length - 1;
        }
        const upper = new Decimal(bracket.upTo);
        if (upper.lt(zero) || (previous !== null && !upper.gt(previous))) return false;
        previous = upper;
        return true;
      });
      return rates.every((rate) => rate.gte(zero) && rate.lte(one)) &&
        hours.gt(zero) && days.gt(zero) &&
        (!minimum || minimum.gte(zero)) && (!maximum || maximum.gte(zero)) &&
        (!minimum || !maximum || maximum.gte(minimum)) &&
        taxAmounts.every((amount) => amount.gte(zero)) &&
        nationalRate.gte(zero) && nationalRate.lte(one) &&
        eosAmounts.every((amount) => amount.gte(zero)) &&
        eosRates.every((rate) => rate.gte(zero) && rate.lte(one)) && validBrackets;
    } catch {
      return false;
    }
  }

  defaultMessage() {
    return 'Payroll rates, wages, hours, or days are outside the allowed range';
  }
}

export class CreatePayrollSettingsDto {
  @Validate(PayrollSettingsRange)
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  effectiveFrom!: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscEmployeeRate?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscEmployerRate?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscHazardousExtra?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscMinWage?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscMaxWage?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) hoursPerMonth?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) daysPerMonth?: string;
  @ApiPropertyOptional({ type: Number, isArray: true, uniqueItems: true, minItems: 1, maxItems: 6, minimum: 0, maximum: 6 })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(6) @ArrayUnique()
  @IsInt({ each: true }) @Min(0, { each: true }) @Max(6, { each: true })
  weeklyRestDays?: number[];
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) annualLeaveDays?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) annualLeaveDaysSenior?: string;
  @ApiPropertyOptional({ type: Number }) @IsOptional() @IsInt() @Min(0) annualLeaveSeniorYears?: number;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) taxPersonalExemption?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) taxDependantsExemption?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) taxNationalThreshold?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) taxNationalRate?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) eosTaxExemption?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) eosTaxRate?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) eosNationalThreshold?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) eosNationalRate?: string;
  @ApiPropertyOptional({ type: () => PayrollTaxBracketInputDto, isArray: true })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => PayrollTaxBracketInputDto)
  taxBrackets?: PayrollTaxBracketInputDto[];
}

export class PayrollTaxBracketInputDto {
  @ApiProperty({ type: String, nullable: true, format: 'decimal' })
  @IsOptional() @Matches(DECIMAL_PATTERN) upTo?: string | null;
  @ApiProperty({ type: String, format: 'decimal' })
  @Matches(DECIMAL_PATTERN) rate!: string;
}

export class CreatePayrollMovementDto {
  @Matches(ID_PATTERN) employeeId!: string;
  @Matches(ID_PATTERN) payElementId!: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  movementDate!: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) quantity?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) amount?: string;
  @IsString() @IsNotEmpty() @MaxLength(500) description!: string;
}

export class ListPayrollMovementsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
  @IsOptional() @Matches(ID_PATTERN) employeeId?: string;
}

export class EmployeeStatementQueryDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from!: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to!: string;
}

export class EmployeeStatementExportQueryDto extends ExportQueryDto {
  @Matches(ID_PATTERN) employeeId!: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from!: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to!: string;
}

export class CreatePayrollRunDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
}

export class SetPayrollTaxDto {
  @Matches(DECIMAL_PATTERN) incomeTax!: string;
}

export class PayrollPaymentDto {
  @IsOptional() @Matches(ID_PATTERN) cashBoxId?: string;
  @IsOptional() @Matches(ID_PATTERN) bankAccountId?: string;
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  date!: string;
}

export class ReversePayrollDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  date!: string;
}

export class PayrollReportQueryDto extends ExportQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
}
