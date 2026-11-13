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

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly errors: ErrorEventsService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = ErrorCode.INTERNAL;
    let message = 'Internal server error';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof DomainError) {
      status = exception.getStatus();
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'object' && body !== null && 'message' in body) {
        const msg = (body as { message: unknown }).message;
        message = Array.isArray(msg) ? msg.join('; ') : String(msg);
      } else {
        message = exception.message;
      }
      code = status === HttpStatus.BAD_REQUEST ? ErrorCode.VALIDATION : this.codeForStatus(status);
    } else {
      // Masked like the monitor's copy: no password or token in the host's logs (CLAUDE.md).
      this.logger.error('Unhandled exception', redact(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)));
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
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL;
    }
  }
}
