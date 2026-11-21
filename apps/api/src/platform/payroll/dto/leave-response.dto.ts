import { ApiProperty } from '@nestjs/swagger';

export class LeaveTypeResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) code!: string;
  @ApiProperty() nameAr!: string;
  @ApiProperty({ type: String, nullable: true }) nameEn!: string | null;
  @ApiProperty({ enum: ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER'] }) category!: string;
  @ApiProperty({ enum: ['WORKING_DAYS', 'CALENDAR_DAYS'] }) countBasis!: string;
  @ApiProperty({ type: String, nullable: true, format: 'decimal' }) maxDaysPerYear!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'decimal' }) maxDaysPerRequest!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'decimal' }) hospitalExtraDays!: string | null;
  @ApiProperty() oncePerEmployment!: boolean;
  @ApiProperty({ type: Number, nullable: true }) minServiceYears!: number | null;
  @ApiProperty({ type: String, nullable: true }) payElementId!: string | null;
  @ApiProperty({ type: String, nullable: true }) payElementCode!: string | null;
  @ApiProperty() isActive!: boolean;
}

export class PublicHolidayResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ format: 'date' }) date!: string;
  @ApiProperty() nameAr!: string;
  @ApiProperty({ type: String, nullable: true }) nameEn!: string | null;
}

export class LeaveRequestResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) employeeId!: string;
  @ApiProperty() employeeName!: string;
  @ApiProperty({ type: String, nullable: true }) employeeNameEn!: string | null;
  @ApiProperty({ type: String }) leaveTypeId!: string;
  @ApiProperty() leaveTypeCode!: string;
  @ApiProperty() leaveTypeNameAr!: string;
  @ApiProperty({ type: String, nullable: true }) leaveTypeNameEn!: string | null;
  @ApiProperty({ type: String, nullable: true }) requestNo!: string | null;
  @ApiProperty({ format: 'date' }) startDate!: string;
  @ApiProperty({ format: 'date' }) endDate!: string;
  @ApiProperty({ type: String, format: 'decimal' }) days!: string;
  @ApiProperty({ type: Number }) calendarDays!: number;
  @ApiProperty() hospitalised!: boolean;
  @ApiProperty({ type: String, nullable: true }) notes!: string | null;
  @ApiProperty({ enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) approvedBy!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) approvedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date' }) cancelledAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class LeaveBalanceResponseDto {
  @ApiProperty({ type: String }) employeeId!: string;
  @ApiProperty() employeeName!: string;
  @ApiProperty({ type: String, nullable: true }) employeeNameEn!: string | null;
  @ApiProperty({ type: String }) leaveTypeId!: string;
  @ApiProperty() leaveTypeCode!: string;
  @ApiProperty() leaveTypeNameAr!: string;
  @ApiProperty({ type: String, nullable: true }) leaveTypeNameEn!: string | null;
  @ApiProperty({ enum: ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER'] }) category!: string;
  @ApiProperty({ type: String, format: 'decimal' }) entitlement!: string;
  @ApiProperty({ type: String, format: 'decimal' }) carryInto!: string;
  @ApiProperty({ type: String, format: 'decimal' }) adjustments!: string;
  @ApiProperty({ type: String, format: 'decimal' }) taken!: string;
  @ApiProperty({ type: String, format: 'decimal' }) available!: string;
}

export class LeaveAdjustmentResponseDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) employeeId!: string;
  @ApiProperty({ type: String }) leaveTypeId!: string;
  @ApiProperty({ type: Number }) year!: number;
  @ApiProperty({ type: String, format: 'decimal' }) days!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ type: String }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
