import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';

export class CreatePayrollSettlementDto {
  @Matches(ID_PATTERN) employeeId!: string;
}

export class ListPayrollSettlementsQueryDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @Matches(ID_PATTERN)
  employeeId?: string;

  @ApiPropertyOptional({ enum: ['DRAFT', 'POSTED', 'PAID', 'REVERSED'] })
  @IsOptional()
  @IsIn(['DRAFT', 'POSTED', 'PAID', 'REVERSED'])
  status?: 'DRAFT' | 'POSTED' | 'PAID' | 'REVERSED';
}

export class PayrollSettlementPaymentDto {
  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_PATTERN)
  @IsString()
  paymentDate!: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @Matches(ID_PATTERN)
  cashBoxId?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @Matches(ID_PATTERN)
  bankAccountId?: string;
}

export class ReversePayrollSettlementDto {
  @ApiProperty({ type: String, format: 'date' })
  @Matches(DATE_PATTERN)
  @IsString()
  reversalDate!: string;
}
