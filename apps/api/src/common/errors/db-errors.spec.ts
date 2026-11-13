import {
  driverErrno,
  isConflictRetry,
  isDbUnavailable,
  isForeignKeyViolation,
  isRecordNotFound,
  isUniqueViolation,
  prismaCode,
} from './db-errors.js';

/** Builds a Prisma known-request error with a driver adapter cause, shaped like the measured ones. */
function prismaError(code: string, cause?: Record<string, unknown>, message = 'Invalid `prisma` call'): unknown {
  return {
    name: 'PrismaClientKnownRequestError',
    code,
    message,
    meta: cause ? { driverAdapterError: { cause } } : undefined,
  };
}

describe('db errors: classification of Prisma 7 + MariaDB adapter errors', () => {
  it('reads the errno from the driver cause (code number, then originalCode string)', () => {
    const pool = prismaError('P2010', {
      originalCode: '45028',
      originalMessage: 'pool failed to retrieve a connection from pool',
      kind: 'mysql',
      code: 45028,
      state: 'HY000',
    });
    expect(driverErrno(pool)).toBe(45028);

    const columnMissing = prismaError('P2039', { originalCode: '1054', originalMessage: 'Unknown column', kind: 'ColumnNotFound' });
    expect(driverErrno(columnMissing)).toBe(1054);
  });

  it('falls back to errno on the error or its cause, and returns null otherwise', () => {
    expect(driverErrno({ errno: 1021 })).toBe(1021);
    expect(driverErrno({ cause: { errno: 1040 } })).toBe(1040);
    expect(driverErrno(new Error('boom'))).toBeNull();
    expect(driverErrno(prismaError('P2002', { originalCode: 'abc' }))).toBeNull();
  });

  it('returns the Prisma code only for Prisma known-request errors with a P-code', () => {
    expect(prismaCode(prismaError('P2002'))).toBe('P2002');
    expect(prismaCode({ name: 'PrismaClientKnownRequestError', code: 'E123' })).toBeNull();
    expect(prismaCode({ name: 'Error', code: 'P2002' })).toBeNull();
    expect(prismaCode(null)).toBeNull();
  });

  it('marks the database unavailable for a Prisma unavailability code', () => {
    expect(isDbUnavailable(prismaError('P1001'))).toBe(true);
    expect(isDbUnavailable(prismaError('P2024'))).toBe(true);
  });

  it('marks the database unavailable for a listed errno (pool timeout, too many connections, disk full)', () => {
    expect(isDbUnavailable(prismaError('P2010', { originalCode: '45028', kind: 'mysql', code: 45028 }))).toBe(true);
    expect(isDbUnavailable(prismaError('P2010', { originalCode: '1040', kind: 'mysql' }))).toBe(true);
    expect(isDbUnavailable({ errno: 1021, message: 'disk full' })).toBe(true);
  });

  it('marks the database unavailable for errno 3 or 1030 only when the message says errno 28', () => {
    expect(
      isDbUnavailable(prismaError('P2010', { originalCode: '1030', originalMessage: 'Got error 28 from storage engine' })),
    ).toBe(true);
    expect(
      isDbUnavailable(prismaError('P2010', { originalCode: '3', originalMessage: 'Error writing file (Errcode: 28 "No space left on device")' })),
    ).toBe(true);
    expect(isDbUnavailable(prismaError('P2010', { originalCode: '1030', originalMessage: 'Got error 124 from storage engine' }))).toBe(false);
    expect(isDbUnavailable({ errno: 3, message: 'some other failure' })).toBe(false);
  });

  it('marks the database unavailable from connection error text', () => {
    const prismaWrapped = (message: string) => ({ name: 'PrismaClientKnownRequestError', code: 'P2010', message });
    expect(isDbUnavailable(prismaWrapped('connect ECONNREFUSED ::1:3999'))).toBe(true);
    expect(isDbUnavailable({ message: 'x', meta: { driverAdapterError: { cause: { cause: 'read ECONNRESET' } } } })).toBe(true);
    expect(isDbUnavailable(prismaWrapped('connect ETIMEDOUT 10.0.0.1:3306'))).toBe(true);
    expect(isDbUnavailable({ errno: 9999, message: 'connect EHOSTUNREACH' })).toBe(true);
    expect(isDbUnavailable(prismaWrapped('Errcode: 28 write failed'))).toBe(true);
  });

  it('does not take an outbound HTTP failure for a database outage', () => {
    expect(isDbUnavailable(new Error('connect ECONNREFUSED 10.0.0.5:443'))).toBe(false);
    expect(isDbUnavailable(new TypeError('fetch failed: ETIMEDOUT'))).toBe(false);
  });

  it('does not treat a plain application error as unavailable', () => {
    expect(isDbUnavailable(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isDbUnavailable(prismaError('P2002', { originalCode: '1062' }))).toBe(false);
  });

  it('recognises a serialisable conflict (P2034, deadlock 1213, lock wait 1205)', () => {
    expect(isConflictRetry(prismaError('P2034'))).toBe(true);
    expect(isConflictRetry(prismaError('P2010', { originalCode: '1213', kind: 'mysql' }))).toBe(true);
    expect(isConflictRetry(prismaError('P2010', { originalCode: '1205', kind: 'mysql' }))).toBe(true);
    expect(isConflictRetry(prismaError('P2002'))).toBe(false);
  });

  it('recognises a unique violation (P2002, errno 1062, kind UniqueConstraintViolation)', () => {
    expect(isUniqueViolation(prismaError('P2002'))).toBe(true);
    expect(isUniqueViolation(prismaError('P2010', { originalCode: '1062', kind: 'mysql' }))).toBe(true);
    expect(isUniqueViolation(prismaError('P2010', { kind: 'UniqueConstraintViolation' }))).toBe(true);
    expect(isUniqueViolation(prismaError('P2003'))).toBe(false);
  });

  it('recognises a foreign key violation (P2003, errno 1451/1452, kind ForeignKeyConstraintViolation)', () => {
    expect(isForeignKeyViolation(prismaError('P2003'))).toBe(true);
    expect(isForeignKeyViolation(prismaError('P2010', { originalCode: '1451', kind: 'mysql' }))).toBe(true);
    expect(isForeignKeyViolation(prismaError('P2010', { originalCode: '1452', kind: 'mysql' }))).toBe(true);
    expect(isForeignKeyViolation(prismaError('P2010', { kind: 'ForeignKeyConstraintViolation' }))).toBe(true);
    expect(isForeignKeyViolation(prismaError('P2002'))).toBe(false);
  });

  it('recognises a missing record (P2025)', () => {
    expect(isRecordNotFound(prismaError('P2025'))).toBe(true);
    expect(isRecordNotFound(prismaError('P2002'))).toBe(false);
  });
});
