# Query -> index map (apps/api/src, read-only research)

Caveats: `tenantScopedPrisma` (`prisma/tenant-prisma.ts:83-94`) injects `tenant_id` into every Prisma `where`, so all Prisma calls below are `tenant_id`-led. Prisma composite FKs `[tenantId, xId]` make InnoDB/MariaDB auto-create an index `(tenant_id, x_id)` when no existing index has those columns leftmost; those are not in schema.prisma and are marked "FK-implicit" (verify with `SHOW INDEX`; the migrations contain no explicit `CREATE INDEX`). Prisma relation filters (`entry: {...}`) compile to a join/subquery, so the plans below assume the nested-loop path.

## 1. Raw SQL (non-spec)

All raw queries on tenant tables carry `tenant_id = ${tenantId}` except the cross-tenant ones below.

| file:line | SQL (abridged) | Tables / columns | tenant_id |
|---|---|---|---|
| journal/posting.service.ts:329 | SELECT ... FOR UPDATE | document_sequences: tenant, company, document_type, fiscal_year_id | yes |
| journal/journal.service.ts:217 | lock draft FOR UPDATE | journal_entries: tenant, id | yes |
| inventory/stock-ledger.service.ts:250 | lock item_costs | tenant, company, item | yes |
| inventory/stock-ledger.service.ts:286 | lock stock_balances | tenant, warehouse, item | yes |
| inventory/counts.service.ts:270 | lock stock_counts | tenant, id | yes |
| sales/sales-invoices.service.ts:195,464; purchases/purchase-invoices.service.ts:194,427 | `SELECT id ... FOR UPDATE` | tenant, id | yes |
| sales-invoices.service.ts:209 / purchase-invoices.service.ts:208 | invoice settlement row FOR UPDATE | tenant, id | yes |
| sales-invoices.service.ts:213 / purchase-invoices.service.ts:212 | `SUM(grand_total)` on sales_returns / purchase_returns WHERE original_invoice_id, status='POSTED', refund_type='CREDIT' LOCK IN SHARE MODE | tenant, original_invoice_id, status, refund_type | yes |
| sales-returns:372, purchase-returns:311, goods-notes:217, transfers:186,272, adjustments:205,352, cash-transfers:128, vouchers:435,513,518 | id locks | tenant, id | yes |
| einvoice/einvoice-outbox.service.ts:35 | lock einvoice_settings | tenant, company | yes |
| einvoice/einvoice-worker.service.ts:65,72 | UPDATE einvoice_submissions WHERE status='SENDING' AND claimed_at < now-N AND sent_at ... | status, claimed_at | NO (intentional, cross-tenant outbox worker, commented) |
| einvoice-worker.service.ts:80 | claim: WHERE (status='PENDING' OR (status='FAILED' AND attempt_count<M)) AND next_attempt_at<=now ORDER BY id LIMIT | status, next_attempt_at, id | NO (intentional) |
| einvoice-worker.service.ts:87,95 | SELECT by claim_token + status; UPDATE by id+claim_token | claim_token, id | NO (intentional) |
| jobs/tenant-purge.service.ts:53 | information_schema.COLUMNS | n/a | n/a |
| tenant-purge.service.ts:79,123 | `COUNT(*)` / `DELETE FROM <t> WHERE tenant_id=?` per tenant table | every tenant table | yes (loop over ~60 tables) |
| tenant-purge.service.ts:102 | users u, EXISTS/NOT EXISTS tenant_memberships m (m.user_id = u.id, m.tenant_id <>/= X) | tenant_memberships.user_id | cross-tenant by design |
| tenant-purge.service.ts:126-129 | DELETE refresh_tokens by user_id, users by id, tenants by id | PK / user_id idx | n/a |
| health:19, preflight:90-151, backup:90-91 | SELECT 1, VERSION(), SHOW VARIABLES, _prisma_migrations | n/a | n/a |

No raw query on a tenant table is missing a tenant filter apart from the intentional einvoice worker statements (they rely on PK `id` or `claim_token`; no leak, but they are the only cross-tenant hot path). Note `tenant-purge:123` `DELETE ... WHERE tenant_id=?` full-scans `error_events` (no tenant_id index) and relies on leftmost `tenant_id` unique/index elsewhere.

## 2. Prisma hot paths (large tables)

