import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsServiceManager } from 'nestjs-cls';
import type { Env } from '../config/env.validation.js';
import type { RequestContext } from '../cls/cls.types.js';
import { branchScopeKey } from '../branch/branch-context.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { MAX_CURSOR_LENGTH } from './page-query.dto.js';

/**
 * Position of a keyset read (ADR-022 §4–§5): the sort key of the last row
 * returned and the running figures after it, all as strings.
 */
export interface CursorState {
  /** Sort key of the last row returned, e.g. [entryDate, entryId, lineId]. */
  keys: string[];
  /** Running figures carried to the next page, e.g. { balance: '1250.000' }. */
  carry: Record<string, string>;
}

/** What a cursor is bound to: it is valid only for the same tenant, read and filters. */
export interface CursorBinding {
  tenantId: bigint;
  /** Name of the read, e.g. 'general-ledger'. */
  scope: string;
  /** The read's filters and the caller's branch scope; order of keys does not matter. */
  filters: Record<string, string | null | undefined>;
}

const VERSION = 'v1';
const MAC_BYTES = 16;
const FINGERPRINT_CHARS = 22; // 16 bytes of SHA-256, base64url

/** HKDF sub-key for cursors: a separate key from the JWT secret it derives from. */
export function cursorKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, 'erp-cursor', VERSION, 32));
}

/** Canonical filters (sorted keys, absent values dropped) → short SHA-256. */
export function fingerprint(filters: CursorBinding['filters']): string {
  const canonical = Object.keys(filters)
    .filter((k) => filters[k] != null && filters[k] !== '')
    .sort()
    .map((k) => [k, String(filters[k])]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('base64url').slice(0, FINGERPRINT_CHARS);
}

function mac(key: Buffer, payload: string, binding: CursorBinding): Buffer {
  return createHmac('sha256', key)
    .update(`${VERSION}.${payload}|${binding.tenantId.toString()}|${binding.scope}`)
    .digest()
    .subarray(0, MAC_BYTES);
}

function invalid(reason: string): DomainError {
  return new DomainError(ErrorCode.CURSOR_INVALID, 'The cursor is not valid for this request; reload from the start', {
    reason,
  });
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isStringRecord = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

/** `v1.<payload>.<mac>`: signed, not encrypted (the content is the caller's own figures). */
export function encodeCursor(key: Buffer, binding: CursorBinding, state: CursorState): string {
  const payload = Buffer.from(
    JSON.stringify({ k: state.keys, c: state.carry, f: fingerprint(binding.filters) }),
  ).toString('base64url');
  return `${VERSION}.${payload}.${mac(key, payload, binding).toString('base64url')}`;
}

/** Throws CURSOR_INVALID (400) for any malformed, tampered, foreign or stale cursor. */
export function decodeCursor(key: Buffer, binding: CursorBinding, cursor: string): CursorState {
  if (cursor.length > MAX_CURSOR_LENGTH) throw invalid('too long');
  const parts = cursor.split('.');
  if (parts.length !== 3) throw invalid('malformed');
  const [version, payload, signature] = parts;
  if (version !== VERSION) throw invalid('version');
  const given = Buffer.from(signature, 'base64url');
  const expected = mac(key, payload, binding);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid('signature');
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid('malformed');
  }
  const { k, c, f } = (body ?? {}) as { k?: unknown; c?: unknown; f?: unknown };
  if (!isStringArray(k) || !isStringRecord(c) || typeof f !== 'string') throw invalid('malformed');
  if (f !== fingerprint(binding.filters)) throw invalid('filters');
  return { keys: k, carry: c };
}

/**
 * Cursor codec bound to the request (ADR-022 §5): the tenant comes from CLS
 * and the caller's branch scope (ADR-003 §15) joins the filters, so a cursor
 * is refused after the member's branches change.
 */
@Injectable()
export class CursorCodec {
  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    this.key = cursorKey(config.get('JWT_ACCESS_SECRET', { infer: true }));
  }

  private binding(scope: string, filters: CursorBinding['filters']): CursorBinding {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (tenantId === undefined) throw new DomainError(ErrorCode.INTERNAL, 'Cursor used outside a tenant request');
    return { tenantId, scope, filters: { ...filters, '@branches': branchScopeKey() } };
  }

  encode(scope: string, filters: CursorBinding['filters'], state: CursorState): string {
    return encodeCursor(this.key, this.binding(scope, filters), state);
  }

  decode(scope: string, filters: CursorBinding['filters'], cursor: string): CursorState {
    return decodeCursor(this.key, this.binding(scope, filters), cursor);
  }
}
