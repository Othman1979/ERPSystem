import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PayrollSettlementDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) employeeId!: string;
  @ApiProperty({ type: String }) employeeNameAr!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) settlementNo!: string | null;
  @ApiProperty({ type: String, format: 'date' }) settlementDate!: string;
  @ApiProperty({ enum: ['DRAFT', 'POSTED', 'PAID', 'REVERSED'] }) status!: string;
  @ApiProperty({ type: String, format: 'decimal' }) serviceYears!: string;
  @ApiProperty({ type: String, format: 'decimal' }) lastWage!: string;
  @ApiProperty({ type: String, format: 'decimal' }) eosAmount!: string;
  @ApiProperty({ type: Number }) serviceDaysBefore2010!: number;
  @ApiProperty({ type: Number }) serviceDays2010To2014!: number;
  @ApiProperty({ type: Number }) serviceDaysFrom2015!: number;
  @ApiProperty({ type: String, format: 'decimal' }) taxableAmount!: string;
  @ApiProperty({ type: String, format: 'decimal' }) eosTax!: string;
  @ApiProperty({ type: String, format: 'decimal' }) nationalContribution!: string;
  @ApiProperty({ type: String, format: 'decimal' }) provisionUsed!: string;
  @ApiProperty({ type: String, format: 'decimal' }) net!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) journalEntryId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paymentEntryId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reversalEntryId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paymentReversalEntryId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidFromCashBoxId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) paidFromBankAccountId!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' }) postedAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' }) paidAt!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, format: 'date-time' }) reversedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

export class PayrollSettlementDeletedDto {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: Boolean }) deleted!: boolean;
}
