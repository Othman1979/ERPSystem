import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { redact } from '../errors/error-events.util.js';
import {
  isConflictRetry,
  isDbUnavailable,
  isForeignKeyViolation,
  isRecordNotFound,
  isUniqueViolation,
} from '../errors/db-errors.js';
import { ErrorEventsService } from '../../platform/monitoring/error-events.service.js';
import { ErrorCode } from '../errors/error-codes.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

/** A non-HTTP error that maps to a known answer (database, body parser, BigInt id). */
interface Classified {
  status: HttpStatus;
  code: ErrorCode;
  message: string;
  /** Seconds for the Retry-After header, when the client should wait before retrying. */
  retryAfter?: number;
  /** Database outage: logged as an error (the monitor records it as any 5xx). */
  logAsError?: boolean;
}

const PAYLOAD_TOO_LARGE_MESSAGE = 'Request body is larger than 2 MB';
const DB_UNAVAILABLE_MESSAGE = 'The database is temporarily unavailable; try again shortly';
const DB_UNAVAILABLE_RETRY_SECONDS = 5;

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly errors: ErrorEventsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = ErrorCode.INTERNAL;
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof DomainError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
      const retryAfter = positiveSeconds(details?.retryAfterSeconds);
      if (retryAfter !== null) response.setHeader('Retry-After', String(retryAfter));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const msg = (body as { message: unknown }).message;
        message = Array.isArray(msg) ? msg.join('; ') : String(msg);
      } else {
        message = exception.message;
      }
      code = this.codeForStatus(status);
      // body-parser's wording; an upload's own 413 (multer, UPLOAD_TOO_LARGE) keeps its message.
      if (code === ErrorCode.PAYLOAD_TOO_LARGE && /entity too large/i.test(message)) message = PAYLOAD_TOO_LARGE_MESSAGE;
    } else {
      const classified = this.classifyUnknown(exception);
      if (classified) {
        status = classified.status;
        code = classified.code;
        message = classified.message;
        if (classified.retryAfter !== undefined) response.setHeader('Retry-After', String(classified.retryAfter));
        if (classified.logAsError) {
          // Masked like the monitor's copy: the first line only, no secrets (CLAUDE.md).
          this.logger.error(DB_UNAVAILABLE_MESSAGE, redact(firstLine(exception)));
        }
      } else {
        // Masked like the monitor's copy: no password or token in the host's logs (CLAUDE.md).
        this.logger.error('Unhandled exception', redact(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)));
      }
    }

    // Server faults go to the platform console (ADR-010 §10.3); the answer
    // does not wait for it, and recording never throws.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const cls = ClsServiceManager.getClsService<RequestContext>();
      void this.errors.record({
        source: 'API',
        error: exception,
        method: request.method,
        path: request.originalUrl ?? request.url,
        status,
        tenantId: cls.isActive() ? (cls.get('tenantId') ?? null) : null,
        userId: cls.isActive() ? (cls.get('userId') ?? null) : null,
        requestId,
      });
    }

    const body: ErrorBody = {
      error: { code, message, details, requestId },
    };
    response.status(status).json(body);
  }

  /**
   * Maps a non-HTTP error to a client answer, or null when it is a real
   * fault. Order matters: body-parser and BigInt id errors first (client
   * mistakes), then database outages, then database constraint errors.
   */
  private classifyUnknown(exception: unknown): Classified | null {
    if (isBodyParserTooLarge(exception)) {
      return { status: HttpStatus.PAYLOAD_TOO_LARGE, code: ErrorCode.PAYLOAD_TOO_LARGE, message: PAYLOAD_TOO_LARGE_MESSAGE };
    }
    if (isBodyParserMalformed(exception)) {
      return { status: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION, message: 'Malformed JSON body' };
    }
    if (isBigIntParseError(exception)) {
      return { status: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION, message: 'Invalid id' };
    }
    if (isDbUnavailable(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ErrorCode.DB_UNAVAILABLE,
        message: DB_UNAVAILABLE_MESSAGE,
        retryAfter: DB_UNAVAILABLE_RETRY_SECONDS,
        logAsError: true,
      };
    }
    if (isUniqueViolation(exception)) {
      return { status: HttpStatus.CONFLICT, code: ErrorCode.CONFLICT, message: 'A record with these values already exists' };
    }
    if (isForeignKeyViolation(exception)) {
      return { status: HttpStatus.BAD_REQUEST, code: ErrorCode.VALIDATION, message: 'A referenced record does not exist' };
    }
    if (isRecordNotFound(exception)) {
      return { status: HttpStatus.NOT_FOUND, code: ErrorCode.NOT_FOUND, message: 'Record not found' };
    }
    if (isConflictRetry(exception)) {
      return {
        status: HttpStatus.CONFLICT,
        code: ErrorCode.CONFLICT,
        message: 'The request conflicted with another one; try again',
      };
    }
    return null;
  }

  /** Any HTTP status without its own code: 4xx is the client's fault (VALIDATION), 5xx is INTERNAL. */
  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return ErrorCode.UNAUTHORIZED;
      case HttpStatus.FORBIDDEN:
        return ErrorCode.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCode.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCode.CONFLICT;
      case HttpStatus.PAYLOAD_TOO_LARGE:
        return ErrorCode.PAYLOAD_TOO_LARGE;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return status < HttpStatus.INTERNAL_SERVER_ERROR ? ErrorCode.VALIDATION : ErrorCode.INTERNAL;
    }
  }
}

/** The Retry-After value for a positive number of seconds (rounded up), else null. */
function positiveSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.ceil(value) : null;
}

/** Errors raised by body-parser (express.json) with the limit exceeded. */
function isBodyParserTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const e = exception as { type?: unknown; status?: unknown; statusCode?: unknown };
  return e.type === 'entity.too.large' || e.status === 413 || e.statusCode === 413;
}

/** Errors raised by body-parser for a body that is not valid JSON. */
function isBodyParserMalformed(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  return (exception as { type?: unknown }).type === 'entity.parse.failed';
}

/** A path or query id that BigInt() could not read (for example "abc" or "1.5"). */
function isBigIntParseError(exception: unknown): boolean {
  if (!(exception instanceof SyntaxError) && !(exception instanceof RangeError)) return false;
  return /BigInt/i.test(exception.message);
}

/** The first line of an error, for logs. Never the full stack. */
function firstLine(exception: unknown): string {
  const text = exception instanceof Error ? exception.message : String(exception);
  // First non-empty line: Prisma's messages start with a newline.
  return text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}
