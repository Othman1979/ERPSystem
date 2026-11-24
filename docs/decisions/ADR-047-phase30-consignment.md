# ADR-047 — Phase 32: temporary receipt of supplier goods, invoiced by the quantity sold

**Status:** Accepted (owner, 2026-11-24). Replaces the cancelled consignment design of PR #109 (Phases 30–31 cancelled).  
**Date:** 2026-11-24

## Context
The owner receives supplier goods with no purchase order and no invoice. They must be counted and sold. When they are
sold, the accountant counts and records the supplier's purchase invoice for the quantity sold only; that invoice is the
cost. Unsold goods go back to the supplier. Owner choice (b): nothing is booked at sale; the accountant invoices before
the month closes, helped by a sold-not-invoiced report. Code keeps the internal name `consignment` (tables, codes, routes);
the UI says "استلام مؤقت / Temporary receipt".

## Decision
1. **Setting** `companies.consignment_enabled` (default off). Off: every endpoint and field below answers
   `CONSIGNMENT_DISABLED`. Turning off is refused (`CONSIGNMENT_IN_USE`) while a temporary warehouse holds stock, a sold row
   is open, or a temporary-receipt document is a draft.
2. **Temporary warehouse** `warehouses.consignment_supplier_id` (SUPPLIER/BOTH party). Set at creation or while the warehouse
   has no movement (serialized with postings by a row lock).
3. **Separate quantities, no cost.** `item_costs.pool_warehouse_id`: owned stock pool 0; each temporary warehouse its own
   pool at cost 0. Temporary stock never enters INVENTORY or the owned average, and never goes negative.
4. **Documents**

| Document | Stock | Journal |
|---|---|---|
| Goods note `CONSIGNMENT_IN` (temporary receipt), supplier = warehouse supplier, no price | IN at 0 | none |
| Goods note `CONSIGNMENT_OUT` (return to supplier) | OUT | none |
| Sales invoice from a temporary warehouse | OUT at 0 | revenue and tax only, no COGS line |
| Sales return of it | IN at 0 | revenue reversal only |
| Stock count shortage / surplus | OUT / IN at 0 | none |
| Supplier invoice (purchase invoice `consignment_settlement`, lines → `consignment_sale_id`) | none | Dr COGS (rows from sales) or Dr CONSIGNMENT_SHRINKAGE (rows from counts) + Dr INPUT_TAX / Cr SUPPLIERS_CONTROL |
| Purchase return of a supplier-invoice line | none | the reverse, same accounts |

5. **Sold not invoiced** `consignment_sales`: one row per sold stock line (SALES_INVOICE) or count shortage line (STOCK_COUNT)
   with qty, returned_qty, invoiced_qty; open = qty − returned − invoiced ≥ 0. Supplier-invoice qty ≤ open
   (`CONSIGNMENT_OVER_INVOICED`); sales return qty ≤ open (`CONSIGNMENT_ALREADY_INVOICED`: record a purchase return on the
   supplier invoice first). A purchase return lowers invoiced_qty. Rows are read from their `FOR UPDATE` query.
6. **Guards** (`CONSIGNMENT_WAREHOUSE_NOT_ALLOWED`, at save and at post): transfers, production, GRN/GIN, purchase orders,
   issue requests, direct purchase invoices and returns, manual adjustments, recipe lines.
7. **Accounts:** CONSIGNMENT_SHRINKAGE → 5209 "عجز بضاعة المورد" (EXPENSE, under 52), provisioned by migration only where
   that code is free, and in the template. Enabling the setting needs it mapped.
8. **stock:verify** compares costs per pool; GL_INVENTORY uses pool 0.
9. **Reports** (reports.view, branch-scoped): supplier statement (received, returned to supplier, sold net of returns, count
   shortages, invoiced, on hand, open qty) and sold-not-invoiced ageing as of today (0–30, 31–60, 61–90, 90+).

## Consequence
Between a sale and the supplier invoice, the sale shows its full margin; the ageing report is the accountant's
month-end checklist. Golden scenarios TR1–TR8 (BUILD_PLAN §18) are the reference.
