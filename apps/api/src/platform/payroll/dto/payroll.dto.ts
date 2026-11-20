import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

const DECIMAL_PATTERN = /^\d+(?:\.\d{1,6})?$/;

export class CreateEmployeeDto {
  @IsString() @MaxLength(50) code!: string;
  @IsString() @MaxLength(191) nameAr!: string;
  @IsOptional() @IsString() @MaxLength(191) nameEn?: string;
  @IsOptional() @IsString() @MaxLength(50) nationalId?: string;
  @IsOptional() @IsString() @MaxLength(50) sscNumber?: string;
  @Matches(DATE_PATTERN) hireDate!: string;
  @IsOptional() @Matches(DATE_PATTERN) leaveDate?: string;
  @IsOptional() @Matches(ID_PATTERN) branchId?: string;
  @IsOptional() @Matches(ID_PATTERN) costCenterId?: string;
  @IsIn(['BANK', 'CASH']) payMethod!: 'BANK' | 'CASH';
  @IsOptional() @IsString() @MaxLength(50) iban?: string;
  @IsOptional() @IsBoolean() sscCovered?: boolean;
  @IsOptional() @IsBoolean() sscHazardous?: boolean;
}

export class CreateSalaryDto {
  @Matches(DATE_PATTERN) effectiveFrom!: string;
  @Matches(DECIMAL_PATTERN) basicSalary!: string;
}

export class CreateRecurringElementDto {
  @Matches(ID_PATTERN) payElementId!: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) amount?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) quantity?: string;
  @Matches(DATE_PATTERN) validFrom!: string;
  @IsOptional() @Matches(DATE_PATTERN) validTo?: string;
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

export class CreatePayrollSettingsDto {
  @Matches(DATE_PATTERN) effectiveFrom!: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscEmployeeRate?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscEmployerRate?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscHazardousExtra?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscMinWage?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) sscMaxWage?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) hoursPerMonth?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) daysPerMonth?: string;
}

export class CreatePayrollInputDto {
  @Matches(ID_PATTERN) employeeId!: string;
  @Matches(ID_PATTERN) payElementId!: string;
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
  @IsOptional() @Matches(DATE_PATTERN) workDate?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) quantity?: string;
  @IsOptional() @Matches(DECIMAL_PATTERN) amount?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

export class ListPayrollInputsDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
  @IsOptional() @Matches(ID_PATTERN) employeeId?: string;
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
  @Matches(DATE_PATTERN) date!: string;
}

export class ReversePayrollDto {
  @Matches(DATE_PATTERN) date!: string;
}

export class PayrollReportQueryDto extends ExportQueryDto {
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/) period!: string;
}
