-- Database review 2026-11-13 (docs/reviews/2026-11-13/review-database.md, wave 2 session 2D).
-- Index-only, plus the three dead columns (DB-17) and the database collation (DB-18).
-- Hand-ordered: the generated diff dropped the tenant FKs that lean on the
-- replaced indexes and re-added them on the wrong tables. Here every new index is
-- created BEFORE the old one is dropped, so a foreign key never loses the index
-- it needs, and no FK is dropped except the three on the removed columns.
-- InnoDB drops an FK's implicit `*_fkey` index by itself once another index can
-- serve the FK, so those drops say IF EXISTS.
-- CREATE INDEX / DROP INDEX run online in InnoDB; DROP COLUMN rebuilds
-- sales_invoices, purchase_invoices and goods_notes.

-- DB-18: the database default matches the tables (utf8mb4_unicode_ci), so a table
-- created outside Prisma, or a literal in raw SQL, cannot mix collations.
ALTER DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- DB-10: journal reports read posted entries of a company by date.
CREATE INDEX `journal_entries_tenant_id_company_id_status_entry_date_idx` ON `journal_entries`(`tenant_id`, `company_id`, `status`, `entry_date`);
DROP INDEX `journal_entries_tenant_id_status_idx` ON `journal_entries`;

-- DB-10: journal lines per account and per party, with the entry join key.
-- (The plan's extra (tenant_id, account_id, party_id) is left out: on 50k lines
-- no query chose it; control balances per party use the party index below.)
CREATE INDEX `journal_lines_tenant_id_account_id_journal_entry_id_idx` ON `journal_lines`(`tenant_id`, `account_id`, `journal_entry_id`);
CREATE INDEX `journal_lines_tenant_id_party_type_party_id_journal_entry_id_idx` ON `journal_lines`(`tenant_id`, `party_type`, `party_id`, `journal_entry_id`);
DROP INDEX `journal_lines_tenant_id_account_id_idx` ON `journal_lines`;
DROP INDEX `journal_lines_tenant_id_party_type_party_id_idx` ON `journal_lines`;

-- DB-10: stock movements by date (list, period balances, stock:verify).
CREATE INDEX `stock_movements_tenant_id_movement_date_id_idx` ON `stock_movements`(`tenant_id`, `movement_date`, `id`);

-- Explicit index for the item FK of stock_balances (replaces the implicit one).
CREATE INDEX `stock_balances_tenant_id_item_id_idx` ON `stock_balances`(`tenant_id`, `item_id`);
DROP INDEX IF EXISTS `stock_balances_tenant_id_item_id_fkey` ON `stock_balances`;

-- Sales invoices: DB-10 indexes, DB-16 number unique per company, DB-17 dead column.
CREATE INDEX `sales_invoices_tenant_id_company_id_invoice_date_id_idx` ON `sales_invoices`(`tenant_id`, `company_id`, `invoice_date`, `id`);
CREATE INDEX `sales_invoices_tenant_id_company_id_status_invoice_date_idx` ON `sales_invoices`(`tenant_id`, `company_id`, `status`, `invoice_date`);
CREATE INDEX `sales_invoices_tenant_id_customer_id_status_payment_type_inv_idx` ON `sales_invoices`(`tenant_id`, `customer_id`, `status`, `payment_type`, `invoice_date`);
CREATE UNIQUE INDEX `sales_invoices_tenant_id_company_id_invoice_no_key` ON `sales_invoices`(`tenant_id`, `company_id`, `invoice_no`);
DROP INDEX `sales_invoices_tenant_id_invoice_no_key` ON `sales_invoices`;
DROP INDEX `sales_invoices_tenant_id_status_idx` ON `sales_invoices`;
ALTER TABLE `sales_invoices` DROP FOREIGN KEY `sales_invoices_tenant_id_reversal_of_id_fkey`;
DROP INDEX IF EXISTS `sales_invoices_tenant_id_reversal_of_id_fkey` ON `sales_invoices`;
ALTER TABLE `sales_invoices` DROP COLUMN `reversal_of_id`;

-- Purchase invoices: the same.
CREATE INDEX `purchase_invoices_tenant_id_company_id_invoice_date_id_idx` ON `purchase_invoices`(`tenant_id`, `company_id`, `invoice_date`, `id`);
CREATE INDEX `purchase_invoices_tenant_id_company_id_status_invoice_date_idx` ON `purchase_invoices`(`tenant_id`, `company_id`, `status`, `invoice_date`);
CREATE INDEX `purchase_invoices_tenant_id_supplier_id_status_payment_type__idx` ON `purchase_invoices`(`tenant_id`, `supplier_id`, `status`, `payment_type`, `invoice_date`);
CREATE UNIQUE INDEX `purchase_invoices_tenant_id_company_id_invoice_no_key` ON `purchase_invoices`(`tenant_id`, `company_id`, `invoice_no`);
DROP INDEX `purchase_invoices_tenant_id_invoice_no_key` ON `purchase_invoices`;
DROP INDEX `purchase_invoices_tenant_id_status_idx` ON `purchase_invoices`;
ALTER TABLE `purchase_invoices` DROP FOREIGN KEY `purchase_invoices_tenant_id_reversal_of_id_fkey`;
DROP INDEX IF EXISTS `purchase_invoices_tenant_id_reversal_of_id_fkey` ON `purchase_invoices`;
ALTER TABLE `purchase_invoices` DROP COLUMN `reversal_of_id`;

