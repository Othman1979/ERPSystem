import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { DATE_PATTERN, ID_PATTERN } from '../../../common/pipes/parse-id.pipe.js';
import { PageQueryDto, SortParam, sortValues } from '../../../common/paging/page-query.dto.js';

/** Quantities: up to 6 decimals (CLAUDE.md «المال والأرقام»). */
const QTY = /^\d{1,12}(\.\d{1,6})?$/;
const ID_MESSAGE = { message: '$property must be a positive integer id' };
const DATE_MESSAGE = { message: '$property must be a yyyy-mm-dd date' };

/** One requested item, in its base unit (ADR-026 §9). */
export class IssueRequestLineDto {
  @Matches(ID_PATTERN, ID_MESSAGE)
  itemId!: string;

  /** Base-unit quantity. */
  @IsString()
  @Matches(QTY)
  qty!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** POST/PUT /issue-requests: a department's request for items from one warehouse (ADR-026 §9, FULL only). */
export class CreateIssueRequestDto {
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  requestDate!: string;

  /** The warehouse that issues the items; its branch is the request's (ADR-003). */
  @Matches(ID_PATTERN, ID_MESSAGE)
  warehouseId!: string;

  /** The department (a leaf cost centre, ADR-026 §8); copied to the issues. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  costCenterId?: string;

  /** An expense account the issues debit; copied to the issues. */
  @IsOptional()
  @Matches(ID_PATTERN, ID_MESSAGE)
  expenseAccountId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => IssueRequestLineDto)
  lines!: IssueRequestLineDto[];
}

export const ISSUE_REQUEST_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'] as const;
export const ISSUE_REQUEST_SORTS = sortValues(['requestDate', 'requestNo'] as const);

/** GET /issue-requests: a numbered page, newest first; `q` matches the number and the notes. */
export class ListIssueRequestsQueryDto extends PageQueryDto {
  @SortParam(ISSUE_REQUEST_SORTS, '-requestDate')
  sort?: (typeof ISSUE_REQUEST_SORTS)[number];

  @ApiPropertyOptional({ enum: ISSUE_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ISSUE_REQUEST_STATUSES)
  status?: (typeof ISSUE_REQUEST_STATUSES)[number];

  /** Request date on or after (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  from?: string;

  /** Request date on or before (yyyy-mm-dd). */
  @ApiPropertyOptional()
  @IsOptional()
  @Matches(DATE_PATTERN, DATE_MESSAGE)
  @IsDateString({ strict: true })
  to?: string;
}
