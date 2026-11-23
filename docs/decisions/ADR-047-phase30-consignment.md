# ADR-047 — Phase 30: consignment stock (goods held for sale on behalf of a supplier)

**Status:** Accepted (owner approved the plan, 2026-11-23)  
**Date:** 2026-11-23

## Context
The owner receives goods from a supplier at an agreed purchase price with no purchase invoice. The goods stay the
supplier's until sold (IFRS 15 B77–B78: a consignment arrangement; the consignee does not control the goods). They
must appear in stock counts, may be sold before the supplier invoices, and unsold goods may be returned. The supplier
invoices only what was sold. Today the only route is a GRN, which books the goods into owned inventory against 2104
and can be billed only through a purchase order (ADR-026).

## Decision

### 1. Company setting
`companies.consignment_enabled` (default false), edited with the other company settings (`company.manage`).
- Off: every consignment endpoint and field below is refused with `CONSIGNMENT_DISABLED`; the web hides them.
- Turning it off is refused with `CONSIGNMENT_IN_USE` while any consignment warehouse has stock, any consignment sale
  has an open quantity (§5), or a consignment document is in draft.

### 2. Consignment warehouse
`warehouses.consignment_supplier_id` (nullable FK to a SUPPLIER/BOTH party of the same company). A warehouse with a
supplier is a consignment warehouse. It is set at creation, or later only while the warehouse has no stock movement;
it never changes after the first movement. Requires the setting on.

### 3. Separate cost pool (no mixing with owned stock)
`item_costs` gains `pool_warehouse_id` (NOT NULL, default 0). Owned stock keeps pool 0 (one weighted average per
company and item, unchanged). Each consignment warehouse has its own pool = its warehouse id, averaged at the agreed
prices. The unique key becomes (tenant, company, item, pool).
- `StockLedgerService` picks the pool from the movement's warehouse; lock order is item_id, then pool, then
  stock_balances by warehouse (same rule extended).
- Every reader of `item_costs` that means owned stock filters `pool_warehouse_id = 0` (count valuation, stock
  reports, BOM cost estimate, stock:verify GL check). Valuation of a consignment warehouse reads its own pool.
- A consignment warehouse never goes negative, whatever `allow_negative_stock` says (`STOCK_INSUFFICIENT`).
- Consignment stock is never in the INVENTORY account. Stock movements remain the single source of truth.

### 4. Documents
| Document | Stock | Journal |
|---|---|---|
| Consignment receipt (goods note `CONSIGNMENT_IN`) — supplier = warehouse's supplier, unit cost = agreed price > 0 | IN to the pool | none |
| Consignment return to supplier (goods note `CONSIGNMENT_OUT`) | OUT at pool average | none |
| Sales invoice from a consignment warehouse | OUT at pool average | revenue/tax as usual; Dr COGS / Cr CONSIGNMENT_PAYABLE |
| Sales return of such an invoice (same warehouse, existing rule) | IN at the original line cost | revenue reversal as usual; Dr CONSIGNMENT_PAYABLE / Cr COGS |
| Stock count shortage in a consignment warehouse | OUT at pool average | Dr CONSIGNMENT_SHRINKAGE / Cr CONSIGNMENT_PAYABLE |
| Stock count surplus in a consignment warehouse | IN at pool average | none |
| Supplier settlement invoice (purchase invoice, `consignment_settlement`) | none | Dr CONSIGNMENT_PAYABLE (cleared value) + Dr INPUT_TAX / Cr SUPPLIERS_CONTROL; price difference to COGS |
| Purchase return of a settlement invoice line | none | Dr SUPPLIERS_CONTROL / Cr CONSIGNMENT_PAYABLE (cleared value) + Cr INPUT_TAX; difference to COGS |

Goods notes of the two new types are numbered at posting like GRN/GIN, need an open period, and post no journal entry.
Any write-off residue the ledger reports on a pool (stock-costing.ts) is added to the movement's consignment value
(sales, count shortage) or dropped (receipt, return to supplier: memorandum stock); it never touches INVENTORY.

### 5. Consignment sales (what the supplier will bill)
New table `consignment_sales`: one row per consignment OUT that the supplier must bill — each stock line of a posted
sales invoice from a consignment warehouse (source SALES_INVOICE, invoice line id) and each count shortage line
(source STOCK_COUNT). Columns: company, warehouse, supplier, item, source, sale date, qty, value (cost booked to
CONSIGNMENT_PAYABLE), returned_qty/returned_value (sales returns), invoiced_qty/invoiced_value (settlements net of
purchase returns). Open qty = qty − returned_qty − invoiced_qty ≥ 0; open value likewise.
- Settlement: the user picks open rows of one supplier/warehouse; each settlement line references one row
  (`purchase_invoice_lines.consignment_sale_id`), with qty ≤ open qty and a unit price defaulting to the row's unit
  cost. Cleared value = round3(value × qty / row qty), or the full open value when the line closes the row. Stored on
  the line (`consignment_cleared_value`). Over-invoicing (also concurrently) is refused with `CONSIGNMENT_OVER_INVOICED`.
- Sales return of a consignment line may return only the row's open qty; beyond it `CONSIGNMENT_ALREADY_INVOICED`
  (record a purchase return on the settlement invoice first). returned_value = the return line's cost.
- Purchase return of a settlement line lowers invoiced_qty/invoiced_value by round3(line cleared × qty / line qty),
  or the line's remaining cleared value when fully returned.
- Locks: document row, then stock locks if any, then `consignment_sales` rows FOR UPDATE by id ascending.

### 6. What a consignment warehouse refuses (`CONSIGNMENT_WAREHOUSE_NOT_ALLOWED`)
Transfers from or to it; production vouchers; GRN/GIN; purchase orders, issue requests, direct purchase invoices and
purchase returns of stock into or out of it; manual stock adjustments (only those generated by a stock count);
recipe lines on a sales invoice from it. Consignment goods notes are refused on an owned warehouse.

### 7. Accounts
Two new mapping keys, provisioned for every existing company by migration and in the template for new ones:
`CONSIGNMENT_PAYABLE` → 2111 "مستحق لموردي الأمانة" (LIABILITY, under 21, locked after posting) and
`CONSIGNMENT_SHRINKAGE` → 5209 "عجز بضاعة الأمانة" (EXPENSE, under 52). Existing codes are not overwritten.

### 8. stock:verify
COST_QTY/COST_VALUE compare per (company, item, pool). GL_INVENTORY uses pool 0 only. New check GL_CONSIGNMENT:
balance of CONSIGNMENT_PAYABLE (credit − debit) = Σ open value of `consignment_sales`.

### 9. Reports (reports.view)
- **Supplier consignment statement** (supplier, date range): per item received, returned to supplier, sold net of
  returns, count shortages, invoiced, on hand, open qty and value.
- **Sold not invoiced:** open rows with ages 0–30, 31–60, 61–90, 90+ days from the sale date.

### 10. Permissions
No new permission keys: consignment goods notes use the goods-note permissions, settlement invoices and their returns
the purchase ones, reports `reports.view`, the setting and the warehouse field the existing settings/warehouse ones.

## Golden scenarios
CS1–CS8 in BUILD_PLAN §18 are the acceptance reference.

## Not in this phase
Consignment out (our goods held by a customer); consignment in foreign currency; transfers between consignment
warehouses of the same supplier; POS integration (Phase 31, ADR-048).
