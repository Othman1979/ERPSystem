-- Phase 11A: cost centres (ADR-013 §3, ADR-024 §1).
-- Every new column is nullable or has a default and is added at the end of its table, so
-- MariaDB 10.11 adds it instantly (no table copy), journal_lines included; no backfill.
-- The one new journal_lines index (journal_lines_cost_center_seek_idx) is built online but
-- reads the whole table: on a large journal_lines run this migration in a quiet window.
-- journal_lines.cost_center_id has no foreign key, like party_id and branch_id (ADR-024 §1.7):
-- job:integrity-check counts the orphans.

-- AlterTable
ALTER TABLE `accounts` ADD COLUMN `cost_center_required` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `companies` ADD COLUMN `cost_centers_enabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `journal_lines` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `purchase_invoices` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `purchase_returns` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `receipts` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `sales_invoices` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `sales_returns` ADD COLUMN `cost_center_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `cost_centers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `is_postable` BOOLEAN NOT NULL DEFAULT true,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `cost_centers_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `cost_centers_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `cost_centers_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `journal_lines_cost_center_seek_idx` ON `journal_lines`(`tenant_id`, `cost_center_id`, `entry_date`, `journal_entry_id`, `line_no`);

-- AddForeignKey
ALTER TABLE `cost_centers` ADD CONSTRAINT `cost_centers_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_centers` ADD CONSTRAINT `cost_centers_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cost_centers` ADD CONSTRAINT `cost_centers_tenant_id_company_id_parent_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `parent_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: the new permission for the roles that manage the chart (permissions.ts). Roles are
-- platform-global, so this covers every existing tenant; prisma/seed.ts grants it to new ones.
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_code`)
SELECT r.`id`, 'cost_center.manage' FROM `roles` r WHERE r.`code` IN ('OWNER', 'ACCOUNTANT');
