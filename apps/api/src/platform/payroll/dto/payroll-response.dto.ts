import { ApiProperty } from '@nestjs/swagger';

export class PayrollEmployeeDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', nullable: true }) nameEn!: string | null;
  @ApiProperty({ type: 'boolean' }) isActive!: boolean;
}

export class PayrollElementDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) code!: string;
  @ApiProperty({ type: 'string' }) nameAr!: string;
  @ApiProperty({ type: 'string', enum: ['EARNING', 'DEDUCTION'] }) kind!: string;
  @ApiProperty({ type: 'string', enum: ['FIXED', 'PER_HOUR', 'PER_DAY'] }) amountType!: string;
}

export class PayrollRunDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string', format: 'date' }) period!: string;
  @ApiProperty({ type: 'string', enum: ['DRAFT', 'POSTED', 'PAID', 'REVERSED'] }) status!: string;
  @ApiProperty({ type: 'string', nullable: true }) runNo!: string | null;
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
  @ApiProperty({ type: 'string', format: 'decimal' }) deductions!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) net!: string;
}

export class PayrollRunDetailDto extends PayrollRunDto {
  @ApiProperty({ type: PayrollLineDto, isArray: true }) lines!: PayrollLineDto[];
}
