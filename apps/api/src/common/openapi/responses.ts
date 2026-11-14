/**
 * OpenAPI response helpers (PLAT-15). They describe what endpoints already
 * return; nothing here touches a response body.
 *
 *  - `PageOf(Model)`: the numbered page `{ items, page, pageSize, total }`
 *    (ADR-022 §2, common/paging/find-page.ts), as a named schema `<Model>Page`.
 *  - `KeysetOf(Model, Summary?)`: the keyset page `{ items, nextCursor, summary? }`
 *    (ADR-022 §4), as a named schema `<Model>Keyset`.
 *  - `ApiPagedResponse` / `ApiKeysetResponse`: the 200 response of such a list.
 *  - `ErrorResponseDto`: the envelope every error answers with
 *    (common/filters/all-exceptions.filter.ts); main.ts documents it as the
 *    default response of every operation.
 *
 * Named classes, not inline `allOf` schemas, so the generated client has one
 * type per list (`PartyDtoPage`) instead of an anonymous one per operation.
 */
import { applyDecorators, type Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ErrorCode } from '../errors/error-codes.js';

const pages = new Map<Type, Type>();
const keysets = new Map<string, Type>();

/** Gives a generated class the name its schema is published under. */
function named<T extends Type>(cls: T, name: string): T {
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

/** The numbered page of `model` (ADR-022 §2). One class per model, so the schema name is stable. */
export function PageOf<M extends Type>(model: M): Type<{ items: InstanceType<M>[]; page: number; pageSize: number; total: number }> {
  const cached = pages.get(model);
  if (cached) return cached;
  class Page {
    @ApiProperty({ type: () => model, isArray: true })
    items!: InstanceType<M>[];

    @ApiProperty({ type: 'integer', minimum: 1, description: 'The page asked for (1-based).' })
    page!: number;

    @ApiProperty({ type: 'integer', minimum: 1 })
    pageSize!: number;

    @ApiProperty({ type: 'integer', minimum: 0, description: 'Rows matching the filters, over every page.' })
    total!: number;
  }
  const cls = named(Page, `${model.name}Page`);
  pages.set(model, cls);
  return cls;
}

/**
 * How a keyset page carries its report summary:
 *  - 'none': no `summary` key;
 *  - 'optional': the key is sent on the first page only (absent after);
 *  - 'nullable': the key is always sent, null after the first page.
 */
export type KeysetSummaryMode = 'none' | 'optional' | 'nullable';

export interface KeysetOptions<S extends Type> {
  summary?: S;
  summaryMode?: Exclude<KeysetSummaryMode, 'none'>;
  /** Schema name; defaults to `<Model>Keyset`. Needed when one row type is paged with two summaries. */
  name?: string;
}

/**
 * The keyset page of `model` (ADR-022 §4): `nextCursor` is null on the last
 * page, and `summary` (the report's totals) as `summaryMode` says.
 */
export function KeysetOf<M extends Type, S extends Type>(
  model: M,
  options: KeysetOptions<S> = {},
): Type<{ items: InstanceType<M>[]; nextCursor: string | null; summary?: InstanceType<S> | null }> {
  const name = options.name ?? `${model.name}Keyset`;
  const cached = keysets.get(name);
  if (cached) return cached;
  class Keyset {
    @ApiProperty({ type: () => model, isArray: true })
    items!: InstanceType<M>[];

    @ApiProperty({ type: 'string', nullable: true, description: 'Opaque cursor of the next page; null on the last page.' })
    nextCursor!: string | null;
  }
  const { summary, summaryMode = 'optional' } = options;
  if (summary && summaryMode === 'optional') {
    ApiPropertyOptional({ type: () => summary, description: 'Sent with the first page only.' })(Keyset.prototype, 'summary');
  } else if (summary) {
    ApiProperty({ type: () => summary, nullable: true, description: 'Null after the first page.' })(Keyset.prototype, 'summary');
  }
  const cls = named(Keyset, name);
  keysets.set(name, cls);
  return cls;
}

/** 200 with a numbered page of `model`. */
export const ApiPagedResponse = (model: Type, description?: string) =>
  applyDecorators(ApiOkResponse({ type: PageOf(model), description }));

/** 200 with a keyset page of `model`, and its summary as `options` say. */
export const ApiKeysetResponse = <S extends Type>(model: Type, options: KeysetOptions<S> = {}, description?: string) =>
  applyDecorators(ApiOkResponse({ type: KeysetOf(model, options), description }));

/**
 * A response that is one of several shapes (e.g. a delete that deactivates
 * instead when the row is in use). Each model gets its own named schema.
 */
export const ApiOneOfResponse = (status: 200 | 201, models: Type[], description?: string) =>
  applyDecorators(
    ApiExtraModels(...models),
    ApiResponse({ status, description, schema: { oneOf: models.map((m) => ({ $ref: getSchemaPath(m) })) } }),
  );

/**
 * A file download (PDF, xlsx, zip). `json`, when given, is the JSON body the
 * same route sends without a `format` query: a model, or `{ type, isArray }`
 * for a JSON array of it.
 */
export const ApiFileResponse = (mimeTypes: string[], json?: Type | { type: Type; isArray: true }, description?: string) => {
  const model = json && 'isArray' in json ? json.type : json;
  const schema = model && (json && 'isArray' in json ? { type: 'array', items: { $ref: getSchemaPath(model) } } : { $ref: getSchemaPath(model) });
  return applyDecorators(
    ...(model ? [ApiExtraModels(model)] : []),
    ApiOkResponse({
      description,
      content: {
        ...(schema ? { 'application/json': { schema } } : {}),
        ...Object.fromEntries(mimeTypes.map((t) => [t, { schema: { type: 'string', format: 'binary' } }])),
      },
    }),
  );
};

/** `{ deleted: true }`: a draft or master row that was deleted. */
export class DeletedDto {
  @ApiProperty({ type: 'boolean', enum: [true] })
  deleted!: true;
}

/** `{ deactivated: true }`: a row kept for its history and marked inactive. */
export class DeactivatedDto {
  @ApiProperty({ type: 'boolean', enum: [true] })
  deactivated!: true;
}

export class ErrorBodyDto {
  @ApiProperty({ enum: ErrorCode, enumName: 'ErrorCode' })
  code!: ErrorCode;

  @ApiProperty({ type: 'string' })
  message!: string;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Facts about the error for the client, e.g. the fields at fault or retryAfterSeconds.',
  })
  details?: Record<string, unknown>;

  @ApiProperty({ type: 'string', description: 'The x-request-id of the request, for support.' })
  requestId!: string;
}

/** The error envelope of every non-2xx answer. */
export class ErrorResponseDto {
  @ApiProperty({ type: () => ErrorBodyDto })
  error!: ErrorBodyDto;
}
