# Phase 27 — Concurrent document entry

**Status:** In progress  
**Reference:** [ADR-042](../decisions/ADR-042-phase27-concurrent-entry.md)

## Scope

PR A added in-place quick-create and scoped local drafts. PR B adds lease-based edit locks to journal entries, receipts, payments, and draft sales/purchase invoices. PR C will add polling, active-editor indicators, and fresh picker data.

## Deliverables

- [x] Quick-create dialogs and local entry drafts from PR A (#88).
- [x] Database lock model, API, guarded mutations, web lock hook, and documentation for PR B.
- [ ] Status polling, active-editor indicators, and picker refresh for PR C.

## Schema and migration

PR B adds `document_edit_locks` with tenant/company/document uniqueness, composite tenant/company and tenant/membership relations, and a 120-second lease. Migration `20261121075842_document_edit_locks` was created with `prisma migrate dev` against the isolated `erp_document_locks_test_1795247760` database; its SQL was reviewed. The preview database was not used.

## Acceptance tests

- [x] Lock lifecycle, conflict details, heartbeat, takeover after DB-time expiry, and release.
- [x] Edit-lock enforcement and lock release for all five document types.
- [x] Other mutations reject a different live holder.
- [x] Force-release permission and audit record.
- [x] Tenant/company isolation and concurrent acquisition.
- [x] Web lock states and request headers.

API build, API/web typechecks, and API/web lint pass. The affected API and web specs pass. The full `pnpm test` run against the isolated database completed with 151 suites passed, 2 failed, and 1 skipped (1,796 tests passed, 2 failed, and 7 skipped). Both failures are pre-existing payroll checks: missing OpenAPI response schemas and a `POSTING_TX_OPTIONS` check at `payroll.service.ts:242`; the corresponding payroll sources and tests are unchanged from `origin/main`.

## Known follow-up

PR C remains necessary for periodic status refresh, active-editor presence, and current picker data across tabs. No new operational command is introduced in PR B; the existing `job:purge-expired` also removes locks expired by more than one day.
