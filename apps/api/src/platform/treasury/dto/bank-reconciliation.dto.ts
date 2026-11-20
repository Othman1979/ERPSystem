import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AMOUNT_PATTERN, DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

/** A signed amount: the bank's opening and closing balances may be overdrawn. */
const SIGNED_AMOUNT = /^-?\d{1,15}(\.\d{1,3})?$/;

export class BankStatementHeaderDto {
  @ApiProperty({ type: 'string', format: 'date' })
  @Matches(DATE_PATTERN)
  startDate!: string;

  @ApiProperty({ type: 'string', format: 'date' })
  @Matches(DATE_PATTERN)
  endDate!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  @IsString()
  @Matches(SIGNED_AMOUNT)
  openingBalance!: string;

  @ApiProperty({ type: 'string', format: 'decimal' })
  @IsString()
  @Matches(SIGNED_AMOUNT)
  closingBalance!: string;
}

export class CreateBankStatementDto extends BankStatementHeaderDto {
  @ApiProperty({ type: 'string' })
  @IsString()
  @Matches(ID_PATTERN)
  bankAccountId!: string;
}

export class ListBankStatementsQueryDto {
  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(ID_PATTERN)
  bankAccountId?: string;
}

export class BankStatementLineInputDto {
  @ApiProperty({ type: 'string', format: 'date' })
  @Matches(DATE_PATTERN)
  lineDate!: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ type: 'string', format: 'decimal' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN)
  deposit?: string;

  @ApiPropertyOptional({ type: 'string', format: 'decimal' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PATTERN)
  withdrawal?: string;
}

export class MatchBankStatementLineDto {
  @ApiProperty({ type: 'string' })
  @IsString()
  @Matches(ID_PATTERN)
  statementLineId!: string;

  @ApiProperty({ type: 'string', isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @Matches(ID_PATTERN, { each: true })
  @Type(() => String)
  journalLineIds!: string[];
}

export class BankReconciliationReportQueryDto extends ExportQueryDto {}