Pagination: only `admin.service.ts:42` (tenants) and `stock-reports.service.ts:317` (movements, OFFSET `skip`) paginate with skip/take. Every business list is a hard `take` with no cursor: sales/purchase invoice lists `take:300` (sales-invoices.service.ts:263), receipts/payments `take:300` (vouchers.service.ts:79,234), journal list `take:200` (journal.service.ts:111), parties `take:500` (parties.service.ts:26), items `take:500` (catalog.service.ts:127), e-invoice list `take:300` (einvoice-submissions.service.ts:45), error list (monitoring.service.ts:68). Reports and exports are unbounded.

| file:line | model | where | orderBy | note |
|---|---|---|---|---|
| journal/reports.service.ts:133 (sumsByAccount), :181 (accountTotals) | journalLine.groupBy accountId | entry{companyId, status POSTED, entryDate range, isOpening/OR} | none | scans all lines of tenant in range |
| reports.service.ts:359, :442, :559 | journalLine.findMany (GL, party statement, openingAndManualItems) | accountId / partyType+partyId; entry{...}; manual: reversals none{...} | entry.entryDate, entry.id, lineNo | unbounded, filesort |
| reports.service.ts:382, :457 | journalLine.aggregate (opening balance) | accountId or party; entry{OR(entryDate<from, isOpening...)} | | OR defeats a single range |
| reports.service.ts:527 | journalLine.groupBy partyId | partyType, partyId not null, account{controlType OR id}, entry{<=asOf} | | aging control balances |
| treasury-reports.service.ts:228 | journalLine.groupBy accountId | accountId IN, entry{company, POSTED} | | cash balances, full history |
| treasury-reports.service.ts:191 | allocation.groupBy documentId | companyId, documentType, cancelledAt null, OR(receipt.date<=, payment.date<=) | | OR of two relation filters |
| sales-invoices.service.ts:84,96 (+ purchase 83) | salesInvoice.findMany / salesReturn.groupBy | company, POSTED, CREDIT, invoiceDate<=asOf / return filters | invoiceDate,id | aging; unbounded |
| sales-invoices.service.ts:122-172 | salesInvoice.groupBy; salesInvoiceLine.groupBy | company, POSTED, date range (lines via `invoice:` relation) | | summaries/dashboard |
| sales-invoices.service.ts:231 | salesInvoice.findMany (oldest-first settle) | company, POSTED, CREDIT, customerId | invoiceDate,id | hit on every voucher allocation |
| sales-invoices.service.ts:512 | salesInvoice.count | company, POSTED, invoiceDate in month | | runs on EVERY post (quota) |
| sales-invoices.service.ts:67 | salesReturn.findMany | originalInvoiceId IN, POSTED, CREDIT | | per list render |
| stock-reports.service.ts:56 | stockAdjustment.findMany | adjustmentType='OPENING' | | no index on type |
| stock-reports.service.ts:93,390 | stockMovement.groupBy itemId, movementType | NOT sourceType, movementDate range / OR, sourceId IN (opening docs) | | no warehouse -> scans tenant |
| stock-reports.service.ts:310,320 | stockMovement.findMany + count | warehouse, item, sourceType, movementDate range | movementDate desc, id desc; skip/take | OFFSET + COUNT(*) |
| stock-reports.service.ts:374-382 | stockMovement count/findMany (item card) | item, [warehouse], period | movementDate,id | unbounded up to export cap |
| stock-reports.service.ts:188-204,228,384,484 | stockBalance count/findMany/groupBy | warehouseId and/or itemId, qtyOnHand != 0, itemId IN | warehouseId,itemId | |
| stock-reports.service.ts:461 | itemCost.findMany | companyId | itemId | OK |
| stock-ledger.service.ts:299,317 (verify) | stockMovement.findMany ALL, stockBalance.findMany ALL | none | movementDate,id | full table scan (job) |
| stock-ledger.service.ts:241,279 | itemCost/stockBalance findFirst then create then raw lock | tenant, company/warehouse, item | | 3 queries per movement |
| adjustments.service.ts:370, transfers.service.ts:288 | stockMovement.findMany | sourceType, sourceId | | OK |
| posting.service.ts:227,238 | journalEntry.findFirst | id; reversalOfId | | reversal check |
| posting.service.ts:281 | fiscalPeriod.findFirst | startDate<=d, endDate>=d, fiscalYear{company} | periodNo | on every post; tiny table |
| posting.service.ts:317,329 | fiscalYear.findFirst; document_sequences FOR UPDATE | | | numbering; unique idx exact match |
| vouchers.service.ts:528 | allocation.aggregate | receiptId/paymentId, cancelledAt null | | FK-implicit |
| journal.service.ts:101 | journalEntry.findMany | company, status?, voucherType?, sourceType? | entryDate desc,id desc take 200 | + `reversals` + `_count lines` includes |
| einvoice-submissions.service.ts:37,47 | eInvoiceSubmission findMany/groupBy status | company, status?, documentType? | id desc take 300 | |
| error-digest.service.ts:44,54,94; monitoring.service.ts:62 | errorEvent | resolvedAt null, OR notifiedAt/lastSeenAt, source | lastSeenAt desc | idx (resolvedAt,lastSeenAt) OK |
| tenant-status.service.ts:84,92,120,128 | tenant / subscription | status, trialEndsAt, statusChangedAt; subscription ACTIVE+periodEnd | | tenants small; daily |
| auth/token.service.ts, auth.service.ts:241 | refreshToken | tokenHash unique; userId+revokedAt null | | OK |
| idempotency.interceptor.ts:72,104,117 | idempotencyKey | tenant,key | | unique OK; nothing ever purges by expiresAt |
| audit.service.ts:31 etc. | auditLog.create only | | | no read path found in src |

