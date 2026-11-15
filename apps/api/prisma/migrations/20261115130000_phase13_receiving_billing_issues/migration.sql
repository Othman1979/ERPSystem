/*
  Phase 13 (ADR-026): receiving against purchase orders, invoices from receipts, issues to
  departments and issue requests. Additions only: no posted row is changed.

  Prisma's warnings, reviewed:
  - `unit_cost` on `purchase_invoice_lines` and `purchase_return_lines` goes from DECIMAL(18,3)
    to DECIMAL(18,6) (CLAUDE.md: unit costs are 6 dp; an order price has 6 dp, ADR-026 §5).
    The scale grows, so every stored decimal is kept exactly, but the integer part shrinks from
    15 to 12 digits: a stored unit cost of 10^12 or more would make the ALTER fail (strict mode),
    changing nothing. Check before deploying (docs/runbooks/deploy.md, phase 13); the API now
    refuses a unit cost above 12 integer digits (400).
  - These ALTERs, and the new foreign keys on goods_notes, goods_note_lines and purchase_invoices,
    rebuild those tables: apply with the application stopped, in a maintenance window.
  - The new `purchase_orders.status` values are appended to the ENUM, so stored values keep
    their meaning (MariaDB stores the index; existing members keep theirs).
*/
-- AlterTable
ALTER TABLE `goods_note_lines` ADD COLUMN `billed_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    ADD COLUMN `cleared_value` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    ADD COLUMN `issue_request_line_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `po_line_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `goods_notes` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `expense_account_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `issue_request_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `purchase_order_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `supplier_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `purchase_invoice_lines` MODIFY `unit_cost` DECIMAL(18, 6) NOT NULL;

-- AlterTable
ALTER TABLE `purchase_invoices` ADD COLUMN `price_approved_at` DATETIME(3) NULL,
    ADD COLUMN `price_approved_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `purchase_order_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `purchase_order_lines` ADD COLUMN `received_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `purchase_orders` ADD COLUMN `close_reason` VARCHAR(500) NULL,
    ADD COLUMN `closed_at` DATETIME(3) NULL,
    ADD COLUMN `closed_by` BIGINT UNSIGNED NULL,
    MODIFY `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE `purchase_return_lines` MODIFY `unit_cost` DECIMAL(18, 6) NOT NULL;

-- CreateTable
CREATE TABLE `purchase_invoice_receipts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `invoice_line_id` BIGINT UNSIGNED NOT NULL,
    `grn_line_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `cleared_value` DECIMAL(18, 3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `purchase_invoice_receipts_tenant_id_grn_line_id_idx`(`tenant_id`, `grn_line_id`),
    UNIQUE INDEX `purchase_invoice_receipts_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_invoice_receipts_tenant_id_invoice_line_id_grn_line_key`(`tenant_id`, `invoice_line_id`, `grn_line_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `request_no` VARCHAR(50) NULL,
    `request_date` DATE NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `expense_account_id` BIGINT UNSIGNED NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
    `notes` VARCHAR(500) NULL,
    `submitted_at` DATETIME(3) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(3) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `reject_reason` VARCHAR(500) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancel_reason` VARCHAR(500) NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `issue_requests_tenant_id_company_id_request_date_id_idx`(`tenant_id`, `company_id`, `request_date`, `id`),
    INDEX `issue_requests_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `issue_requests_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `issue_requests_tenant_id_company_id_request_no_key`(`tenant_id`, `company_id`, `request_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `issue_request_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `request_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `issued_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `issue_request_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `issue_request_lines_tenant_id_request_id_line_no_key`(`tenant_id`, `request_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `goods_note_lines_tenant_id_po_line_id_idx` ON `goods_note_lines`(`tenant_id`, `po_line_id`);

-- CreateIndex
CREATE INDEX `goods_note_lines_tenant_id_issue_request_line_id_idx` ON `goods_note_lines`(`tenant_id`, `issue_request_line_id`);

-- CreateIndex
CREATE INDEX `goods_notes_tenant_id_purchase_order_id_idx` ON `goods_notes`(`tenant_id`, `purchase_order_id`);

-- CreateIndex
CREATE INDEX `goods_notes_tenant_id_issue_request_id_idx` ON `goods_notes`(`tenant_id`, `issue_request_id`);

-- CreateIndex
CREATE INDEX `purchase_invoices_tenant_id_purchase_order_id_idx` ON `purchase_invoices`(`tenant_id`, `purchase_order_id`);

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_purchase_order_id_fkey` FOREIGN KEY (`tenant_id`, `purchase_order_id`) REFERENCES `purchase_orders`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_purchase_order_id_fkey` FOREIGN KEY (`tenant_id`, `purchase_order_id`) REFERENCES `purchase_orders`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_company_id_expense_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `expense_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_issue_request_id_fkey` FOREIGN KEY (`tenant_id`, `issue_request_id`) REFERENCES `issue_requests`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_note_lines` ADD CONSTRAINT `goods_note_lines_tenant_id_po_line_id_fkey` FOREIGN KEY (`tenant_id`, `po_line_id`) REFERENCES `purchase_order_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_note_lines` ADD CONSTRAINT `goods_note_lines_tenant_id_issue_request_line_id_fkey` FOREIGN KEY (`tenant_id`, `issue_request_line_id`) REFERENCES `issue_request_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_receipts` ADD CONSTRAINT `purchase_invoice_receipts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_receipts` ADD CONSTRAINT `purchase_invoice_receipts_tenant_id_invoice_line_id_fkey` FOREIGN KEY (`tenant_id`, `invoice_line_id`) REFERENCES `purchase_invoice_lines`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_receipts` ADD CONSTRAINT `purchase_invoice_receipts_tenant_id_grn_line_id_fkey` FOREIGN KEY (`tenant_id`, `grn_line_id`) REFERENCES `goods_note_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_requests` ADD CONSTRAINT `issue_requests_tenant_id_company_id_expense_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `expense_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_request_lines` ADD CONSTRAINT `issue_request_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_request_lines` ADD CONSTRAINT `issue_request_lines_tenant_id_request_id_fkey` FOREIGN KEY (`tenant_id`, `request_id`) REFERENCES `issue_requests`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `issue_request_lines` ADD CONSTRAINT `issue_request_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: the issue request sequence (ADR-026 §9, DOCUMENT_TYPE_PREFIXES ISSUE_REQUEST → IRQ) for
-- every existing fiscal year; fiscal.service.ts creates it for new years.
INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, 'ISSUE_REQUEST', fy.`id`,
       CONCAT('IRQ-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = 'ISSUE_REQUEST' AND ds.`fiscal_year_id` = fy.`id`
);
