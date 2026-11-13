/**
 * Classifies database errors thrown by Prisma 7 with the MariaDB driver adapter.
 *
 * Checks are duck-typed (no instanceof) so plain objects shaped like the real
 * errors work in tests. Measured shapes:
 *   - Prisma known error: `{ name: 'PrismaClientKnownRequestError', code: 'P2010', meta: { driverAdapterError: { cause: {...} } } }`
 *   - driver cause: `{ originalCode: '45028', originalMessage: '...', kind: 'mysql', code: 45028, ... }`
 *     or `{ originalCode: '1054', kind: 'ColumnNotFound', ... }`.
 */

/** Pool timeout, too many connections, server gone, disk or table full. */
const DB_UNAVAILABLE_ERRNOS: ReadonlySet<number> = new Set([
  45028, // pool timeout: no connection from the pool
  45009,
  45012,
  1040, // too many connections
  2002, // cannot connect (socket)
  2003, // cannot connect (TCP)
  2006, // server has gone away
  2013, // lost connection during query
  1021, // disk full
  1114, // table full
]);

/** Storage-engine errno that means "disk full" only when the message says errno 28. */
const STORAGE_ERRNOS: ReadonlySet<number> = new Set([3, 1030]);

const DB_UNAVAILABLE_CODES: ReadonlySet<string> = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

const DB_UNAVAILABLE_MESSAGE = /ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|No space left on device|Errcode: 28/i;
const ERRNO_28 = /\b28\b|No space left/i;

type Loose = Record<string, unknown>;

function asObject(value: unknown): Loose | null {
  return typeof value === 'object' && value !== null ? (value as Loose) : null;
}

/** The driver adapter's cause object, if Prisma attached one. */
function driverCause(err: unknown): Loose | null {
  const meta = asObject(asObject(err)?.meta);
  return asObject(asObject(meta?.driverAdapterError)?.cause);
}

/** The driver's MySQL/MariaDB errno, or null when there is none. */
export function driverErrno(err: unknown): number | null {
  const cause = driverCause(err);
  if (typeof cause?.code === 'number') return cause.code;
  const originalCode = cause?.originalCode;
  if (typeof originalCode === 'string' && /^\d+$/.test(originalCode)) return Number(originalCode);
  if (typeof originalCode === 'number') return originalCode;

  const e = asObject(err);
  if (typeof e?.errno === 'number') return e.errno;
  const inner = asObject(e?.cause);
  if (typeof inner?.errno === 'number') return inner.errno;
  return null;
}

/** The Prisma error code (P2002, P1001, ...) for a Prisma known-request error, else null. */
export function prismaCode(err: unknown): string | null {
  const e = asObject(err);
  if (!e || typeof e.name !== 'string') return null;
  if (e.name !== 'PrismaClientKnownRequestError' && !e.name.startsWith('PrismaClient')) return null;
  return typeof e.code === 'string' && /^P\d{4}$/.test(e.code) ? e.code : null;
}

/** Every message the error carries, for the message-based checks. */
function messagesOf(err: unknown): string[] {
  const e = asObject(err);
  const cause = driverCause(err);
  const out: string[] = [];
  if (typeof e?.message === 'string') out.push(e.message);
  if (typeof cause?.originalMessage === 'string') out.push(cause.originalMessage);
  if (typeof cause?.cause === 'string') out.push(cause.cause);
  return out;
}

/** The database cannot take the request now: the pool is exhausted, the server is down, or the disk is full. */
export function isDbUnavailable(err: unknown): boolean {
  const code = prismaCode(err);
  if (code !== null && DB_UNAVAILABLE_CODES.has(code)) return true;

  const errno = driverErrno(err);
  if (errno !== null) {
    if (DB_UNAVAILABLE_ERRNOS.has(errno)) return true;
    if (STORAGE_ERRNOS.has(errno) && messagesOf(err).some((m) => ERRNO_28.test(m))) return true;
  }

  // Network wording counts only on a database error: an outbound HTTP call
  // (JoFotara, the alert webhook) that fails with ECONNREFUSED is not a
  // database outage.
  const fromDatabase = code !== null || errno !== null || driverCause(err) !== null;
  return fromDatabase && messagesOf(err).some((m) => DB_UNAVAILABLE_MESSAGE.test(m));
}

/** A serialisable transaction conflict (deadlock or lock wait timeout): safe to retry. */
export function isConflictRetry(err: unknown): boolean {
  if (prismaCode(err) === 'P2034') return true;
  const errno = driverErrno(err);
  return errno === 1213 || errno === 1205;
}

export function isUniqueViolation(err: unknown): boolean {
  if (prismaCode(err) === 'P2002') return true;
  if (driverErrno(err) === 1062) return true;
  return driverCause(err)?.kind === 'UniqueConstraintViolation';
}

export function isForeignKeyViolation(err: unknown): boolean {
  if (prismaCode(err) === 'P2003') return true;
  const errno = driverErrno(err);
  if (errno === 1451 || errno === 1452) return true;
  return driverCause(err)?.kind === 'ForeignKeyConstraintViolation';
}

/** A record the query needed (update or delete target) does not exist. */
export function isRecordNotFound(err: unknown): boolean {
  return prismaCode(err) === 'P2025';
}
