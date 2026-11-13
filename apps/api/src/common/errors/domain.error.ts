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
  [ErrorCode.OPENING_INVENTORY_VIA_STOCK]: HttpStatus.BAD_REQUEST,
  [ErrorCode.UPLOAD_TOO_LARGE]: HttpStatus.PAYLOAD_TOO_LARGE,
  [ErrorCode.UPLOAD_TYPE_NOT_ALLOWED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.EINVOICE_BUYER_REQUIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.EINVOICE_REASON_REQUIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.EINVOICE_NOT_READY]: HttpStatus.BAD_REQUEST,
  [ErrorCode.REPORT_TOO_LARGE]: HttpStatus.PAYLOAD_TOO_LARGE,
  [ErrorCode.RATE_LIMITED]: HttpStatus.TOO_MANY_REQUESTS,
  // Wrong current password on change-password (ADR-012).
  [ErrorCode.INVALID_CURRENT_PASSWORD]: HttpStatus.BAD_REQUEST,
  // Signed in with a temporary password: only change-password and /me are allowed (ADR-012).
  [ErrorCode.PASSWORD_CHANGE_REQUIRED]: HttpStatus.FORBIDDEN,
  // Reset refused by the rules in UsersService.resetPassword (ADR-012).
  [ErrorCode.PASSWORD_RESET_NOT_ALLOWED]: HttpStatus.FORBIDDEN,
  // Ledger review 2026-11-13: 400 = the request itself is wrong, 409 = the
  // entry or account is in a state that refuses it.
  [ErrorCode.ENTRY_NOT_DRAFT]: HttpStatus.CONFLICT,
  [ErrorCode.ENTRY_NOT_POSTED]: HttpStatus.CONFLICT,
  [ErrorCode.ENTRY_ALREADY_REVERSED]: HttpStatus.CONFLICT,
  [ErrorCode.REVERSAL_NOT_REVERSIBLE]: HttpStatus.CONFLICT,
  [ErrorCode.REVERSAL_BEFORE_ORIGINAL]: HttpStatus.BAD_REQUEST,
  [ErrorCode.OPENING_DATE_NOT_YEAR_START]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ACCOUNT_NOT_POSTABLE]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ACCOUNT_INACTIVE]: HttpStatus.BAD_REQUEST,
  [ErrorCode.ACCOUNT_HAS_BALANCE]: HttpStatus.CONFLICT,
  [ErrorCode.ACCOUNT_IN_USE]: HttpStatus.CONFLICT,
  [ErrorCode.ACCOUNT_HAS_CHILDREN]: HttpStatus.CONFLICT,
  [ErrorCode.ACCOUNT_TYPE_MISMATCH]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PARTY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PARTY_TYPE_MISMATCH]: HttpStatus.BAD_REQUEST,
  [ErrorCode.PARTY_ON_NON_CONTROL_ACCOUNT]: HttpStatus.BAD_REQUEST,
  [ErrorCode.MAPPING_ACCOUNT_INVALID]: HttpStatus.BAD_REQUEST,
  [ErrorCode.MAPPING_LOCKED]: HttpStatus.CONFLICT,
  [ErrorCode.FISCAL_YEAR_OVERLAP]: HttpStatus.CONFLICT,
  [ErrorCode.FISCAL_YEAR_TOO_LONG]: HttpStatus.BAD_REQUEST,
  [ErrorCode.DUPLICATE_CODE]: HttpStatus.CONFLICT,
  [ErrorCode.INVALID_DATE_RANGE]: HttpStatus.BAD_REQUEST,
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
