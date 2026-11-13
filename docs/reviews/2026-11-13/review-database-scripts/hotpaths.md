# Hot-path review (read-only) - apps/api/src

Paths are relative to `apps/api/src`. "Unproven" = reasoned from code, not reproduced. Note: the code lives under `platform/*`, not the per-module layout in CLAUDE.md.

## Findings

### 1. [HIGH] No interactive-transaction timeout: Prisma default is 5 s, not the required 30 s
- Every posting uses `db.$transaction(async (tx) => {...})` with no options. E.g. `platform/sales/sales-invoices.service.ts:460`. Same for purchases, returns, adjustments, transfers, goods notes, journal and vouchers. About 50 call sites in total.
- `grep "timeout: 30000"` finds nothing. `tenant-prisma.ts` does not wrap `$transaction`. Only `jobs/tenant-purge.service.ts:135` sets `{ timeout: 120_000 }`.
- CLAUDE.md requires `timeout: 30000`. The Prisma default is `timeout 5000` and `maxWait 2000` (`generated/prisma/internal/prismaNamespace.ts:6483-6484`).
- A posting waits on the document lock, then item_costs and stock_balances locks, then the global JOURNAL_ENTRY sequence lock. Under contention that queue can easily pass 5 s.
- The result is a P2028 "Transaction already closed" error. `withRetry` does not retry it, and the user sees a 500.
- Fix: pass `{ timeout: 30000, maxWait: 5000 }` through one shared helper.

### 2. [HIGH] Stock lock order is not item-then-warehouse ascending in most posting paths
- `StockLedgerService.applyMovement` locks per call in the order item_costs, then stock_balances (`stock-ledger.service.ts:99-100`). That is consistent inside one movement.
- Across lines, the order is up to the caller. Only transfers sort, by itemId: `inventory/transfers.service.ts:211` and `:318`.
- Not sorted, so they use lineNo order:
  - sales invoices: `sales-invoices.service.ts:517`
  - purchase invoices: `purchase-invoices.service.ts:~463`
  - sales returns: `sales-returns.service.ts:~401`
  - purchase returns: `purchase-returns.service.ts:~337`
  - adjustments, post and reverse: `adjustments.service.ts:~226` and `:~400`
  - goods notes: `goods-notes.service.ts:~235`
- Two documents holding items {A,B} in opposite line order can deadlock (A locked by T1, B by T2). InnoDB aborts one with 1213.
- Retry is one shot only (`shared/document-support.service.ts:73-82`), so a repeat deadlock surfaces as an error.
- The transfer sort is also unsafe. `Number(a.itemId - b.itemId)` converts a BigInt difference to a JS number. It is fine for realistic ids, but it is a `Number()` on a BigInt diff and loses sign for differences above 2^53.
- Fix: sort lines by (itemId, warehouseId) before the loop in every path, with one shared comparator. Keep the original line order only for journal output.
- A pre-lock pass that locks all `item_costs` rows in ascending order before any movement would be simpler.

### 3. [HIGH] `lockCost` / `lockBalance` use findFirst-then-create, a race on first movement of an item or warehouse
- `stock-ledger.service.ts:241-249` and `:279-285`.
- Two concurrent first postings of the same item (or item and warehouse pair) both see no row, and both `create`.
- The unique key is `@@unique([tenantId, companyId, itemId])` (`schema.prisma:1046`), so the second gets P2002 or blocks on the unique-index insert lock.
- P2002 is not handled or retried here. `withRetry` only matches P2034 and /deadlock|lock wait timeout/.
- Two inserts of the same key, each followed by a FOR UPDATE, can also deadlock on the lock upgrade.
- Fix: `INSERT ... ON DUPLICATE KEY UPDATE id = id` (or `INSERT IGNORE`), then SELECT ... FOR UPDATE.
- Better, create the rows when an item is created, or pre-create them in the sorted pre-lock pass.
- The FOR UPDATE itself is on a unique key with an existing row, so it takes only a record lock, no gap lock.

### 4. [HIGH] Backdating rule is global per item and reversals can hit it; the "cancel" path costs at average, not at original cost
- Detection is at `stock-ledger.service.ts:104-112`. It compares `movementDate < item_costs.last_movement_date`, one value per company and item across ALL warehouses.
  - There is no query or index for it. It reads the locked projection row, which is cheap and correct.
  - But a movement in warehouse X blocks a backdated document in warehouse Y. This may be intended by the spec, but I did not verify it.
- `last_movement_date` is set to the input date (`:167`). Since backdating is rejected it never decreases, so that is consistent.
- Date comparison: `new Date(cost.lastMovementDate.toISOString().slice(0,10))` against `input.movementDate`.
  - `last_movement_date` is `DateTime(3)` (`schema.prisma:1038`) while `movement_date` is `@db.Date`.
  - Timezone shifts between the driver and the ISO conversion could make same-day comparisons off by a day. Unproven.
