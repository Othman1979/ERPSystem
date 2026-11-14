import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** ADR-022 §2: hard limits of a numbered page. */
export const MAX_PAGE = 10_000;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_SEARCH_LENGTH = 100;

/** ADR-022 §4: hard limits of a keyset ("load more") read. */
export const MAX_KEYSET_LIMIT = 500;
export const DEFAULT_KEYSET_LIMIT = 100;
export const MAX_CURSOR_LENGTH = 512;

/** Trimmed text; an empty or blank value counts as "not given". */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Query of a numbered list (ADR-022 §2). A list's own DTO extends it with its
 * filters and a `sort` property decorated with `@SortParam(...)`.
 */
export class PageQueryDto {
  // @ApiPropertyOptional keeps the parameters in OpenAPI, and so in packages/api-client.
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;

  /** Free-text search; the list decides which fields it matches. */
  @ApiPropertyOptional({ maxLength: MAX_SEARCH_LENGTH })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(MAX_SEARCH_LENGTH)
  q?: string;
}

/**
 * A list's `sort` (ADR-022 §2): `field` ascending or `-field` descending, one
 * of `values` (see sortValues); anything else is 400 VALIDATION.
 */
export function SortParam(values: readonly string[], fallback: string): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ enum: values, default: fallback }),
    IsOptional(),
    IsIn(values),
  ) as PropertyDecorator;
}

/** Query of a keyset read (ADR-022 §4): first page without `cursor`. */
export class KeysetQueryDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_KEYSET_LIMIT, default: DEFAULT_KEYSET_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_KEYSET_LIMIT)
  limit?: number;

  /** Opaque `nextCursor` of the previous page; omit for the first page. */
  @ApiPropertyOptional({ maxLength: MAX_CURSOR_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_CURSOR_LENGTH)
  cursor?: string;
}

/** A numbered page window with the defaults applied. */
export interface PageWindow {
  page: number;
  pageSize: number;
}

export function pageWindow(q: Pick<PageQueryDto, 'page' | 'pageSize'>): PageWindow {
  return { page: q.page ?? 1, pageSize: q.pageSize ?? DEFAULT_PAGE_SIZE };
}

export function keysetLimit(q: Pick<KeysetQueryDto, 'limit'>): number {
  return q.limit ?? DEFAULT_KEYSET_LIMIT;
}

/** The sort values a list allows: each key ascending and descending. */
export function sortValues<K extends string>(keys: readonly K[]): (K | `-${K}`)[] {
  return keys.flatMap((k) => [k, `-${k}`] as (K | `-${K}`)[]);
}

export type SortDirection = 'asc' | 'desc';

/**
 * Prisma `orderBy` for a list's `sort` value (ADR-022 §2): the chosen key,
 * then `id` in the same direction, so equal keys never swap between pages.
 * `sort` was validated against `sortValues(keys)`; an unknown key falls back.
 */
export function orderByOf<K extends string, O>(
  sort: string | undefined,
  fallback: K | `-${K}`,
  keys: Record<K, (dir: SortDirection) => O>,
  id: (dir: SortDirection) => O,
): O[] {
  const parse = (s: string) => {
    const dir: SortDirection = s.startsWith('-') ? 'desc' : 'asc';
    return { key: (dir === 'desc' ? s.slice(1) : s) as K, dir };
  };
  let { key, dir } = parse(sort ?? fallback);
  if (!Object.prototype.hasOwnProperty.call(keys, key)) ({ key, dir } = parse(fallback));
  return [keys[key](dir), id(dir)];
}
