import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from './error-codes.js';

const STATUS_BY_CODE: Partial<Record<ErrorCode, HttpStatus>> = {
  [ErrorCode.VALIDATION]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UNAUTHORIZED]: HttpStatus.UNAUTHORIZED,
  [ErrorCode.FORBIDDEN]: HttpStatus.FORBIDDEN,
  [ErrorCode.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ErrorCode.CONFLICT]: HttpStatus.CONFLICT,
  [ErrorCode.PLAN_LIMIT_EXCEEDED]: HttpStatus.PAYMENT_REQUIRED,
  [ErrorCode.DB_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: HttpStatus.CONFLICT,
  [ErrorCode.TENANT_READ_ONLY]: HttpStatus.FORBIDDEN,
  [ErrorCode.BRANCH_NOT_ALLOWED]: HttpStatus.FORBIDDEN,
  [ErrorCode.REVERSE_VIA_DOCUMENT]: HttpStatus.CONFLICT,
  [ErrorCode.VOUCHER_HAS_ALLOCATIONS]: HttpStatus.CONFLICT,
  [ErrorCode.UNBALANCED_ENTRY]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PERIOD_CLOSED]: HttpStatus.CONFLICT,
  [ErrorCode.STOCK_INSUFFICIENT]: HttpStatus.CONFLICT,
  [ErrorCode.BACKDATED_STOCK_POSTING]: HttpStatus.CONFLICT,
};

export class DomainError extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    const status = STATUS_BY_CODE[code] ?? HttpStatus.INTERNAL_SERVER_ERROR;
    super({ code, message, details }, status);
    this.code = code;
    this.details = details;
  }

  static notFound(entity: string, id: string): DomainError {
    return new DomainError(ErrorCode.NOT_FOUND, `${entity} not found`, { id });
  }
}
