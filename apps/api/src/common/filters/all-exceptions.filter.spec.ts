import { ArgumentsHost, Logger, MethodNotAllowedException, PayloadTooLargeException } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { ErrorEventsService } from '../../platform/monitoring/error-events.service.js';

/** Builds a Prisma known-request error with a driver adapter cause, shaped like the measured ones. */
function prismaError(code: string, cause?: Record<string, unknown>): Error & { code: string; meta?: unknown } {
  const err = new Error('Invalid `prisma.invoice.findFirst()` invocation') as Error & { code: string; meta?: unknown };
  err.name = 'PrismaClientKnownRequestError';
  err.code = code;
  if (cause) err.meta = { driverAdapterError: { cause } };
  return err;
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown>; requestId: string };
}

interface Harness {
  filter: AllExceptionsFilter;
  /** Every occurrence the filter handed to the monitor. */
  recorded: unknown[];
  /** Status passed to response.status(...). */
  sentStatus: () => number | undefined;
  /** Body passed to response.json(...). */
  sentBody: () => ErrorBody | undefined;
  /** Headers set with response.setHeader(...), keyed by name. */
  headers: Record<string, string>;
  host: ArgumentsHost;
}

function harness(): Harness {
  const recorded: unknown[] = [];
  const errors = { record: (o: unknown) => void recorded.push(o) } as unknown as ErrorEventsService;
  const sent: { status?: number; body?: ErrorBody } = {};
  const headers: Record<string, string> = {};
  const response = {
    status: (code: number) => {
      sent.status = code;
      return { json: (body: ErrorBody) => void (sent.body = body) };
    },
    setHeader: (name: string, value: string) => void (headers[name] = value),
  };
  const request = { method: 'POST', url: '/api/v1/x', originalUrl: '/api/v1/x', requestId: 'req-1' };
  const host = {
    switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
  } as unknown as ArgumentsHost;
  return {
    filter: new AllExceptionsFilter(errors),
    recorded,
    sentStatus: () => sent.status,
    sentBody: () => sent.body,
    headers,
    host,
  };
}

/** Runs the filter and returns the status and the body it sent. */
function run(h: Harness, exception: unknown): { status: number; body: ErrorBody } {
  h.filter.catch(exception, h.host);
  return { status: h.sentStatus() as number, body: h.sentBody() as ErrorBody };
}