### LIKE '%x%' searches
- `inventory/catalog.service.ts:110-112`: `code`, `nameAr`, `nameEn` `contains` OR'ed, plus `take:500`. Unindexable; bounded by tenant+company item count.
- `admin/admin.service.ts:30`: tenants `name contains` (platform table, small).
- `accounts.service.ts:134`: `code startsWith prefix` is a sargable range on unique `(tenant, company, code)`. Fine.

### N+1 / per-row queries
- `sales-invoices.service.ts:521-525`: `tx.item.findFirst` per invoice line inside post (purchase-invoices.service.ts:464 same pattern). Replace with one `findMany({id:{in}})`.
- `stock-ledger.service.ts:80,92` (`applyMovement`): per movement = item.findFirst + company.findFirst (same row every line) + findFirst/create/raw for cost + same for balance = ~7 queries per line. `company.allowNegativeStock` can be fetched once per document.
- `sales-invoices.service.ts:~545` / adjustments / transfers: `tx.salesInvoiceLine.update` per line (cost snapshot).
- `catalog.service.ts:287`: `tx.unit.findFirst` + `itemUnit.create` per unit (small N). Also `catalog.service.ts:283` uses `Number(factorToBase)` (CLAUDE.md money/qty rule).
- `transfers.service.ts:116`: findFirst per missing item (error path only).
- `tenant-purge.service.ts:78`: one COUNT per tenant table (job, acceptable).
- `tenant-export.service.ts:113`: unbounded `findMany` per model per tenant (export).
- `einvoice-worker.service.ts:95`: one UPDATE per claimed row (batch-size bounded).
- Aging (`treasury-reports.service.ts:106`) uses Promise.all over 4 whole-set queries, not per-row; OK.

## 3. Existing indexes (schema.prisma) per hot model

| model | @@unique | @@index |
|---|---|---|
| JournalEntry (747) | (tenant,id); (tenant,sourceType,sourceId,postingKind) | (tenant,company,entryDate); (tenant,status) |
| JournalLine (799) | (tenant,id); (tenant,journalEntryId,lineNo) | (tenant,accountId); (tenant,partyType,partyId) |
| StockMovement (978) | (tenant,id) | (tenant,warehouse,item); (tenant,item,movementDate); (tenant,sourceType,sourceId) |
| StockBalance (1012) | (tenant,id); (tenant,warehouse,item) | none |
| ItemCost (1030) | (tenant,id); (tenant,company,item) | none |
| SalesInvoice (1298) / PurchaseInvoice (1376) | (tenant,id); (tenant,invoiceNo) | (tenant,status) |
| SalesReturn (1453) / PurchaseReturn (1525) | (tenant,id); (tenant,returnNo) | (tenant,status) |
| *Line tables | (tenant,id); (tenant,docId,lineNo) | none |
| Receipt (1647) / Payment (1684) | (tenant,id); (tenant,receiptNo / paymentNo) | none |
| Allocation (1723) | (tenant,id) | (tenant,documentType,documentId) |
| Item (849) | (tenant,id); (tenant,company,code) | (tenant,itemKind) |
| Party (1217) | (tenant,id); (tenant,company,code) | (tenant,partyType) |
| Account (662) | (tenant,id); (tenant,company,id); (tenant,company,code) | none |
| EInvoiceSubmission (1847) | (tenant,id); (tenant,docType,docId); (tenant,company,icv) | (status,nextAttemptAt); (claimToken) |
| AuditLog (492) | PK | (tenant,createdAt); (entityType,entityId) |
| ErrorEvent (467) | fingerprint | (resolvedAt,lastSeenAt) |
| IdempotencyKey (530) | (tenant,key) | none |
| RefreshToken (222) | tokenHash | (userId); (familyId) |
| CashTransfer (1753) | (tenant,id); (tenant,transferNo) | (tenant,transferDate) |

