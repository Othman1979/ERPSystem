import { ApiProperty } from '@nestjs/swagger';

const STATUSES = ['DRAFT', 'RECONCILED'] as const;

export class BankStatementListItemDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) bankAccountId!: string;
  @ApiProperty({ type: 'string' }) bankName!: string;
  @ApiProperty({ type: 'string', nullable: true }) accountNoMasked!: string | null;
  @ApiProperty({ type: 'string', format: 'date' }) startDate!: string;
  @ApiProperty({ type: 'string', format: 'date' }) endDate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) openingBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) closingBalance!: string;
  @ApiProperty({ type: 'string', enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) reconciledAt!: string | null;
  @ApiProperty({ type: 'integer' }) lineCount!: number;
}

/** A posted journal line on the bank's ledger account. */
export class BankBookLineDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) journalEntryId!: string;
  @ApiProperty({ type: 'string', nullable: true }) entryNo!: string | null;
  @ApiProperty({ type: 'string' }) sourceType!: string;
  @ApiProperty({ type: 'string', format: 'date' }) entryDate!: string;
  @ApiProperty({ type: 'string', nullable: true }) description!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) reference!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal', description: 'Debit minus credit: deposits positive.' })
  amount!: string;
}

export class BankStatementLineDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'integer' }) lineNo!: number;
  @ApiProperty({ type: 'string', format: 'date' }) lineDate!: string;
  @ApiProperty({ type: 'string', nullable: true }) description!: string | null;
  @ApiProperty({ type: 'string', nullable: true }) reference!: string | null;
  @ApiProperty({ type: 'string', format: 'decimal' }) deposit!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) withdrawal!: string;
  @ApiProperty({ type: 'boolean' }) matched!: boolean;
  @ApiProperty({ type: () => BankBookLineDto, isArray: true }) matches!: BankBookLineDto[];
}

export class BankReconciliationSummaryDto {
  @ApiProperty({ type: 'string', format: 'decimal' }) bookBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) outstandingDeposits!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) outstandingPayments!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) adjustedBookBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) computedClosingBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) statementDifference!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) difference!: string;
  @ApiProperty({ type: 'integer' }) unmatchedLines!: number;
}

export class BankStatementDetailDto {
  @ApiProperty({ type: 'string' }) id!: string;
  @ApiProperty({ type: 'string' }) bankAccountId!: string;
  @ApiProperty({ type: 'string' }) bankName!: string;
  @ApiProperty({ type: 'string', nullable: true }) accountNoMasked!: string | null;
  @ApiProperty({ type: 'string', format: 'date' }) startDate!: string;
  @ApiProperty({ type: 'string', format: 'date' }) endDate!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) openingBalance!: string;
  @ApiProperty({ type: 'string', format: 'decimal' }) closingBalance!: string;
  @ApiProperty({ type: 'string', enum: STATUSES }) status!: (typeof STATUSES)[number];
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) reconciledAt!: string | null;
  @ApiProperty({ type: () => BankStatementLineDto, isArray: true }) lines!: BankStatementLineDto[];
  @ApiProperty({ type: () => BankReconciliationSummaryDto }) summary!: BankReconciliationSummaryDto;
  @ApiProperty({ type: () => BankBookLineDto, isArray: true }) outstandingDeposits!: BankBookLineDto[];
  @ApiProperty({ type: () => BankBookLineDto, isArray: true }) outstandingPayments!: BankBookLineDto[];
}

export class BankAutoMatchResultDto {
  @ApiProperty({ type: 'integer' }) matched!: number;
  @ApiProperty({ type: () => BankStatementDetailDto }) statement!: BankStatementDetailDto;
}
