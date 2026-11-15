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
  // Cost centres (ADR-024 §1): a flagged account's line has no centre while centres are on.
  COST_CENTER_REQUIRED = 'COST_CENTER_REQUIRED',
  // ADR-024 §1.1: centres are for income-statement (REVENUE / EXPENSE) accounts only.
  COST_CENTER_NOT_ALLOWED = 'COST_CENTER_NOT_ALLOWED',
  COST_CENTER_INACTIVE = 'COST_CENTER_INACTIVE',
  // ADR-024 §1.4: only a leaf centre takes lines.
  COST_CENTER_NOT_POSTABLE = 'COST_CENTER_NOT_POSTABLE',
  COST_CENTER_HAS_CHILDREN = 'COST_CENTER_HAS_CHILDREN',
  // ADR-024 §1.7 / ADR-021: a used centre is deactivated, never deleted.
  COST_CENTER_IN_USE = 'COST_CENTER_IN_USE',
  PARTY_REQUIRED = 'PARTY_REQUIRED',
  PARTY_TYPE_MISMATCH = 'PARTY_TYPE_MISMATCH',
  PARTY_ON_NON_CONTROL_ACCOUNT = 'PARTY_ON_NON_CONTROL_ACCOUNT',
  MAPPING_ACCOUNT_INVALID = 'MAPPING_ACCOUNT_INVALID',
  MAPPING_LOCKED = 'MAPPING_LOCKED',
  FISCAL_YEAR_OVERLAP = 'FISCAL_YEAR_OVERLAP',
  FISCAL_YEAR_TOO_LONG = 'FISCAL_YEAR_TOO_LONG',
  DUPLICATE_CODE = 'DUPLICATE_CODE',
  INVALID_DATE_RANGE = 'INVALID_DATE_RANGE',
  // ADR-016 §5: a purchase return's goods leave from the original invoice's warehouse.
  RETURN_WAREHOUSE_MISMATCH = 'RETURN_WAREHOUSE_MISMATCH',
  // ADR-016 §5: the original invoice has no warehouse (services only), and none was given.
  RETURN_WAREHOUSE_REQUIRED = 'RETURN_WAREHOUSE_REQUIRED',
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
  // ADR-024 §2.2: the procurement level is lowered only when no purchasing
  // cycle document is open (details.openDocuments counts them by kind).
  PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS = 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS',
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
  // ADR-025 §5: the company's procurement level is below what the document
  // needs (details.required, details.current): FULL for requests and quotes, MEDIUM for orders.
  PROCUREMENT_LEVEL_REQUIRED = 'PROCUREMENT_LEVEL_REQUIRED',
  // ADR-025 §4: at MEDIUM or FULL a purchase invoice (a direct purchase) needs
  // purchase.direct for anyone but an owner.
  PURCHASE_DIRECT_REQUIRED = 'PURCHASE_DIRECT_REQUIRED',
  // ADR-025 §2: nobody but an owner approves a document they created.
  APPROVAL_SELF_NOT_ALLOWED = 'APPROVAL_SELF_NOT_ALLOWED',
  // ADR-025 §2: the order total is above the member's approval limit (details.amount,
  // details.limit); an owner approves it.
  APPROVAL_LIMIT_EXCEEDED = 'APPROVAL_LIMIT_EXCEEDED',
  // ADR-025 §1: at FULL every purchase order comes from an approved purchase request.
  PURCHASE_REQUEST_REQUIRED = 'PURCHASE_REQUEST_REQUIRED',
  // ADR-025 §9: the ordered quantities would exceed what is left on the request line
  // (details.requestLineId, details.remaining).
  PURCHASE_REQUEST_QTY_EXCEEDED = 'PURCHASE_REQUEST_QTY_EXCEEDED',
  // ADR-025 §7: the action does not apply to the document's status (details.status).
  INVALID_STATUS_TRANSITION = 'INVALID_STATUS_TRANSITION',
  // Review #47: a purchase order whose grand total is 0 is not submitted (a price left blank).
  PURCHASE_ORDER_ZERO_TOTAL = 'PURCHASE_ORDER_ZERO_TOTAL',
  // ADR-026 §4: a receipt above what is left on the order line (details.poLineId,
  // details.remaining, details.wanted).
  PURCHASE_ORDER_OVER_RECEIPT = 'PURCHASE_ORDER_OVER_RECEIPT',
  // ADR-026 §3: an invoice on a purchase order bills posted receipts of that order only;
  // none yet (or a stocked line without its receipt line).
  PURCHASE_ORDER_NOT_RECEIVED = 'PURCHASE_ORDER_NOT_RECEIVED',
  // ADR-026 §7: the billed quantity is above what is received and not billed yet
  // (details.grnLineId, details.unbilled, details.wanted).
  PURCHASE_BILL_EXCEEDS_RECEIPT = 'PURCHASE_BILL_EXCEEDS_RECEIPT',
  // ADR-026 §2: a line is priced above the order and the difference is not approved
  // (details.lines).
  PURCHASE_PRICE_ABOVE_ORDER = 'PURCHASE_PRICE_ABOVE_ORDER',
  // ADR-026 §9: at FULL a goods issue without an approved issue request needs
  // stock.issue_without_request (owners aside).
  ISSUE_REQUEST_REQUIRED = 'ISSUE_REQUEST_REQUIRED',
  // ADR-026 §9: the issued quantity is above what is left on the request line
  // (details.requestLineId, details.remaining, details.wanted).
  ISSUE_REQUEST_QTY_EXCEEDED = 'ISSUE_REQUEST_QTY_EXCEEDED',
  // ADR-026 §9: an issue from a request is to the request's cost centre and expense
  // account (details.field, details.requestValue).
  ISSUE_REQUEST_DEPARTMENT_MISMATCH = 'ISSUE_REQUEST_DEPARTMENT_MISMATCH',
  INTERNAL = 'INTERNAL',
}