## 4. Query -> index -> gap

| query | best existing index | verdict |
|---|---|---|
| Trial balance / IS / BS: journalLine.groupBy account over entries (company,POSTED,date) | je (tenant,company,entryDate) then jl unique (tenant,entryId,lineNo) | PARTIAL. `status`, `is_opening` not in index (row lookups per entry). Add `journal_entries(tenant,company,status,entryDate)`; ideally covering `(tenant,company,status,isOpening,entryDate,id)` |
| GL for account (reports:359) | jl (tenant,accountId) then entry join | PARTIAL: sort is on entry fields -> filesort; add `journal_lines(tenant,accountId,journalEntryId)` so the join key is in the index |
| Opening balance aggregate (reports:382,457) | same | WEAK: OR(entryDate<from, isOpening AND range) prevents one range; consider splitting into two aggregates |
| Party statement (reports:442) | jl (tenant,partyType,partyId) | OK for filtering; add `journalEntryId` as 4th column |
| Control balances by party (reports:527) | jl (tenant,partyType,partyId) | GAP: filter is on `account` relation (controlType or mapped id), then groups partyId; index `(tenant,accountId,partyId)` would let the planner start from the control account(s) |
| Cash balances (treasury:228) | jl (tenant,accountId) | OK (few accounts); full history sum, add covering (tenant,accountId,journalEntryId,debit,credit) only if slow |
| Manual items with `reversals none` (reports:559) | je unique (tenant,sourceType,sourceId,postingKind); reversalOfId FK-implicit (tenant,reversalOfId) | OK if FK index exists |
| Journal list (journal.service:101) | je (tenant,company,entryDate) | OK for date sort; status/voucher/source filter not indexed (filtered rows, take 200) |
| Doc lists: invoices/returns `ORDER BY invoiceDate desc LIMIT 300` | (tenant,status) | GAP: no date index on sales_invoices, purchase_invoices, sales_returns, purchase_returns, receipts, payments, goods_notes -> filesort of all tenant docs on every list. Add `(tenant,company,invoiceDate,id)` style (or `(tenant,status,invoiceDate)`) |
| Quota count on every post (sales-invoices:512) | (tenant,status) | GAP: needs `(tenant,status,invoiceDate)` (range inside month) |
| creditInvoicesAsOf (sales-invoices:84) | (tenant,status) | GAP: add `(tenant,status,paymentType,invoiceDate)` |
| creditInvoiceIdsOldestFirst (sales-invoices:231) | FK-implicit (tenant,customerId) | PARTIAL: `(tenant,customerId,status,paymentType,invoiceDate)` removes filesort |
| Returns credited (settlementState, creditedFor, creditInvoicesAsOf groupBy) | FK-implicit (tenant,originalInvoiceId) | OK for per-invoice; aging groupBy scans tenant: `(tenant,status,refundType,returnDate)` optional |
| Allocation aging (treasury:191) | (tenant,documentType,documentId) | OK-ish: filters company/documentType, then joins receipt/payment for dates; `cancelledAt` not indexed |
| Allocation by receipt/payment | FK-implicit (tenant,receiptId)/(tenant,paymentId) | OK |
| Stock lock item_costs / stock_balances | unique (tenant,company,item) / (tenant,warehouse,item) | OK |
| stock_balances by item only (reports:228,384; low stock) | FK-implicit (tenant,itemId) | OK if implicit index exists; declare `@@index([tenantId,itemId])` to make it explicit |
| Movement list (stock-reports:310) filter wh/item/source + date, ORDER BY movementDate desc,id desc, OFFSET | (tenant,item,movementDate); (tenant,warehouse,item) | GAP when no item filter: no `(tenant,movementDate,id)`; COUNT(*) and OFFSET degrade with history |
| Item card (reports:374) | (tenant,item,movementDate) | OK |
| Items balance groupBy (reports:93) | (tenant,item,movementDate) | GAP: date-range-only scan; with warehouse filter uses (tenant,warehouse,item) but date filtered after; `(tenant,warehouseId,movementDate)` or covering `(tenant,movementDate,itemId,movementType)` |
| Movements by source (adjustments:370, transfers:288, reports periodWhere sourceId IN) | (tenant,sourceType,sourceId) | OK |
| stock:verify full scan ordered by movementDate,id | none | job only; same `(tenant,movementDate,id)` covers it |
| Opening adjustments (stock-reports:56) | (tenant,status) | minor GAP: `adjustmentType` unindexed, tiny table |
| Item search `contains` (catalog:110) | (tenant,company,code) | cannot be served (leading wildcard); accept, or FULLTEXT / prefix search |
| Fiscal period resolve (posting:281) | unique (tenant,fiscalYear,periodNo) | small table; OK |
| Document numbering lock (posting:329) | unique (tenant,company,documentType,fiscalYear) | OK |
| E-invoice claim/stuck (worker) | (status,nextAttemptAt); (claimToken) | OK (SENT rows excluded by status prefix); stuck rule `status+claimed_at` uses status prefix only, fine |
| E-invoice list (submissions:37) | PK/(tenant,id) | OK (id desc, take 300); status groupBy by company scans tenant rows, optional `(tenant,company,status)` |
| Error events list/digest/prune | (resolvedAt,lastSeenAt) | OK; `source` filter and prune of `resolvedAt IS NULL AND lastSeenAt <` served; `tenant_id` purge delete unindexed |
| Audit log | (tenant,createdAt); (entityType,entityId) | no reads in src; second index lacks tenant (cross-tenant exposure if a reader is added) |
| Idempotency keys | unique (tenant,key) | OK; `expiresAt` unindexed and never purged -> unbounded growth |
| Refresh tokens | unique tokenHash; (userId); (familyId) | OK; no expiry purge |

