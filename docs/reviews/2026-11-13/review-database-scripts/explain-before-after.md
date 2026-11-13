# EXPLAIN before / after the index plan (DB-10)

Measured on 2026-11-13 by wave 2 session 2D. How the data was built is in `README.md` in this folder.

## The data
One tenant on MariaDB 10.4.32 (XAMPP), `innodb_buffer_pool_size` = 16 MB.

| table | rows | of which |
|---|---|---|
| stock_movements | 50,000 | all real postings |
| journal_lines | 54,850 | all real postings |
| journal_entries | 19,250 | 1,750 posted; 17,500 synthetic drafts (no lines) |
| sales_invoices | 17,050 | 550 posted (the TRIAL limit, 50 a month); 16,500 synthetic drafts |
| purchase_invoices | 21,700 | 700 posted; 21,000 synthetic drafts |
| stock_balances | 200 | |

**Why the synthetic drafts:**
- The TRIAL plan caps a tenant at 50 posted sales a month, so the invoice and entry tables stayed in the hundreds.
- At that size MariaDB rightly scans the table, and the header indexes cannot show anything.
- The drafts are copies of posted headers, added by SQL (`inflate.mjs`), so lists and date indexes are measured at a
  realistic size.
- Drafts are also what a status index has to skip.

**How it was measured:**
- **"Before"** is a database built from `main`'s 19 migrations, with every row copied in (`rebuild.mjs`). The copy
  starts from the server's default collation, as a hosting panel would create it.
- **"After"** is the same database after `prisma migrate deploy` of `20261113164500_db_review_indexes`.
  - The migration took 7.4 s on this data.
  - `prisma migrate diff` against `schema.prisma` is empty afterwards.
- `ANALYZE TABLE` ran before each capture.
- **Times:** the median of 5 runs after a warm-up. A 16 MB buffer pool makes them noisy, so plans differing by under
  about 2× are noise. **The plans are the evidence.**

## Summary

| query (code path) | before | after | before → after ms |
|---|---|---|---|
| `movements_list`: stock movement list, newest first, page 101 (`stock-reports.service.ts`) | tenant rows + filesort of 50k | `(tenant, movement_date, id)` read backwards, no sort | 367 → 15 |
| `invoice_list`: sales invoice list, `take: 300` (`sales-invoices.service.ts`) | tenant rows + filesort of 17k | `(tenant, company, invoice_date, id)` read backwards, stops at 300 | 91 → 17 |
| `purchase_list` | same, 21.7k rows | `(tenant, company, invoice_date, id)` | 69 → 16 |
| `purchase_list_posted`: list filtered to POSTED | `(tenant, status)` + filesort | `(tenant, company, status, invoice_date)`, no sort | 31 → 18 |
| `quota_count`: monthly quota, **on every sales post** | `(tenant, status)` then rows | `(tenant, company, status, invoice_date)`, index only | 5 → 1 |
| `aging_invoices`: credit invoices as of a date | `(tenant, status)` + filesort | `(tenant, company, status, invoice_date)`, no sort | 11 → 5 |
| `oldest_first_customer`: settlement on every receipt or allocation | `(tenant, customer)` 186 rows + filesort | `(tenant, customer, status, payment_type, invoice_date)` 6 rows, no sort | 3 → 1 |
| `party_posted_count` (`parties.service.ts`) | `(tenant, customer)` 186 rows | same new index, index only | 3 → 1 |
| `gl_opening`: GL opening balance | 24.8k journal lines of the account | 1,750 posted entries via `(tenant, company, status, entry_date)` + `(tenant, account, journal_entry)` | 56 → 10 |
| `gl_rows`: general ledger rows | 24.8k lines of the account, entries by PK | posted entries in range first, then lines by `(tenant, account, journal_entry)` | 291 → 204 |
| `journal_list_posted`: journal list filtered to POSTED | 9.7k entries (drafts included) | 1,750 posted via `(tenant, company, status, entry_date)` | 16 → 12 |
| `verify_scan`: `stock:verify` full ordered read | tenant rows + filesort | `(tenant, movement_date, id)`, no sort | 597 → 561 |
| `balances_by_item` | implicit FK index | the same columns, now declared | 1 → 1 |
| `trial_balance` | lines of the tenant in account order, entry by PK | the same plan shape, on the wider index | 350 → 125 (noise-prone) |
| `party_statement`, `control_by_party` | `(tenant, party_type, party_id)` | `(…, journal_entry_id)`, the same plan | 2 → 2, 10 → 7 |
| `item_card`, `movements_count`, `journal_list`, `sales_summary` | unchanged plans | unchanged | within noise |
| `items_balance`: movements grouped by item for a 4-month range | tenant rows + temporary + filesort | unchanged: the range is 36% of the rows, so a scan is right | 139 → 263 (noise) |

