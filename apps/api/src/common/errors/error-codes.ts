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
  // Ledger review 2026-11-13 (LEDGER-xx): specific accounting codes, so the
  // user sees why a request was refused instead of a generic VALIDATION/CONFLICT.
  ENTRY_NOT_DRAFT = 'ENTRY_NOT_DRAFT',
  ENTRY_NOT_POSTED = 'ENTRY_NOT_POSTED',
  ENTRY_ALREADY_REVERSED = 'ENTRY_ALREADY_REVERSED',
  REVERSAL_NOT_REVERSIBLE = 'REVERSAL_NOT_REVERSIBLE',
  REVERSAL_BEFORE_ORIGINAL = 'REVERSAL_BEFORE_ORIGINAL',
  OPENING_DATE_NOT_YEAR_START = 'OPENING_DATE_NOT_YEAR_START',
  ACCOUNT_NOT_POSTABLE = 'ACCOUNT_NOT_POSTABLE',
  ACCOUNT_INACTIVE = 'ACCOUNT_INACTIVE',
  ACCOUNT_HAS_BALANCE = 'ACCOUNT_HAS_BALANCE',
  ACCOUNT_IN_USE = 'ACCOUNT_IN_USE',
  ACCOUNT_HAS_CHILDREN = 'ACCOUNT_HAS_CHILDREN',
  ACCOUNT_TYPE_MISMATCH = 'ACCOUNT_TYPE_MISMATCH',
  PARTY_REQUIRED = 'PARTY_REQUIRED',
  PARTY_TYPE_MISMATCH = 'PARTY_TYPE_MISMATCH',
  PARTY_ON_NON_CONTROL_ACCOUNT = 'PARTY_ON_NON_CONTROL_ACCOUNT',
  MAPPING_ACCOUNT_INVALID = 'MAPPING_ACCOUNT_INVALID',
  MAPPING_LOCKED = 'MAPPING_LOCKED',
  FISCAL_YEAR_OVERLAP = 'FISCAL_YEAR_OVERLAP',
  FISCAL_YEAR_TOO_LONG = 'FISCAL_YEAR_TOO_LONG',
  DUPLICATE_CODE = 'DUPLICATE_CODE',
  INVALID_DATE_RANGE = 'INVALID_DATE_RANGE',
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
  // Trade review fixes (ADR-016): a GRN is billed by one purchase invoice only.
  GRN_ALREADY_INVOICED = 'GRN_ALREADY_INVOICED',
  // TRADE-07: a counted line's book balance changed since the count snapshot;
  // refresh the count, then approve again.
  STOCK_COUNT_STALE = 'STOCK_COUNT_STALE',
  // DB-15 / ADR-021: a document now references the party, so it can't be
  // deleted; deactivate it instead.
  PARTY_IN_USE = 'PARTY_IN_USE',
  // ADR-022 §7: a keyset cursor that is malformed, tampered, another read's or tenant's, or for other filters.
  CURSOR_INVALID = 'CURSOR_INVALID',
  // ADR-003 §13: a company-wide report needs access to every branch.
  ALL_BRANCHES_REQUIRED = 'ALL_BRANCHES_REQUIRED',
  INTERNAL = 'INTERNAL',
}
