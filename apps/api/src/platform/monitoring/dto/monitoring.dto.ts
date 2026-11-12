import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** An error the web app caught (window.onerror, a rejected promise, a render error). */
export class ClientErrorDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  name?: string;

  @IsString()
  @MaxLength(2000)
  message!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16000)
  stack?: string;

  /** location.pathname of the page; no query string is stored. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  page?: string;
}

export const ERROR_FILTERS = ['open', 'resolved', 'all'] as const;
export const ERROR_SOURCES = ['API', 'WEB', 'JOB'] as const;

/** Query of the console's list (typed for the generated client). */
export class ListErrorsQueryDto {
  @ApiPropertyOptional({ enum: ERROR_FILTERS, description: 'open (default), resolved or all' })
  @IsOptional()
  @IsIn(ERROR_FILTERS)
  status?: (typeof ERROR_FILTERS)[number];

  @ApiPropertyOptional({ enum: ERROR_SOURCES })
  @IsOptional()
  @IsIn(ERROR_SOURCES)
  source?: (typeof ERROR_SOURCES)[number];
}