-- Sales returns: list index, explicit original-invoice index, number per company.
CREATE INDEX `sales_returns_tenant_id_company_id_return_date_id_idx` ON `sales_returns`(`tenant_id`, `company_id`, `return_date`, `id`);
CREATE INDEX `sales_returns_tenant_id_original_invoice_id_idx` ON `sales_returns`(`tenant_id`, `original_invoice_id`);
CREATE UNIQUE INDEX `sales_returns_tenant_id_company_id_return_no_key` ON `sales_returns`(`tenant_id`, `company_id`, `return_no`);
DROP INDEX IF EXISTS `sales_returns_tenant_id_original_invoice_id_fkey` ON `sales_returns`;
DROP INDEX `sales_returns_tenant_id_return_no_key` ON `sales_returns`;
DROP INDEX `sales_returns_tenant_id_status_idx` ON `sales_returns`;

-- Purchase returns: the same.
CREATE INDEX `purchase_returns_tenant_id_company_id_return_date_id_idx` ON `purchase_returns`(`tenant_id`, `company_id`, `return_date`, `id`);
CREATE INDEX `purchase_returns_tenant_id_original_invoice_id_idx` ON `purchase_returns`(`tenant_id`, `original_invoice_id`);
CREATE UNIQUE INDEX `purchase_returns_tenant_id_company_id_return_no_key` ON `purchase_returns`(`tenant_id`, `company_id`, `return_no`);
DROP INDEX IF EXISTS `purchase_returns_tenant_id_original_invoice_id_fkey` ON `purchase_returns`;
DROP INDEX `purchase_returns_tenant_id_return_no_key` ON `purchase_returns`;
DROP INDEX `purchase_returns_tenant_id_status_idx` ON `purchase_returns`;

-- Goods notes: list index, number per company, DB-17 dead column.
CREATE INDEX `goods_notes_tenant_id_company_id_note_date_id_idx` ON `goods_notes`(`tenant_id`, `company_id`, `note_date`, `id`);
CREATE UNIQUE INDEX `goods_notes_tenant_id_company_id_doc_no_key` ON `goods_notes`(`tenant_id`, `company_id`, `doc_no`);
DROP INDEX `goods_notes_tenant_id_doc_no_key` ON `goods_notes`;
ALTER TABLE `goods_notes` DROP FOREIGN KEY `goods_notes_tenant_id_reversal_of_id_fkey`;
DROP INDEX IF EXISTS `goods_notes_tenant_id_reversal_of_id_fkey` ON `goods_notes`;
ALTER TABLE `goods_notes` DROP COLUMN `reversal_of_id`;

-- Receipts and payments: list indexes, numbers per company.
CREATE INDEX `receipts_tenant_id_company_id_receipt_date_id_idx` ON `receipts`(`tenant_id`, `company_id`, `receipt_date`, `id`);
CREATE UNIQUE INDEX `receipts_tenant_id_company_id_receipt_no_key` ON `receipts`(`tenant_id`, `company_id`, `receipt_no`);
DROP INDEX `receipts_tenant_id_receipt_no_key` ON `receipts`;
CREATE INDEX `payments_tenant_id_company_id_payment_date_id_idx` ON `payments`(`tenant_id`, `company_id`, `payment_date`, `id`);
CREATE UNIQUE INDEX `payments_tenant_id_company_id_payment_no_key` ON `payments`(`tenant_id`, `company_id`, `payment_no`);
DROP INDEX `payments_tenant_id_payment_no_key` ON `payments`;

-- Allocations: explicit indexes for the receipt and payment FKs.
CREATE INDEX `allocations_tenant_id_receipt_id_idx` ON `allocations`(`tenant_id`, `receipt_id`);
CREATE INDEX `allocations_tenant_id_payment_id_idx` ON `allocations`(`tenant_id`, `payment_id`);
DROP INDEX IF EXISTS `allocations_tenant_id_receipt_id_fkey` ON `allocations`;
DROP INDEX IF EXISTS `allocations_tenant_id_payment_id_fkey` ON `allocations`;

-- DB-16: the remaining document numbers, unique per company.
CREATE UNIQUE INDEX `cash_transfers_tenant_id_company_id_transfer_no_key` ON `cash_transfers`(`tenant_id`, `company_id`, `transfer_no`);
DROP INDEX `cash_transfers_tenant_id_transfer_no_key` ON `cash_transfers`;
CREATE UNIQUE INDEX `stock_adjustments_tenant_id_company_id_doc_no_key` ON `stock_adjustments`(`tenant_id`, `company_id`, `doc_no`);
DROP INDEX `stock_adjustments_tenant_id_doc_no_key` ON `stock_adjustments`;
CREATE UNIQUE INDEX `stock_transfers_tenant_id_company_id_doc_no_key` ON `stock_transfers`(`tenant_id`, `company_id`, `doc_no`);
DROP INDEX `stock_transfers_tenant_id_doc_no_key` ON `stock_transfers`;
CREATE UNIQUE INDEX `stock_counts_tenant_id_company_id_doc_no_key` ON `stock_counts`(`tenant_id`, `company_id`, `doc_no`);
DROP INDEX `stock_counts_tenant_id_doc_no_key` ON `stock_counts`;

-- DB-21: audit log by entity, tenant first.
CREATE INDEX `audit_logs_tenant_id_entity_type_entity_id_idx` ON `audit_logs`(`tenant_id`, `entity_type`, `entity_id`);
DROP INDEX `audit_logs_entity_type_entity_id_idx` ON `audit_logs`;
