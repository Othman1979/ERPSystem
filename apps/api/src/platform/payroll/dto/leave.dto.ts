import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';

const DECIMAL_PATTERN = /^\d+(?:\.\d{1,2})?$/;
const SIGNED_DECIMAL_PATTERN = /^-?\d+(?:\.\d{1,2})?$/;

export class CreateLeaveTypeDto {
  @ApiProperty() @IsString() @MaxLength(50) code!: string;
  @ApiProperty() @IsString() @MaxLength(191) nameAr!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(191) nameEn?: string;
  @ApiProperty({ enum: ['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER'] })
  @IsIn(['ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER'])
  category!: string;
  @ApiProperty({ enum: ['WORKING_DAYS', 'CALENDAR_DAYS'] })
  @IsIn(['WORKING_DAYS', 'CALENDAR_DAYS'])
  countBasis!: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) maxDaysPerYear?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) maxDaysPerRequest?: string;
  @ApiPropertyOptional({ type: String, format: 'decimal' }) @IsOptional() @Matches(DECIMAL_PATTERN) hospitalExtraDays?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() oncePerEmployment?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) minServiceYears?: number;
  @ApiPropertyOptional({ type: String, nullable: true }) @IsOptional() @Matches(ID_PATTERN) payElementId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
}

export class UpdateLeaveTypeDto extends PartialType(OmitType(CreateLeaveTypeDto, ['code'] as const)) {}

export class CreatePublicHolidayDto {
  @ApiProperty({ format: 'date' }) @Matches(DATE_PATTERN) date!: string;
  @ApiProperty() @IsString() @MaxLength(191) nameAr!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(191) nameEn?: string;
}

export class PublicHolidayQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}$/) year?: string;
}

export class CreateLeaveRequestDto {
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) employeeId!: string;
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) leaveTypeId!: string;
  @ApiProperty({ format: 'date' }) @Matches(DATE_PATTERN) startDate!: string;
  @ApiProperty({ format: 'date' }) @Matches(DATE_PATTERN) endDate!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hospitalised?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) notes?: string;
}

export class LeaveRequestsQueryDto {
  @ApiPropertyOptional({ type: String }) @IsOptional() @Matches(ID_PATTERN) employeeId?: string;
  @ApiPropertyOptional({ enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'] })
  @IsOptional() @IsIn(['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}$/) year?: string;
}

export class LeaveBalanceQueryDto {
  @ApiProperty() @Matches(/^\d{4}$/) year!: string;
  @ApiPropertyOptional({ type: String }) @IsOptional() @Matches(ID_PATTERN) employeeId?: string;
}

export class LeaveAdjustmentsQueryDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}$/) year?: string;
  @ApiPropertyOptional({ type: String }) @IsOptional() @Matches(ID_PATTERN) employeeId?: string;
}

export class CreateLeaveAdjustmentDto {
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) employeeId!: string;
  @ApiProperty({ type: String }) @Matches(ID_PATTERN) leaveTypeId!: string;
  @ApiProperty({ type: String }) @Matches(/^\d{4}$/) year!: string;
  @ApiProperty({ type: String, format: 'decimal' })
  @Matches(SIGNED_DECIMAL_PATTERN)
  days!: string;
  @ApiProperty() @IsString() @MaxLength(500) reason!: string;
}
