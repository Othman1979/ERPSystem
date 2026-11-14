import { createHmac } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import {
  CursorCodec,
  type CursorBinding,
  type CursorState,
  cursorKey,
  decodeCursor,
  encodeCursor,
} from './cursor.js';

const key = cursorKey('x'.repeat(32));
const binding: CursorBinding = {
  tenantId: 7n,
  scope: 'general-ledger',
  filters: { accountId: '5', from: '2026-01-01' },
};
const state: CursorState = {
  keys: ['2026-01-15', 'entry-9', 'line-2'],
  carry: { balance: '1250.000' },
};

/** Asserts that `fn` throws CURSOR_INVALID with HTTP 400 and the given reason. */
function refusedWith(fn: () => unknown, reason: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  const err = caught as DomainError;
  expect(err.code).toBe(ErrorCode.CURSOR_INVALID);
  expect(err.getStatus()).toBe(400);
  expect(err.details).toEqual({ reason });
}

const parts = (cursor: string) => cursor.split('.') as [string, string, string];

/** The decoded JSON body of a cursor's payload part. */
function bodyOf(cursor: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(parts(cursor)[1], 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Same version and MAC as the cursor, with another payload. */
function withBody(cursor: string, body: unknown): string {
  const [version, , signature] = parts(cursor);
  return `${version}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${signature}`;
}

/**
 * A payload signed exactly as cursor.ts signs it: HMAC-SHA256 over
 * `v1.<payload>|<tenant>|<scope>`, first 16 bytes. Lets a test craft a
 * correctly signed cursor whose payload is not what encodeCursor writes.
 */
function signPayload(payload: string, tenantId: bigint, scope: string, signingKey: Buffer): string {
  const mac = createHmac('sha256', signingKey)
    .update(`v1.${payload}|${tenantId.toString()}|${scope}`)
    .digest()
    .subarray(0, 16);
  return `v1.${payload}.${mac.toString('base64url')}`;
}

describe('encodeCursor and decodeCursor', () => {
  const cursor = encodeCursor(key, binding, state);

  it('round-trips the keys and the carry', () => {
    expect(decodeCursor(key, binding, cursor)).toEqual(state);
  });

  it('has the form v1.<payload>.<mac>', () => {
    expect(cursor.startsWith('v1.')).toBe(true);
    expect(cursor.split('.')).toHaveLength(3);
  });

  it('refuses a payload whose carry was changed but whose MAC is kept', () => {
    const body = bodyOf(cursor);
    body.c = { balance: '9999.000' };
    refusedWith(() => decodeCursor(key, binding, withBody(cursor, body)), 'signature');
  });

  it('refuses a changed MAC', () => {
    const [version, payload] = parts(cursor);
    const forged = `${version}.${payload}.${Buffer.alloc(16).toString('base64url')}`;
    refusedWith(() => decodeCursor(key, binding, forged), 'signature');
  });

  it('refuses a cursor of another tenant', () => {
    refusedWith(() => decodeCursor(key, { ...binding, tenantId: 8n }, cursor), 'signature');
  });

  it('refuses a cursor of another scope', () => {
    refusedWith(() => decodeCursor(key, { ...binding, scope: 'trial-balance' }, cursor), 'signature');
  });

  it('refuses a cursor whose filters changed', () => {
    refusedWith(() => decodeCursor(key, { ...binding, filters: { ...binding.filters, accountId: '6' } }, cursor), 'filters');
  });

  it('accepts the same filters given in a different key order', () => {
    const reordered: CursorBinding = { ...binding, filters: { from: '2026-01-01', accountId: '5' } };
    expect(decodeCursor(key, reordered, cursor)).toEqual(state);
  });

  it('treats an undefined, null or empty filter as absent', () => {
    const padded = encodeCursor(key, { ...binding, filters: { ...binding.filters, branch: undefined, note: '' } }, state);
    expect(decodeCursor(key, { ...binding, filters: { ...binding.filters, note: null } }, padded)).toEqual(state);
    expect(decodeCursor(key, binding, padded)).toEqual(state);
  });

  it('refuses a wrong version prefix', () => {
    const [, payload, signature] = parts(cursor);
    refusedWith(() => decodeCursor(key, binding, `v2.${payload}.${signature}`), 'version');
  });

  it('refuses a cursor with two parts only', () => {
    const [version, payload] = parts(cursor);
    refusedWith(() => decodeCursor(key, binding, `${version}.${payload}`), 'malformed');
  });

  it('refuses a cursor longer than 512 characters', () => {
    refusedWith(() => decodeCursor(key, binding, `v1.${'a'.repeat(600)}.aaaa`), 'too long');
  });

  it('refuses a correctly signed payload that is not JSON', () => {
    const payload = Buffer.from('not json at all').toString('base64url');
    const cursorNotJson = signPayload(payload, binding.tenantId, binding.scope, key);
    refusedWith(() => decodeCursor(key, binding, cursorNotJson), 'malformed');
  });

  it('refuses a cursor signed with a different key', () => {
    const otherKey = cursorKey('y'.repeat(32));
    refusedWith(() => decodeCursor(otherKey, binding, cursor), 'signature');
  });
});

describe('CursorCodec', () => {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const codec = new CursorCodec({ get: () => 'z'.repeat(32) } as never);
  const filters = { accountId: '5' };

  const inMember = <T>(store: Partial<RequestContext>, fn: () => T): T => cls.runWith(store as RequestContext, fn);

  it('decodes in the same tenant and branch scope what it encoded', () => {
    const member = { tenantId: 7n, allowedBranchIds: null };
    const cursor = inMember(member, () => codec.encode('general-ledger', filters, state));
    expect(inMember(member, () => codec.decode('general-ledger', filters, cursor))).toEqual(state);
  });

  it('refuses the cursor after the branch scope changed', () => {
    const cursor = inMember({ tenantId: 7n, allowedBranchIds: null }, () =>
      codec.encode('general-ledger', filters, state),
    );
    refusedWith(
      () => inMember({ tenantId: 7n, allowedBranchIds: new Set([1n]) }, () => codec.decode('general-ledger', filters, cursor)),
      'filters',
    );
  });

  it('refuses the cursor in another tenant', () => {
    const cursor = inMember({ tenantId: 7n, allowedBranchIds: null }, () =>
      codec.encode('general-ledger', filters, state),
    );
    refusedWith(
      () => inMember({ tenantId: 8n, allowedBranchIds: null }, () => codec.decode('general-ledger', filters, cursor)),
      'signature',
    );
  });

  it('throws INTERNAL when used outside a tenant request', () => {
    let caught: unknown;
    try {
      inMember({}, () => codec.encode('general-ledger', filters, state));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe(ErrorCode.INTERNAL);
  });
});
