# Phase 27 — Concurrent document entry

**Status:** Complete
**Reference:** [ADR-042](../decisions/ADR-042-phase27-concurrent-entry.md)

## 1. Delivered scope

- [x] PR A (#88): in-place quick-create for accounts, parties, and items; scoped local drafts and safe recovery.
- [x] PR B: lease-based edit locks for journal entries, receipts, payments, and draft sales/purchase invoices; guarded mutations and audited force release.
- [x] PR C: fresh lists and pickers, view-only detail polling, lock-status polling, and active-editor banners for the five document types.
- [x] Existing window-focus freshness in `main.tsx` and the reference-data five-minute `staleTime` were preserved.

## 2. Tables and migrations

PR B added `document_edit_locks`, with tenant/company/document uniqueness, composite tenant relations, and a 120-second lease. Migration `20261121075842_document_edit_locks` was created with `prisma migrate dev` against the isolated `erp_document_locks_test_1795247760` database. PR C is web-only and adds no API, schema, or migration changes.

## 3. Endpoints and screens

PR B added the document-lock acquire, heartbeat, release, force-release, and status endpoints.

PR C adds list polling at 30 seconds for journal entries, receipts/payments, sales invoices, purchase invoices, and treasury balances. Document details poll at 30 seconds on view screens only; the existing four-second in-flight sales e-invoice refresh retains precedence. Lock status polls at 15 seconds and refreshes on focus. Remote and grid picker results older than 10 seconds refresh when opened.

The journal-entry, receipt/payment voucher, sales-invoice, and purchase-invoice view screens show the active editor's name and acquisition time. A member with `document.unlock` can confirm a force release from the banner. View actions that conflict with another holder are disabled with a tooltip; server enforcement remains authoritative.

## 4. Acceptance tests

- [x] Lock lifecycle, conflict details, heartbeat, DB-time expiry/takeover, and release.
- [x] Lock enforcement and same-transaction release for all five document types.
- [x] Other mutations reject a different live holder.
- [x] Force-release permission and audit record.
- [x] Tenant/company isolation and concurrent acquisition.
- [x] Web lock states and request headers.
- [x] Configured list polling and no polling when unset.
- [x] Stale picker refresh on open; fresh picker data is not refetched.
- [x] Grid picker `onOpen` for typing and ArrowDown.
- [x] Lock-status polling and active-editor view behavior.
- [x] Detail polling is disabled while the invoice form is open.

**PR C verification:** `pnpm --filter web test` passed (104 files, 893 tests). Root `pnpm typecheck` and `pnpm lint` passed. The focused Journal page spec passed (9 tests), and the focused Purchases/Treasury page specs passed (10 tests).

## 5. Commands

No new operational command was introduced. Existing `job:purge-expired` also removes document locks that expired more than one day ago.

## 6. Known limitations and technical debt

- List rows do not show a lock icon.
- WebSockets are not used; inbound WebSocket support would require moving the application to a VPS.
- Polling is bounded and avoids background refetching where configured.

## 7. Decisions

See [ADR-042](../decisions/ADR-042-phase27-concurrent-entry.md): first-opener lease ownership, database-time expiry, bounded polling, and local drafts as recovery rather than authorization.

## 8. Before the next phase

No phase-27 implementation work remains. Review the PR C verification results and proceed with the next planned phase.
