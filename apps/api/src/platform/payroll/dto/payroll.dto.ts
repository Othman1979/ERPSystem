import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Decimal } from '../../../common/decimal/decimal.utils.js';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

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
      return rates.every((rate) => rate.gte(zero) && rate.lte(one)) &&
        hours.gt(zero) && days.gt(zero) &&
        (!minimum || minimum.gte(zero)) && (!maximum || maximum.gte(zero)) &&
        (!minimum || !maximum || maximum.gte(minimum));
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
