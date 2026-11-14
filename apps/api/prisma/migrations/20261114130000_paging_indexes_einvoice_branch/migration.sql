-- Wave 3E (ADR-022, ADR-003 §10). Additive: new nullable column, new indexes,
-- and a backfill that only fills the new column. No amount or status changes.

-- E-invoice submissions carry their document's branch, so the list can be
-- scoped to the caller's branches (a return's branch is its invoice's).
-- AlterTable
ALTER TABLE `einvoice_submissions` ADD COLUMN `branch_id` BIGINT UNSIGNED NULL;

-- Backfill: invoices from sales_invoices, returns from their original invoice.
UPDATE `einvoice_submissions` s
  JOIN `sales_invoices` i ON i.`tenant_id` = s.`tenant_id` AND i.`id` = s.`document_id`
   SET s.`branch_id` = i.`branch_id`
 WHERE s.`document_type` = 'SALES_INVOICE' AND s.`branch_id` IS NULL;
UPDATE `einvoice_submissions` s
  JOIN `sales_returns` r ON r.`tenant_id` = s.`tenant_id` AND r.`id` = s.`document_id`
  JOIN `sales_invoices` i ON i.`tenant_id` = r.`tenant_id` AND i.`id` = r.`original_invoice_id`
   SET s.`branch_id` = i.`branch_id`
 WHERE s.`document_type` = 'SALES_RETURN' AND s.`branch_id` IS NULL;

-- Lists page by date, newest first (ADR-022).
-- CreateIndex
CREATE INDEX `stock_adjustments_tenant_id_company_id_adjustment_date_id_idx` ON `stock_adjustments`(`tenant_id`, `company_id`, `adjustment_date`, `id`);

-- CreateIndex
CREATE INDEX `stock_transfers_tenant_id_company_id_transfer_date_id_idx` ON `stock_transfers`(`tenant_id`, `company_id`, `transfer_date`, `id`);

-- CreateIndex
CREATE INDEX `stock_counts_tenant_id_company_id_count_date_id_idx` ON `stock_counts`(`tenant_id`, `company_id`, `count_date`, `id`);

-- CreateIndex
CREATE INDEX `cash_transfers_tenant_id_company_id_transfer_date_id_idx` ON `cash_transfers`(`tenant_id`, `company_id`, `transfer_date`, `id`);

-- CreateIndex
CREATE INDEX `einvoice_submissions_tenant_id_company_id_created_at_id_idx` ON `einvoice_submissions`(`tenant_id`, `company_id`, `created_at`, `id`);

-- AddForeignKey
ALTER TABLE `einvoice_submissions` ADD CONSTRAINT `einvoice_submissions_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
