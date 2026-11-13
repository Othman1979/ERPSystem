/**
 * Canonical API error codes. Add new codes here and translate them in the web app
 * (ar + en) per docs/BUILD_PLAN.md section 15.
 */
export enum ErrorCode {
  VALIDATION = 'VALIDATION',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  PLAN_LIMIT_EXCEEDED = 'PLAN_LIMIT_EXCEEDED',
  DB_UNAVAILABLE = 'DB_UNAVAILABLE',
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',
  TENANT_READ_ONLY = 'TENANT_READ_ONLY',
  // Accounting & inventory codes (used from Phase 3+)
  UNBALANCED_ENTRY = 'UNBALANCED_ENTRY',
  PERIOD_CLOSED = 'PERIOD_CLOSED',
  STOCK_INSUFFICIENT = 'STOCK_INSUFFICIENT',
  BACKDATED_STOCK_POSTING = 'BACKDATED_STOCK_POSTING',
  BRANCH_NOT_ALLOWED = 'BRANCH_NOT_ALLOWED',
  REVERSE_VIA_DOCUMENT = 'REVERSE_VIA_DOCUMENT',
  VOUCHER_HAS_ALLOCATIONS = 'VOUCHER_HAS_ALLOCATIONS',
  // §8.6: opening stock enters through an OPENING stock adjustment only.
  OPENING_INVENTORY_VIA_STOCK = 'OPENING_INVENTORY_VIA_STOCK',
  // Phase 9 — uploads (logo, import files)
  UPLOAD_TOO_LARGE = 'UPLOAD_TOO_LARGE',
  UPLOAD_TYPE_NOT_ALLOWED = 'UPLOAD_TYPE_NOT_ALLOWED',
  // Phase 7 — JoFotara (docs/decisions/0005)
  EINVOICE_BUYER_REQUIRED = 'EINVOICE_BUYER_REQUIRED',
  EINVOICE_REASON_REQUIRED = 'EINVOICE_REASON_REQUIRED',
  EINVOICE_NOT_READY = 'EINVOICE_NOT_READY',
  // Phase 8 — reports
  REPORT_TOO_LARGE = 'REPORT_TOO_LARGE',
  // 429: too many requests in a minute (ADR-011)
  RATE_LIMITED = 'RATE_LIMITED',
  // Password change and reset (ADR-012): the current password did not match.
  INVALID_CURRENT_PASSWORD = 'INVALID_CURRENT_PASSWORD',
  // Password change and reset (ADR-012): a temporary password must be replaced
  // before any other request is served.
  PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED',
  // Password change and reset (ADR-012): this member's password may not be reset here.
  PASSWORD_RESET_NOT_ALLOWED = 'PASSWORD_RESET_NOT_ALLOWED',
  // Sign-in refused for a while after repeated wrong passwords for this email (ADR-012 §Sign-in protection).
  LOGIN_LOCKED = 'LOGIN_LOCKED',
  // 413: the request body is over the JSON limit (2 MB).
  PAYLOAD_TOO_LARGE = 'PAYLOAD_TOO_LARGE',
  // A document has more lines than MAX_DOCUMENT_LINES (500).
  DOCUMENT_TOO_MANY_LINES = 'DOCUMENT_TOO_MANY_LINES',
  // Invitation acceptance code wrong, expired or out of attempts (ADR-012 §PLAT-10).
  INVITATION_CODE_INVALID = 'INVITATION_CODE_INVALID',
  INTERNAL = 'INTERNAL',
}
