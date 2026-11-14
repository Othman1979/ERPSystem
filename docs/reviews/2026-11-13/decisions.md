# Owner decisions for the 2026-11-13 review fixes

**Approval:** on 2026-11-13 the owner said to close every finding and follow the reports' recommendations.

**How to use this file:**
- Where a report recommended an option, that option is taken.
- Where a report gave choices without a recommendation, the option below was picked: it is the one most consistent with `docs/BUILD_PLAN.md`, the golden scenarios (§18) and least privilege.
- Every decision that changes accounting, stock or security behaviour gets an ADR in `docs/decisions/`, written by the session that implements it. The ADR cites this file as the approval.
- Golden-scenario expected numbers are never changed. If a decision would change one, stop and report it.

## Accounting (review-ledger)
- **D-1 `REVERSED` status:** derive "reversed" from the existence of a reversal entry. Add a unique constraint on `reversal_of_id` (this also closes LEDGER-02), and update the BUILD_PLAN §8.2 text to match. No new status.
- **D-2 party on a non-control account:** reject at posting.
- **D-3 opening entry date:** it must equal the start date of the fiscal year it falls in. A company that starts mid-year creates a fiscal year that starts on its go-live date.
- **D-4 PDF row limit:** raise it from 1,000 to 10,000 rows. Repeat the table header on every page and number the pages.
- **D-5 monthly balance projection:** not now. Use indexes only (LEDGER-19, the database index plan).
- **D-6 rate limit:** 300 requests per minute per authenticated user. The login and register limits stay as they are. Update ADR-011.

## Inventory and trade (review-trade, review-database)
- **TRADE-02, a GRN and then a purchase invoice for the same goods:**
  - Implement option (b): a purchase invoice can reference a posted GRN (`received_grn_id`). Its lines then clear account 2104 (goods received, not invoiced) instead of moving stock again.
  - The price difference between invoice and GRN goes to the `INVENTORY_ADJUSTMENT` mapping.
  - A GRN can be invoiced once.
  - Lines of an invoice linked to a GRN must not exceed the GRN quantities.
- **TRADE-03, cost of a purchase return:** option (b). Stock goes out at the original purchase line's unit cost, as in §9.5.
- **DB-04 and DB-05, reversals:** a reversal of a transfer or an adjustment mirrors the original movements' costs, so stock value and the GL never drift apart.
- **TRADE-06, prices including tax:**
  - Implement it with this rounding rule: `net = round3(gross / (1 + rate))` and `tax = gross − net`. The document total equals what the user typed.
  - Write an ADR and add a new golden scenario test. The existing golden numbers are untouched.
- **TRADE-12, returns:**
  - A CREDIT return is allowed only against a CREDIT invoice. A CASH invoice is refunded in cash.
  - A credit return may exceed the invoice's remaining balance. It creates a credit balance for the customer.
- **TRADE-07, stock counts:**
  - Approval is refused (new error code) if any counted line's book balance changed since the count snapshot. The user refreshes the snapshot and approves again.
  - Approval is atomic and requires an `Idempotency-Key`.
- **Negative stock (DB-19, trade §4-6):**
  - When the quantity returns to zero or below and then comes back up, the value resets. The new average is the incoming cost, and any residual value goes to `INVENTORY_ADJUSTMENT`.
  - Write an ADR. The `allowNegativeStock` setting stays off by default.
- **Reversing invoices and GRNs:** this is out of scope. Corrections are made by a full return, as today. Write this in the trade ADR.
- **TRADE-24, PRODUCTION e-invoicing:** it is refused unless `NODE_ENV=production` or the explicit variable `EINVOICE_ALLOW_PRODUCTION=true` is set.
- **ADR-003, branch-restricted users:** reads, lists and prints are restricted to the allowed branches, like writes. This is implemented in wave 3, together with pagination.

## Platform (review-platform)
- **USER_MANAGE:** remove it from the ACCOUNTANT role. User management belongs to the OWNER only.
- **Invitations:**
  - For an existing user, an `INVITED` membership that the user accepts themself.
  - For a new user, a generated temporary password with `mustChangePassword`. The inviter can no longer choose the password.
- **Public registration:** a strict rate limit only. There is no mail service yet.
- **Account lockout:** add an escalating delay per email, in memory (one instance).
- **Document size:**
  - At most 500 lines per document.
  - A JSON body limit of 2 MB.
  - Both get clear error codes.
- **Backups:** encrypt off-server copies with AES-256-GCM, using Node `crypto` and the `BACKUP_ENCRYPTION_KEY` env var. Add the variable to `.env.example` and the config schema.

## Web (review-web-eng)
- **Pagination (WEB-02, TRADE-14, LEDGER-08, PLAT-13):**
  - One contract for every list: `page`, `pageSize`, `total`.
  - Item and party pickers search on the server.
  - Write an ADR. This is wave 3.
- **Response DTOs in OpenAPI (WEB-12):** yes. Typed responses for every controller, wave 3.
- **Compression (WEB-11):** pre-compressed static assets (gzip and brotli at build time) served by the Node server, plus the `compression` middleware for API JSON.
- **Cache policy (WEB-13):** reference data (accounts, warehouses, taxes, branches, units) gets `staleTime` of 5 minutes and is invalidated on mutation.

## Design (review-ui-design)
- **Ink:** `#1f3a5f` (`ink-600` in §6.1). The top bar is ink (`ink-900`).
- **Surfaces:** warm, `#fbfaf7` and `#f4f2ee`. No pure white anywhere.
- **Credit balances:**
  - In the trial balance and statements: Dr and Cr columns.
  - Elsewhere: a «دائن» or "Cr" suffix.
  - Red only for a balance on the wrong side of its account's nature.
- **Month names:** Levantine Arabic (كانون الثاني … كانون الأول).
- **Mobile:** lists are usable on a phone, with priority columns that hide low-priority columns under 576 px, and document forms work in one column.
- **The «نشط» tag:** hidden. Only «غير نشط» is shown.
