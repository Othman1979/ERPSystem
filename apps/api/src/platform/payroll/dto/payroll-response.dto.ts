import { ApiProperty } from '@nestjs/swagger';

export class PayrollEmployeeDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) branchNameAr!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) branchNameEn!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) currentBasicSalary!: string | null;
  @ApiProperty({ type: 'boolean' }) sscCovered!: boolean;
  @ApiProperty({ type: 'boolean' }) taxSubject!: boolean;
  @ApiProperty({ type: 'boolean' }) taxDependants!: boolean;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxOtherExemption!: string;
  @ApiProperty({ type: 'boolean' }) isActive!: boolean;
}

export class PayrollEmployeeCreatedDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) companyId!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) nationalId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) sscNumber!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) hireDate!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'date-time' }) leaveDate!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) branchId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) costCenterId!: string | null;
  @ApiProperty({ type: 'string', enum: ['BANK', 'CASH'] }) payMethod!: string;
  @ApiProperty({ type: 'string', nullable: true }) iban!: string | null;
  @ApiProperty({ type: 'boolean' }) sscCovered!: boolean;
  @ApiProperty({ type: 'boolean' }) sscHazardous!: boolean;
  @ApiProperty({ type: 'boolean' }) taxSubject!: boolean;
  @ApiProperty({ type: 'boolean' }) taxDependants!: boolean;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxOtherExemption!: string;
  @ApiProperty({ type: 'boolean' }) isActive!: boolean;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) updatedAt!: string;
}

export class PayrollEmployeeSalaryDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', format: 'date' }) effectiveFrom!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) basicSalary!: string;
}

export class PayrollEmployeeSalaryCreatedDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) employeeId!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) basicSalary!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
}

export class PayrollElementDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) companyId!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
  @ApiProperty({ type: 'string', enum: ['EARNING', 'DEDUCTION'] }) kind!: string;
  @ApiProperty({ type: 'string', enum: ['FIXED', 'PER_HOUR', 'PER_DAY'] }) amountType!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) rateFactor!: string;
  @ApiProperty({ type: 'boolean' }) sscSubject!: boolean;
  @ApiProperty({ type: 'boolean' }) taxSubject!: boolean;
  @ApiProperty({ type: 'boolean' }) isFixedAllowance!: boolean;
  @ApiProperty({ type: 'string' }) accountId!: string;
  @ApiProperty({ type: 'boolean' }) isActive!: boolean;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) updatedAt!: string;
}

export class PayrollSettingsDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) companyId!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) effectiveFrom!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployeeRate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployerRate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscHazardousExtra!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscMinWage!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) sscMaxWage!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) hoursPerMonth!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) daysPerMonth!: string;
  @ApiProperty({ type: Number, isArray: true, uniqueItems: true }) weeklyRestDays!: number[];
  @ApiProperty({ type: 'string', format: 'decimal' }) annualLeaveDays!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) annualLeaveDaysSenior!: string;
  @ApiProperty({ type: Number }) annualLeaveSeniorYears!: number;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxPersonalExemption!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxDependantsExemption!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxNationalThreshold!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxNationalRate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) eosTaxExemption!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) eosTaxRate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) eosNationalThreshold!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) eosNationalRate!: string;
  @ApiProperty({ type: () => PayrollTaxBracketDto, isArray: true }) taxBrackets!: PayrollTaxBracketDto[];
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
}

export class PayrollTaxBracketDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) payrollSettingsId!: string;
  @ApiProperty({ type: 'integer' }) seq!: number;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) upTo!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) rate!: string;
}

export class PayrollDeletedDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'boolean', enum: [true] }) deleted!: true;
}

export class PayrollRecurringElementDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) payElementId!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) amount!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) quantity!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) validFrom!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'date-time' }) validTo!: string | null;
  @ApiProperty({ type: PayrollElementDto }) payElement!: PayrollElementDto;
}

export class PayrollRecurringElementRecordDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) tenantId!: string;
  @ApiProperty({ type: 'string' }) employeeId!: string;
  @ApiProperty({ type: 'string' }) payElementId!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) amount!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) quantity!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) validFrom!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'date-time' }) validTo!: string | null;
  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: 'string', format: 'date-time' }) updatedAt!: string;
}

export class PayrollRecurringElementListPayElementDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', enum: ['FIXED', 'PER_HOUR', 'PER_DAY'] }) amountType!: string;
  @ApiProperty({ type: 'string', enum: ['EARNING', 'DEDUCTION'] }) kind!: string;
  @ApiProperty({ type: 'boolean' }) isFixedAllowance!: boolean;
}

export class PayrollRecurringElementListDto extends PayrollRecurringElementRecordDto {
  @ApiProperty({ type: PayrollRecurringElementListPayElementDto }) payElement!: PayrollRecurringElementListPayElementDto;
}

export class PayrollEmployeeDetailDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) nationalId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) sscNumber!: string | null;
  @ApiProperty({ type: 'string', format: 'date' }) hireDate!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'date' }) leaveDate!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) branchId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) costCenterId!: string | null;
  @ApiProperty({ type: 'string', enum: ['BANK', 'CASH'] }) payMethod!: string;
  @ApiProperty({ type: 'string', nullable: true }) iban!: string | null;
  @ApiProperty({ type: 'boolean' }) sscCovered!: boolean;
  @ApiProperty({ type: 'boolean' }) sscHazardous!: boolean;
  @ApiProperty({ type: 'boolean' }) taxSubject!: boolean;
  @ApiProperty({ type: 'boolean' }) taxDependants!: boolean;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxOtherExemption!: string;
  @ApiProperty({ type: 'boolean' }) isActive!: boolean;
  @ApiProperty({ type: PayrollEmployeeSalaryDto, isArray: true }) salaries!: PayrollEmployeeSalaryDto[];
  @ApiProperty({ type: PayrollRecurringElementDto, isArray: true }) recurringElements!: PayrollRecurringElementDto[];
}

export class PayrollRunDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }) period!: string;
  @ApiProperty({ type: 'string', format: 'date' }) runDate!: string;
  @ApiProperty({ type: 'string', enum: ['DRAFT', 'POSTED', 'PAID', 'REVERSED'] }) status!: string;
  @ApiProperty({ type: 'string', nullable: true }) runNo!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) leaveProvisionEntryId!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) basicTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) earningsTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) grossTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscBaseTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployeeTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployerTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) incomeTaxTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) deductionsTotal!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) netTotal!: string;
}

export class PayrollLineItemDto {
  @ApiProperty({ type: 'string' }) description!: string;
  @ApiProperty({ type: 'string', enum: ['EARNING', 'DEDUCTION'] }) kind!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) quantity!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) rate!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) amount!: string;
  @ApiProperty({ type: 'string', nullable: true }) payrollMovementId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) leaveRequestId!: string | null;
}

export class PayrollLineDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) employeeId!: string;
  @ApiProperty({ type: 'string' }) employeeName!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) basic!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) earnings!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) gross!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscBase!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployee!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) sscEmployer!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) incomeTax!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) taxableIncome!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) nationalContribution!: string;
  @ApiProperty({ type: 'boolean' }) taxManual!: boolean;
  @ApiProperty({ type: 'string', format: 'decimal' }) deductions!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) net!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) leaveProvision!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) eosProvision!: string;
  @ApiProperty({ type: PayrollLineItemDto, isArray: true }) items!: PayrollLineItemDto[];
}

export class PayrollRunLineTaxDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) incomeTax!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) net!: string;
  @ApiProperty({ type: 'boolean' }) taxManual!: boolean;
}

export class PayrollRunDetailDto extends PayrollRunDto {
  @ApiProperty({ type: PayrollLineDto, isArray: true }) lines!: PayrollLineDto[];
}

export class PayrollMovementDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', nullable: true }) movementNo!: string | null;
  @ApiProperty({ type: 'string' }) employeeId!: string;
  @ApiProperty({ type: 'string' }) employeeName!: string;
  @ApiProperty({ type: 'string' }) payElementId!: string;
  @ApiProperty({ type: 'string' }) payElementCode!: string;
  @ApiProperty({ type: 'string' }) payElementName!: string;
  @ApiProperty({ type: 'string', format: 'date' }) movementDate!: string;
  @ApiProperty({ type: 'string', format: 'period' }) period!: string;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) quantity!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'decimal' }) rate!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) amount!: string;
  @ApiProperty({ type: 'string' }) description!: string;
  @ApiProperty({ type: 'string', enum: ['POSTED', 'REVERSED'] }) status!: string;
  @ApiProperty({ type: 'string', nullable: true }) journalEntryId!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) reversalEntryId!: string | null;
  @ApiProperty({ type: 'string', nullable: true, format: 'date' }) reversedAt!: string | null;
}

export class PayrollEmployeeStatementRowDto {
  @ApiProperty({ type: 'string', format: 'date' }) date!: string;
  @ApiProperty({ type: 'string' }) documentNo!: string;
  @ApiProperty({ type: 'string' }) documentType!: string;
  @ApiProperty({ type: 'string' }) description!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) debit!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) credit!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) balance!: string;
}

export class PayrollEmployeeStatementDto {
  @ApiProperty({ type: 'string' }) employeeId!: string;
  @ApiProperty({ type: 'string' }) employeeName!: string;
  @ApiProperty({ type: 'string', format: 'date' }) from!: string;
  @ApiProperty({ type: 'string', format: 'date' }) to!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) openingBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) closingBalance!: string;
  @ApiProperty({ type: PayrollEmployeeStatementRowDto, isArray: true }) rows!: PayrollEmployeeStatementRowDto[];
}
