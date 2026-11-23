# Phase 32 — Temporary receipt

**Authority:** [ADR-047](../decisions/ADR-047-phase30-consignment.md) and the Phase 32 section of [BUILD_PLAN.md](../BUILD_PLAN.md). The ADR filename remains unchanged; the internal `consignment` identifiers are intentionally preserved.

## 1. Delivered

- Kept the company setting, supplier-linked temporary warehouses, locking, pool isolation, branch scoping, post-time guards, and quantity reports.
- Temporary receipts accept no cost. `CONSIGNMENT_IN` ignores any client-supplied unit cost and posts stock at zero cost; supplier identity is derived from the warehouse and revalidated at posting.
- Sales and sales returns from temporary warehouses move stock at zero cost and post revenue/tax only. Sale rows retain quantity, returned quantity, and invoiced quantity; monetary tracking columns were removed.
- Supplier settlement invoices require an accountant-entered positive price per line, lock and validate open quantities, do not move stock, and post COGS or supplier-shortage expense, input tax, and supplier control.
- Settlement purchase returns reverse the corresponding COGS or shortage expense and input tax, and reduce invoiced quantity.
- Temporary-warehouse counts create no journal entry. Shortages create quantity-only stock-count rows.
- Removed the consignment payable account and GL verification mismatch. The 5209 supplier-shortage account is named “عجز بضاعة المورد / Supplier goods shortage”; enabling the feature requires its mapping.
- Updated the company setting, warehouse supplier field, goods-note forms, Purchases settlement flow, Consignment reports, menu gating, translations, and warehouse pickers.

## 2. Schema and migration

The single migration is `apps/api/prisma/migrations/20261123214852_phase32_temporary_receipt/migration.sql`. It removes the monetary consignment columns and the payable mapping/account, renames and conditionally maps account 5209, and preserves the quantity-only consignment rows.

## 3. API and screens

- Existing company and warehouse endpoints expose the feature setting and temporary-warehouse supplier.
- Goods notes support `CONSIGNMENT_IN` and `CONSIGNMENT_OUT`.
- Consignment APIs provide open sales, supplier statements, and ageing by quantity.
- Purchase invoices support linked supplier settlements and settlement returns through the existing purchase flows.
- Web screens cover the setting, warehouse supplier, receipt/return notes, open sales and settlement creation, statements, ageing, and purchase drafts/returns. Feature UI is hidden while the company setting is off.

## 4. Acceptance scenarios

The authoritative expected values remain unchanged:

| Scenario | Expected result |
| --- | --- |
| TR1 | Receive 10 units at zero cost; temporary pool and inventory account remain zero. |
| TR2 | Sell 3 at 35.000: cash 121.800, revenue 105.000, output tax 16.800; no COGS or payable. |
| TR3 | Return 1: reverse revenue 35.000 and tax 5.600 against cash 40.600; stock returns at zero cost. |
| TR4 | Settle 2 at 20.000: COGS 40.000, input tax 6.400, supplier control 46.400; stock does not move. |
| TR5 | Over-sale, duplicate settlement, disabled-feature, warehouse, branch, supplier, and post-time guards refuse invalid operations. |
| TR6 | Return 1 from the settlement: supplier control 23.200 against COGS 20.000 and input tax 3.200; invoiced quantity decreases. |
| TR7 | Count shortage creates no count journal; its settlement posts shortage expense 20.000, input tax 3.200, and supplier control 23.200. |
| TR8 | Return the remaining 8: stock is zero, inventory and owned-pool value are zero, the trial balance balances, and `stock:verify` has no mismatches. |

## 5. Verification

- `pnpm typecheck` and `pnpm lint` passed.
- `pnpm --filter api build` passed.
- Golden TR1–TR8 E2E: **4/4 tests passed**; chart-template spec: **9/9 tests passed**.
- `pnpm --filter web test`: **118 files, 950 tests passed**.
- `pnpm --filter web build` passed.
- Full `pnpm --filter api test` on `erp_phase32_full_1795472222_test`: **171 suites passed, 1 skipped; 1,939 tests passed, 7 skipped**. Jest reported open handles after printing its complete passing summary; the lingering runner was stopped.
- Fresh dedicated test databases received all 61 migrations and were seeded. The shared `erp_test` was not used.

## 6. Operations, known issues, and technical debt

No new operational commands were added. The local preview is supplied separately for visual review; the UI was not visually inspected as part of this implementation.

## 7. Decisions

No deviation from ADR-047 is known. The internal migration, tables, enums, routes, error codes, and mapping keys retain their `consignment` naming.
