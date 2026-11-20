import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../../printing/dto/export.dto.js';

export const CHEQUE_DIRECTIONS = ['INCOMING', 'OUTGOING'] as const;
export const CHEQUE_STATUSES = ['IN_HAND', 'DEPOSITED', 'COLLECTED', 'ISSUED', 'CLEARED', 'RETURNED', 'CANCELLED'] as const;

/** Filters shared by the list and the outstanding report (ADR-037 §7). */
export class ChequeFilterDto extends ExportQueryDto {
  @IsOptional()
  @IsIn(CHEQUE_DIRECTIONS)
  direction?: (typeof CHEQUE_DIRECTIONS)[number];

  @IsOptional()
  @IsIn(CHEQUE_STATUSES)
  status?: (typeof CHEQUE_STATUSES)[number];

  @IsOptional()
  @Matches(DATE_PATTERN)
  dueFrom?: string;

  @IsOptional()
  @Matches(DATE_PATTERN)
  dueTo?: string;

  @IsOptional()
  @Matches(ID_PATTERN)
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  q?: string;
}

export class ListChequesQueryDto extends ChequeFilterDto {
  /** Only cheques still outstanding (in hand, deposited, or issued). */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  open?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class ChequeMoveDto {
  @Matches(DATE_PATTERN)
  date!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class DepositChequeDto extends ChequeMoveDto {
  @Matches(ID_PATTERN)
  bankAccountId!: string;
}

export class UndoChequeDto {
  @Matches(DATE_PATTERN)
  date!: string;
}