## 5. Unused / redundant

Unused by any query found in src (writes only, pay insert cost):
- `audit_logs(tenantId, createdAt)` and `(entityType, entityId)`: only `auditLog.create` exists.
- `journal_entries(tenant, status)`: only used implicitly via list status filter (weak, low selectivity); superseded by a proposed `(tenant,company,status,entryDate)`.
- `role_permissions(permissionCode)`: no src query by permissionCode found (not exhaustively checked outside hot tables).
- `(tenant,status)` on `stock_adjustments`, `stock_transfers`, `stock_counts`, `goods_notes`: used only for small lists/locks; low value.

Redundant (prefix of another index):
- None strictly redundant inside the explicit set. `journal_lines(tenant,accountId)` becomes a prefix of the proposed `(tenant,accountId,journalEntryId)`, and `stock_movements(tenant,warehouse,item)` is not a prefix of anything else. `items(tenant,itemKind)` and `parties(tenant,partyType)` are low-selectivity (2-3 values) and would be better as `(tenant,company,...)` composites.
- Redundant-by-design: `@@unique([tenantId, id])` alongside the PK `id` is required for composite FKs (not removable).

## Top 10 gaps (priority order)

1. Journal reports: no index with `status`/`is_opening` after `(tenant, company)` on `journal_entries`, so every posted-only sum visits every entry row. Add `(tenant_id, company_id, status, entry_date)` (covering variant adds `is_opening, id`).
2. `journal_lines(tenant, account_id)` lacks `journal_entry_id`; GL/trial balance join cannot be satisfied from the index. Make it `(tenant, account_id, journal_entry_id)`.
3. `journal_lines` control-balance/aging query (reports:527) starts from the party index but filters by account; add `(tenant, account_id, party_id)`.
4. Document lists on sales/purchase invoices, returns, receipts, payments: ordering by date with only `(tenant,status)`; add `(tenant, company_id, <date>, id)` per table.
5. Posting quota count (`sales-invoices.service.ts:512`, purchase equivalent) runs on every post with no date index; add `(tenant, status, invoice_date)`.
6. Aging inputs (`creditInvoicesAsOf`, `creditInvoiceIdsOldestFirst`): add `(tenant, status, payment_type, invoice_date)` and `(tenant, customer_id, status, payment_type, invoice_date)` (and supplier equivalent).
7. `stock_movements` has no `(tenant, movement_date, id)`: movement list OFFSET + COUNT, items balance, stock:verify all scan by tenant. Also switch the list to keyset pagination.
8. Per-line N+1 in posting: `applyMovement` re-reads company and item per line, `sales-invoices.service.ts:521` / `purchase-invoices.service.ts:464` re-read item per line (fetch once with `in`).
9. `idempotency_keys.expires_at` and `refresh_tokens.expires_at` unindexed and no purge job exists; tables grow forever. Add a retention job plus `(expires_at)`.
10. Make implicit FK indexes explicit where queries depend on them: `stock_balances(tenant,item_id)`, `journal_entries(tenant,reversal_of_id)`, `sales/purchase_returns(tenant,original_invoice_id)`, `allocations(tenant,receipt_id)/(tenant,payment_id)`; verify with `SHOW INDEX` first. Also `audit_logs(entityType,entityId)` needs `tenant_id` first before any reader is added.