## What the numbers say
- **Every list now reads in index order and stops at its limit.** These are the sales, purchase and movement lists.
  - Before, each sorted all of the tenant's rows on every page view.
  - The movement list is the clearest case: OFFSET paging over 50k rows went from a 50k-row filesort to an index walk.
  - Keyset paging (DB-22, wave 3) removes the OFFSET walk too.
- **Posted-only filters skip drafts.** These are the quota count on every post, aging, the GL and the posted journal list.
- **Not changed by indexes: `trial_balance` and `items_balance`.**
  - Both group most of the tenant's rows. MariaDB reads the lines in account (or item) order, and a covering index
    would only save row lookups.
  - The owner decided against a monthly balance projection for now (decisions.md D-5).
  - If the trial balance becomes slow at real volume, the next step is a covering index
    `journal_lines(tenant_id, account_id, journal_entry_id, debit, credit)`, or that projection.
- **Left out of the plan:** `journal_lines(tenant_id, account_id, party_id)`.
  - No query chose it: control balances per party use the party index.
  - It would only add write cost to the largest table, so it was measured and then dropped. The plans above are with
    it dropped.
- **Integrity check (ADR-019 §5) on this data:**
  - 0 orphans in every reference of the real postings.
  - It flagged exactly the 17,500 synthetic drafts: XAMPP's non-strict `sql_mode` had stored their NULL `source_type`
    as `''`.
  - It ran in 8.7 s.

## Full plans
`~N` is EXPLAIN's row estimate per step, and ignores LIMIT. Index names are shortened: `t_` stands for
`<table>_tenant_id_`. `ICP` = index condition pushdown; `covering` = the index alone answers.

