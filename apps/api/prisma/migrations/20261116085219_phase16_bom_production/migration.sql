-- AlterTable
ALTER TABLE `items` MODIFY `item_kind` ENUM('STOCK', 'SERVICE', 'MANUFACTURED') NOT NULL DEFAULT 'STOCK';

-- CreateTable
CREATE TABLE `boms` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `version_no` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'DRAFT',
    `output_qty` DECIMAL(18, 6) NOT NULL,
    `output_item_unit_id` BIGINT UNSIGNED NOT NULL,
    `output_qty_base` DECIMAL(18, 6) NOT NULL,
    `applied_cost_per_unit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `activated_at` DATETIME(3) NULL,
    `activated_by` BIGINT UNSIGNED NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `boms_tenant_id_company_id_item_id_status_idx`(`tenant_id`, `company_id`, `item_id`, `status`),
    UNIQUE INDEX `boms_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `boms_tenant_id_item_id_version_no_key`(`tenant_id`, `item_id`, `version_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bom_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `bom_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `component_item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `waste_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `bom_lines_tenant_id_component_item_id_idx`(`tenant_id`, `component_item_id`),
    UNIQUE INDEX `bom_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `bom_lines_tenant_id_bom_id_line_no_key`(`tenant_id`, `bom_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_vouchers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `doc_no` VARCHAR(50) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `voucher_date` DATE NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `bom_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `materials_warehouse_id` BIGINT UNSIGNED NOT NULL,
    `output_warehouse_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `description` VARCHAR(500) NULL,
    `applied_cost_per_unit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `applied_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `materials_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `output_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `output_unit_cost` DECIMAL(18, 6) NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `production_vouchers_tenant_id_status_idx`(`tenant_id`, `status`),
    INDEX `production_vouchers_tenant_id_company_id_voucher_date_id_idx`(`tenant_id`, `company_id`, `voucher_date`, `id`),
    UNIQUE INDEX `production_vouchers_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `production_vouchers_tenant_id_company_id_doc_no_key`(`tenant_id`, `company_id`, `doc_no`),
    UNIQUE INDEX `production_vouchers_tenant_id_reversal_of_id_key`(`tenant_id`, `reversal_of_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `production_voucher_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `voucher_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `standard_qty_base` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `unit_cost` DECIMAL(18, 6) NULL,
    `total_cost` DECIMAL(18, 3) NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `production_voucher_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `production_voucher_lines_tenant_id_voucher_id_line_no_key`(`tenant_id`, `voucher_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `boms` ADD CONSTRAINT `boms_tenant_id_output_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `output_item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_tenant_id_bom_id_fkey` FOREIGN KEY (`tenant_id`, `bom_id`) REFERENCES `boms`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_tenant_id_component_item_id_fkey` FOREIGN KEY (`tenant_id`, `component_item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bom_lines` ADD CONSTRAINT `bom_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_bom_id_fkey` FOREIGN KEY (`tenant_id`, `bom_id`) REFERENCES `boms`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_materials_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `materials_warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_output_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `output_warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_vouchers` ADD CONSTRAINT `production_vouchers_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `production_vouchers`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_voucher_lines` ADD CONSTRAINT `production_voucher_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_voucher_lines` ADD CONSTRAINT `production_voucher_lines_tenant_id_voucher_id_fkey` FOREIGN KEY (`tenant_id`, `voucher_id`) REFERENCES `production_vouchers`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_voucher_lines` ADD CONSTRAINT `production_voucher_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `production_voucher_lines` ADD CONSTRAINT `production_voucher_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Phase 16 data backfill (ADR-031 §8): the applied-production-cost account,
-- its mapping, and the MFG document sequences on existing fiscal years.
-- ---------------------------------------------------------------------------

-- Account 5104 "تكاليف إنتاج محمّلة" (EXPENSE, credit in practice) under each company's root '5'.
-- Code 5104 keeps it in the 510x cost-of-sales family with 5101-5103, not the 52x operating
-- expenses. It is credited by production vouchers, so the applied amount offsets the cost.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, '5104', 'تكاليف إنتاج محمّلة',
       'Applied production costs', p.`level` + 1, 'EXPENSE', 'DEBIT', 1, 0, 1,
       NOW(3), NOW(3)
FROM `accounts` p
WHERE p.`code` = '5'
  AND NOT EXISTS (
    SELECT 1 FROM `accounts` c
    WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id`
      AND c.`code` = '5104'
  );

-- Mapping PRODUCTION_APPLIED_COST for the new account.
INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, 'PRODUCTION_APPLIED_COST', a.`id`, NOW(3), NOW(3)
FROM `accounts` a
WHERE a.`code` = '5104'
  AND NOT EXISTS (
    SELECT 1 FROM `account_mappings` m
    WHERE m.`tenant_id` = a.`tenant_id` AND m.`company_id` = a.`company_id`
      AND m.`mapping_key` = 'PRODUCTION_APPLIED_COST'
  );

-- Document sequence for production vouchers on existing fiscal years (ADR-031 §7).
INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, 'PRODUCTION', fy.`id`,
       CONCAT('MFG', '-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = 'PRODUCTION' AND ds.`fiscal_year_id` = fy.`id`
);
