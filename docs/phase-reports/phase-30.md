# Phase 30 — Consignment stock

**Reference:** [ADR-047](../decisions/ADR-047-phase30-consignment.md) and CS1–CS8 in [BUILD_PLAN §18](../BUILD_PLAN.md#18-السيناريوهات-الذهبية).
**Scope of this delivery:** consignment stock accounting and workflows in the backend. No consignment UI screens were added.

## Completed

- Added the company-level consignment feature switch and guards for disabled companies.
- Added company-scoped consignment suppliers to warehouses, including supplier validation and immutability after stock movement.
- Separated owned and consignment item-cost pools, enforced non-negative consignment stock, and made stock costing, valuation, verification, and GL reconciliation pool-aware.
- Added consignment goods notes, sales, returns, stock-count shortages, settlement invoices, and settlement purchase returns, using the existing posting and stock-ledger services.
- Added workflow guards for transfers, purchasing, production, issue requests, normal goods notes, manual adjustments, and recipe-based sales from consignment warehouses.
- Added bounded supplier statements and sold-not-invoiced aging reports, English and Arabic error translations, and tenant export/integrity-check support for consignment sales.
- Added OpenAPI response schemas and regenerated the typed API client. The existing goods-notes page only gained enum compatibility; no consignment UI was introduced.

## Schema and migrations

- `20261123180935_phase30_consignment` — company and warehouse settings, pool-aware `item_costs`, consignment sales, purchase invoice settlement fields, goods-note types, and account mappings.
- `20261123183142_phase30_consignment_sequences` — idempotently adds CIN/COUT number sequences for existing fiscal years.
- Added `ConsignmentSale` to tenant-scoped Prisma infrastructure, tenant export, and integrity checking.

The follow-up sequence migration was added after the focused E2E test found existing fiscal years without CIN/COUT sequences. The initial migration had already been applied to the dedicated test database, so it was not rewritten.

## API and operational commands

- Added `GET /api/v1/consignment/open-sales`, `GET /api/v1/reports/consignment-statement`, and `GET /api/v1/reports/consignment-aging`.
- Existing purchase-invoice draft and posting flows support consignment settlement; goods-note APIs support `CONSIGNMENT_IN` and `CONSIGNMENT_OUT`.
- No new permissions or operational commands were added.

## Acceptance and verification

- [x] CS1–CS8 golden E2E: **1/1 passed**; authoritative expected amounts were not changed.
- [x] Tenant and company isolation, separate-connection sales and settlement races, feature disablement, workflow guards, and warehouse supplier immutability are covered by the consignment E2E.
- [x] Integrity-check E2E: **6/6 passed**, including the consignment sale source check.
- [x] OpenAPI contract and consignment golden E2E after response-schema and SQL isolation fixes: **2 suites, 15 tests passed**.
- [x] Static tenant-isolation guard: **7/7 passed**.
- [x] `pnpm typecheck`, `pnpm lint`, and `pnpm --filter api build` passed.
- [x] API client regenerated from the built API's OpenAPI document.
- [x] Final full `pnpm --filter api test` result: **171 suites passed, 1 skipped; 1,935 tests passed, 7 skipped**. After printing its completed summary, Jest remained alive and reported open asynchronous handles; the runner was terminated.
- [x] `git diff --check` passed before delivery.

## Known limits and next phase

- No ADR-047 behavior was intentionally omitted. The only migration-plan deviation is the additive sequence migration described above.
- Consignment UI remains out of scope for this backend delivery.