| query | rows out | before: plan | before ms | after: plan | after ms |
|---|---|---|---|---|---|
| trial_balance | 13 | journal_lines: ref `t_account_id_idx` ~27351<br>j0: eq_ref `PRIMARY` ~1 | 350 | journal_lines: ref `t_account_id_journal_entry_id_idx` ~27279<br>j0: eq_ref `PRIMARY` ~1 | 125 |
| gl_rows | 4800 | journal_lines: ref `t_account_id_idx` ~24826 (filesort, temporary)<br>j0: eq_ref `PRIMARY` ~1<br>orderby_1: eq_ref `PRIMARY` ~1<br>orderby_2: eq_ref `PRIMARY` ~1<br>— journal_entries: ALL ~19342<br><subquery4>: eq_ref `distinct_key` ~1<br><subquery2>: eq_ref `distinct_key` ~1<br><derived5>: ALL ~4800<br><derived3>: ALL ~4800<br>null: null ~null<br>null: null ~null | 291 | j0: ref `t_company_id_status_entry_date_idx` ~1750 (filesort, temporary, ICP)<br>journal_lines: ref `t_account_id_journal_entry_id_idx` ~3<br>orderby_1: eq_ref `PRIMARY` ~1<br>orderby_2: eq_ref `PRIMARY` ~1<br>— journal_entries: ALL ~19075<br><subquery4>: eq_ref `distinct_key` ~1<br><subquery2>: eq_ref `distinct_key` ~1<br><derived5>: ALL ~4800<br><derived3>: ALL ~4800<br>null: null ~null<br>null: null ~null | 204 |
| gl_opening | 1 | journal_lines: ref `t_account_id_idx` ~24826<br>j0: eq_ref `PRIMARY` ~1 | 56 | j0: ref `t_company_id_status_entry_date_idx` ~1750 (ICP)<br>journal_lines: ref `t_account_id_journal_entry_id_idx` ~3 | 10 |
| party_statement | 0 | journal_lines: ref `t_party_type_party_id_idx` ~6 (filesort, temporary, ICP)<br>j0: eq_ref `PRIMARY` ~1<br>orderby_1: eq_ref `PRIMARY` ~1<br>orderby_2: eq_ref `PRIMARY` ~1 | 2 | journal_lines: ref `t_party_type_party_id_journal_entry_id_idx` ~6 (filesort, temporary, ICP)<br>j0: eq_ref `PRIMARY` ~1<br>orderby_1: eq_ref `PRIMARY` ~1<br>orderby_2: eq_ref `PRIMARY` ~1 | 2 |
| invoice_list | 300 | sales_invoices: ref `t_id_key` ~8487 (filesort) | 91 | sales_invoices: range `t_company_id_invoice_date_id_idx` ~8487 | 17 |
| quota_count | 50 | sales_invoices: ref `t_status_idx` ~550 (ICP) | 5 | sales_invoices: ref `t_company_id_status_invoice_date_idx` ~550 (covering) | 1 |
| aging_invoices | 300 | sales_invoices: ref `t_status_idx` ~550 (filesort, ICP) | 11 | sales_invoices: ref `t_company_id_status_invoice_date_idx` ~550 (ICP) | 5 |
| oldest_first_customer | 6 | sales_invoices: ref `t_customer_id_fkey` ~186 (filesort) | 3 | sales_invoices: ref `t_customer_id_status_payment_type_inv_idx` ~6 (ICP) | 1 |
| movements_list | 50 | stock_movements: ref `t_id_key` ~24793 (filesort) | 367 | stock_movements: ref `t_movement_date_id_idx` ~24793 | 15 |
| movements_count | 50000 | stock_movements: ref `t_id_key` ~24793 (covering) | 44 | stock_movements: ref `t_id_key` ~24793 (covering) | 24 |
| item_card | 103 | stock_movements: ref `t_item_id_movement_date_idx` ~286 (ICP) | 6 | stock_movements: ref `t_item_id_movement_date_idx` ~286 (ICP) | 5 |
| items_balance | 400 | stock_movements: ref `t_id_key` ~24793 (filesort, temporary) | 139 | stock_movements: ref `t_id_key` ~24793 (filesort, temporary) | 263 |
| verify_scan | 50000 | stock_movements: ref `t_id_key` ~24793 (filesort) | 597 | stock_movements: ref `t_movement_date_id_idx` ~24793 | 561 |
| journal_list | 200 | journal_entries: range `t_company_id_entry_date_idx` ~9671<br><derived2>: ref `key0` ~10<br>journal_lines: index `t_journal_entry_id_line_no_key` ~54702 (filesort, temporary, covering) | 65 | journal_entries: range `t_company_id_entry_date_idx` ~9537<br><derived2>: ref `key0` ~10<br>journal_lines: index `t_journal_entry_id_line_no_key` ~54559 (filesort, temporary, covering) | 47 |
| purchase_list | 300 | purchase_invoices: ref `t_id_key` ~10768 (filesort) | 69 | purchase_invoices: range `t_company_id_invoice_date_id_idx` ~10795 | 16 |
| purchase_list_posted | 300 | purchase_invoices: ref `t_status_idx` ~700 (filesort, ICP) | 31 | purchase_invoices: ref `t_company_id_status_invoice_date_idx` ~700 | 18 |
| sales_summary | 39 | sales_invoices: ref `t_status_idx` ~550 (filesort, temporary, ICP) | 4 | sales_invoices: ref `t_company_id_status_invoice_date_idx` ~550 (filesort, temporary, ICP) | 3 |
| party_posted_count | 6 | sales_invoices: ref `t_customer_id_fkey` ~186 | 3 | sales_invoices: ref `t_customer_id_status_payment_type_inv_idx` ~6 (covering) | 1 |
| journal_list_posted | 200 | journal_entries: range `t_company_id_entry_date_idx` ~9671 | 16 | journal_entries: ref `t_company_id_status_entry_date_idx` ~1750 | 12 |
| balances_by_item | 1 | stock_balances: ref `t_item_id_fkey` ~1 | 1 | stock_balances: ref `t_item_id_idx` ~1 | 1 |
| control_by_party | 50 | journal_lines: range `t_party_type_party_id_idx` ~550 (ICP)<br>j0: eq_ref `PRIMARY` ~1<br>j1: eq_ref `PRIMARY` ~1 | 10 | journal_lines: range `t_party_type_party_id_journal_entry_id_idx` ~550 (ICP)<br>j0: eq_ref `PRIMARY` ~1<br>j1: eq_ref `PRIMARY` ~1 | 7 |