- Adjustment reversal (`adjustments.service.ts:~395-420`):
  - Reversing an IN uses OUT at the CURRENT average (`unitCost: wasIn ? undefined : unitCost`).
  - Only the reverse of an OUT uses the original cost.
  - If cost changed in between, inventory value and the reversal journal (built from `res.totalCost`) do not mirror the original. The comment "uses the ORIGINAL unit cost" is only true for one direction.
  - The reversal date must also be >= `last_movement_date`, otherwise BACKDATED_STOCK_POSTING. So a reversal fails once any later movement exists. This looks like deliberate "no backdating", but it makes old adjustments unreversible.
- Transfer reversal sorts by item (`transfers.service.ts:318`) and goes through the same ledger path.

### 5. [MEDIUM] Unit cost stored at 3 dp on movements and document lines, contradicting the 6 dp rule
- `stock_movements.unit_cost` is `Decimal(18,3)` (`schema.prisma:991`). The same holds for `StockAdjustmentLine` (:1089), `PurchaseInvoiceLine` (:1431), `PurchaseReturnLine` (:1573) and `GoodsNoteLine` (:1635).
- `SalesInvoiceLine` and `SalesReturnLine` are 6 dp (:1360, :1510).
- The ledger computes `unitCost` at full or 6 dp precision, then the DB truncates it to 3 dp on write.
- Consequences:
  - A reversal of an OUT adjustment re-enters the stock at the 3 dp unit cost: `qty * unit_cost` differs from the original `total_cost`.
  - For a purchase invoice, the unit cost is `net/qty` at 40 digits (`purchase-invoices.service.ts:~468`). The IN `totalCost` is `round3(qty*unitCost)`, which equals net, but the stored unit_cost is rounded.
  - Anything that recomputes value as `qty * unit_cost` from rows will drift.
- Fix: widen those columns to Decimal(18,6). It is a migration on financial tables, so it needs review.

### 6. [MEDIUM] Negative stock (allowNegativeStock) corrupts the average
- `applyOut` (`stock-ledger.service.ts:209-232`):
  - When `cost.totalQty <= qty` and not equal, `newTotalQty` goes negative.
  - `newTotalValue` goes negative, and `newAvg` is forced to 0 (`:228`).
  - The next IN computes `(negativeValue + inValue) / (inQty - deficit)`, which is not a meaningful average.
- An OUT while `avg_cost` is 0 gives zero COGS.
- The gate for negative stock is per-warehouse `stock_balances.qty_on_hand` (`:125`), but the cost is company-wide. They can disagree.
- Only reachable when `company.allowNegativeStock` is true. Needs a decision (ADR) on the cost of oversold units.

### 7. [MEDIUM] Global JOURNAL_ENTRY sequence row serializes ALL postings per tenant and holds the lock to commit
- `journal/posting.service.ts:329-351`: `SELECT ... FROM document_sequences ... FOR UPDATE`, then an update, inside the posting tx.
- Every posting also takes the JOURNAL_ENTRY row. So each tenant-year effectively has one posting at a time, from the sequence lock until commit.
- Combined with finding 1, this explains lock-wait timeouts under concurrency.
- Lock order is consistent: doc sequence, then JOURNAL_ENTRY (sales `:588`, `:591`; vouchers `:117`, `:120`). The lock is taken after the stock locks everywhere. No deadlock found there.
- Numbering behaviour:
  - Gapless: allocation is inside the posting tx, so a rollback loses nothing.
  - Unique key `@@unique([tenantId, companyId, documentType, fiscalYearId])` on document_sequences (`schema.prisma:739`).
  - Document numbers are unique per tenant: `@@unique([tenantId, invoiceNo])` and the like (:1338, :1417, ...). The prefix includes the year code.
  - Two companies in one tenant using the same prefix would collide. Unproven.
- The sequence row is a point lookup on a unique key, so there are no gap locks. A missing row throws VALIDATION (`:340-345`), with no insert-if-missing.
- Possible improvement: allocate the JOURNAL_ENTRY number last, immediately before the insert, to shorten the hold. It already is near the end.

### 8. [MEDIUM] Period state is read without a lock, so a posting can slip into a period closing concurrently
- `resolveOpenPeriod` (`posting.service.ts:275-303`) is a plain snapshot read. `setPeriodStatus` / `setYearStatus` (`accounting/fiscal.service.ts:162-211`) does `updateMany` with no coordination with in-flight postings.
- A post that read OPEN before the close commits can commit after it. Window is small. Unproven in practice.
- Fix: `SELECT ... FOR SHARE` on the period row in posting, or take FOR UPDATE on it in close.

### 9. [MEDIUM] Isolation, pool and retry
- `prisma/prisma.service.ts:12-31`: `initSql: SET @erp_si = 0 /*M!110602 , SESSION innodb_snapshot_isolation = OFF */`. This is correct for MariaDB 11.6.2 and later, and runs per connection.
  - It relies on `initSql` running on every new connection (the mariadb package does this). I did not verify against the Prisma adapter.
  - No isolation level is set, so the server default REPEATABLE READ applies.
  - The doc `FOR UPDATE` is the first statement in each tx, which gives a fresh view for later consistent reads. That is good.