describe('AllExceptionsFilter: database, parse and HTTP errors', () => {
  // The filter logs through Logger.prototype.error; capture those calls instead of printing them.
  const originalError = Logger.prototype.error;
  let logged: unknown[][];

  beforeEach(() => {
    logged = [];
    Logger.prototype.error = function (...args: unknown[]) {
      logged.push(args);
    } as typeof Logger.prototype.error;
  });

  afterEach(() => {
    Logger.prototype.error = originalError;
  });

  it('answers a pool timeout with 503, Retry-After 5, and records it', () => {
    const h = harness();
    const err = prismaError('P2010', { originalCode: '45028', originalMessage: 'pool failed to retrieve a connection', kind: 'mysql', code: 45028 });
    const { status, body } = run(h, err);
    expect(status).toBe(503);
    expect(body.error.code).toBe(ErrorCode.DB_UNAVAILABLE);
    expect(body.error.message).toBe('The database is temporarily unavailable; try again shortly');
    expect(h.headers['Retry-After']).toBe('5');
    expect(h.recorded).toHaveLength(1);
    expect(logged).toHaveLength(1);
  });

  it('answers a full disk (errno 1021) with 503 and records it', () => {
    const h = harness();
    const { status, body } = run(h, prismaError('P2010', { originalCode: '1021', kind: 'mysql' }));
    expect(status).toBe(503);
    expect(body.error.code).toBe(ErrorCode.DB_UNAVAILABLE);
    expect(h.recorded).toHaveLength(1);
  });

  it('answers "Got error 28 ... No space left on device" (errno 1030) with 503', () => {
    const h = harness();
    const err = prismaError('P2010', { originalCode: '1030', originalMessage: 'Got error 28 from storage engine' });
    expect(run(h, err).status).toBe(503);
    expect(h.recorded).toHaveLength(1);
  });

  it('answers "(Errcode: 28 ...)" (errno 3) with 503', () => {
    const h = harness();
    const err = prismaError('P2010', { originalCode: '3', originalMessage: 'Error writing file (Errcode: 28 "No space left on device")' });
    expect(run(h, err).status).toBe(503);
    expect(h.recorded).toHaveLength(1);
  });

  it('never puts the raw database message in the body', () => {
    const h = harness();
    const err = prismaError('P2039', { originalCode: '1054', originalMessage: "Unknown column 'secret_col' in 'field list'", kind: 'ColumnNotFound' });
    const { status, body } = run(h, err);
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret_col');
    expect(body.error.code).toBe(ErrorCode.INTERNAL);
  });

  it('answers a unique violation (P2002) with 409 and does not record it', () => {
    const h = harness();
    const { status, body } = run(h, prismaError('P2002'));
    expect(status).toBe(409);
    expect(body.error.code).toBe(ErrorCode.CONFLICT);
    expect(body.error.message).toBe('A record with these values already exists');
    expect(h.recorded).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });

  it('answers a missing record (P2025) with 404 and does not record it', () => {
    const h = harness();
    const { status, body } = run(h, prismaError('P2025'));
    expect(status).toBe(404);
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.error.message).toBe('Record not found');
    expect(h.recorded).toHaveLength(0);
  });

  it('answers a foreign key violation (P2003) with 400 and does not record it', () => {
    const h = harness();
    const { status, body } = run(h, prismaError('P2003'));
    expect(status).toBe(400);
    expect(body.error.code).toBe(ErrorCode.VALIDATION);
    expect(body.error.message).toBe('A referenced record does not exist');
    expect(h.recorded).toHaveLength(0);
  });

  it('answers a serialisable conflict (P2034) with 409 and does not record it', () => {
    const h = harness();
    const { status, body } = run(h, prismaError('P2034'));
    expect(status).toBe(409);
    expect(body.error.code).toBe(ErrorCode.CONFLICT);
    expect(body.error.message).toBe('The request conflicted with another one; try again');
    expect(h.recorded).toHaveLength(0);
  });

  it('answers a deadlock (errno 1213) with 409 and does not record it', () => {
    const h = harness();
    const { status } = run(h, prismaError('P2010', { originalCode: '1213', kind: 'mysql' }));
    expect(status).toBe(409);
    expect(h.recorded).toHaveLength(0);
  });

  it('answers a BigInt parse failure with 400 "Invalid id", not logged and not recorded', () => {
    const h = harness();
    const { status, body } = run(h, new SyntaxError('Cannot convert abc to a BigInt'));
    expect(status).toBe(400);
    expect(body.error.code).toBe(ErrorCode.VALIDATION);
    expect(body.error.message).toBe('Invalid id');
    expect(h.recorded).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });

  it('answers an oversized body (HTTP 413) with PAYLOAD_TOO_LARGE', () => {
    const h = harness();
    const { status, body } = run(h, new PayloadTooLargeException('request entity too large'));
    expect(status).toBe(413);
    expect(body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(body.error.message).toBe('Request body is larger than 2 MB');
    expect(h.recorded).toHaveLength(0);
  });

  it("keeps an upload's own 413 message (multer)", () => {
    const h = harness();
    const { status, body } = run(h, new PayloadTooLargeException('File too large'));
    expect(status).toBe(413);
    expect(body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(body.error.message).toBe('File too large');
  });

  it('answers a body-parser "entity.too.large" error with 413', () => {
    const h = harness();
    const { status, body } = run(h, { type: 'entity.too.large', status: 413 });
    expect(status).toBe(413);
    expect(body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('answers a body-parser "entity.parse.failed" error with 400 "Malformed JSON body"', () => {
    const h = harness();
    const { status, body } = run(h, { type: 'entity.parse.failed', status: 400 });
    expect(status).toBe(400);
    expect(body.error.code).toBe(ErrorCode.VALIDATION);
    expect(body.error.message).toBe('Malformed JSON body');
  });

  it('maps an unmapped 4xx HTTP status (405) to VALIDATION, not INTERNAL', () => {
    const h = harness();
    const { status, body } = run(h, new MethodNotAllowedException());
    expect(status).toBe(405);
    expect(body.error.code).toBe(ErrorCode.VALIDATION);
    expect(h.recorded).toHaveLength(0);
  });

  it('sets Retry-After from a DomainError with details.retryAfterSeconds', () => {
    const h = harness();
    const { status, body } = run(h, new DomainError(ErrorCode.LOGIN_LOCKED, 'Too many attempts', { retryAfterSeconds: 30 }));
    expect(status).toBe(429);
    expect(body.error.code).toBe(ErrorCode.LOGIN_LOCKED);
    expect(h.headers['Retry-After']).toBe('30');
  });

  it('rounds a fractional Retry-After up and ignores a non-positive one', () => {
    const h = harness();
    run(h, new DomainError(ErrorCode.LOGIN_LOCKED, 'x', { retryAfterSeconds: 29.2 }));
    expect(h.headers['Retry-After']).toBe('30');

    const h2 = harness();
    run(h2, new DomainError(ErrorCode.LOGIN_LOCKED, 'x', { retryAfterSeconds: 0 }));
    expect(h2.headers['Retry-After']).toBeUndefined();
  });

  it('answers an unexpected error with 500 INTERNAL, logs it and records it', () => {
    const h = harness();
    const { status, body } = run(h, new Error('boom'));
    expect(status).toBe(500);
    expect(body.error.code).toBe(ErrorCode.INTERNAL);
    expect(body.error.message).toBe('Internal server error');
    expect(logged).toHaveLength(1);
    expect(h.recorded).toHaveLength(1);
  });
});