- `connectionLimit: 10` is hard-coded in `parseDatabaseUrl` (`:26`). Query-string options (`connection_limit`, etc.) are ignored; only host, port, user, password and database are parsed.
  - With posting transactions holding connections for seconds, 10 connections is the concurrency ceiling across all tenants.
  - Prisma's `maxWait` is 2 s (default), so a burst gets "Unable to start a transaction in the allotted time".
  - There is no env override. The pool is also not configured for the other settings (acquire timeout, idle).
- `withRetry` (`shared/document-support.service.ts:73-82`):
  - One retry only.
  - The regex matches message text, `deadlock|lock wait timeout`. It does not match 1213 / 1205 by code.
  - Adjustments, transfers and journal each have their own copy (`adjustments.service.ts:20,498`, `transfers.service.ts:19`, `journal.service.ts:29`). Consolidate.
  - No backoff or jitter.
  - Retrying the whole `$transaction` is only safe if no external side effects occurred. The outbox rule makes that true.

### 10. [MEDIUM] `verify()` checks only qty, loads everything into memory, and nothing rebuilds projections
- `stock-ledger.service.ts:296-348`:
  - `findMany` of ALL movements for the tenant, then a JS Map. It is unbounded: O(total movements) memory.
  - The `orderBy` is useless for a sum.
  - It should be one `groupBy(warehouseId, itemId)` with `_sum`.
- It does not check `item_costs.total_qty` / `total_value` / `avg_cost` against movements. It does not check that the inventory GL account equals the valuation total.
- Only exposed as `GET stock-reports/verify` (`stock-reports.controller.ts:92`). There is no CLI job although CLAUDE.md's rules call it `stock:verify`. There is no rebuild or repair routine.
- Because WAC is path-dependent, a rebuild must replay movements in (date, id) order. That exists nowhere.

### 11. [LOW] Reports
- Trial balance (`journal/reports.service.ts:232`) uses `groupBy` in the DB through `sumsByAccount` and `accountTotals`. Decimals are summed with decimal.js. No `parseFloat`.
  - It runs about five queries in parallel, each a `groupBy` with a relation filter on `entry`.
  - `journal_lines` has no tenant, account, date index visible in my read. Prisma generates a join to `journal_entries`, so an index on (tenant, company, status, entry_date) matters. I did not check the indexes.
- General ledger and party statement (`:352`, `:438`):
  - Opening is computed in SQL with `aggregate`.
  - Rows are loaded with `findMany`, with no limit and no pagination.
  - The running balance is a single pass, O(n), with Decimal.
  - Large accounts such as cash or sales over a year can return tens of thousands of rows with joins. Add a cap (like `REPORT_TOO_LARGE`) or paginate.
  - `partyStatement` filters by `partyType` and `partyId` only, not by account. Lines on other accounts carrying a party would be included (only control accounts require a party, so mostly fine).
- AR/AP aging (`treasury/treasury-reports.service.ts:96-174`):
  - Loads ALL posted credit invoices dated up to asOf (`sales-invoices.service.ts:84-95`) with no limit, and loops in JS. It is O(invoices) every call; after years of history it will be slow.
  - `allocatedAsOf` is a SQL `groupBy`, good.
  - Allocations cancelled after asOf are excluded entirely, so historical agings drift from the ledger. The comment says this is intended. Residual aging absorbs the difference.
  - The bucket day math uses `Math.round` on a number of days. That is OK, these are not money.
- Inventory valuation (`stock-reports.service.ts:445`): company-wide it is `item_costs` (O(items), fine). Per-warehouse it is `qty * avg` rounded per row, so the total differs from the GL inventory account (documented).
  - `periodWhere` (`:55`) puts every OPENING adjustment id into an `IN (...)` list. That is fine for now but grows with the number of opening docs.
- Stock card (`itemLedger`, `:350`): it has a row-count guard (`EXPORT_LIMITS.xlsx`), good.
  - Opening comes from a `groupBy` in SQL.
  - Rows carry `balanceQtyAfter`, which is per-warehouse. With no warehouse filter, the running balance column is misleading across warehouses.
  - Opening value subtracts OUT `totalCost`, consistent with the ledger.
- `itemBalances` is done in SQL (`groupBy` item and type), and guarded by the row cap. Good.
- Money handling in the code I read is clean: Decimal everywhere, `toFixed(3)` only for output formatting.

## Not reviewed or unverified
- Opening balance stock flow, `counts.service.ts`, and the `invoice-settlement.ts` lock ordering (it sorts ids, which is good: `shared/invoice-settlement.ts:59`).
- `stock_movements` index use: `(tenant, item, movement_date)` exists, `schema.prisma:1007`. The backdating check does not use it.
- Whether Prisma's `PrismaMariaDb` adapter honours `initSql` on pool connections.
- The golden scenarios in BUILD_PLAN section 18 were not run. I read no tests.
