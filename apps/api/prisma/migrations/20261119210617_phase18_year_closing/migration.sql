-- AlterTable
ALTER TABLE `journal_entries` ADD COLUMN `is_closing` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `fiscal_year_closings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_entry_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `net_result` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `closed_by` BIGINT UNSIGNED NULL,
    `closed_at` DATETIME(3) NOT NULL,
    `reversed_by` BIGINT UNSIGNED NULL,
    `reversed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `fiscal_year_closings_tenant_id_company_id_fiscal_year_id_sta_idx`(`tenant_id`, `company_id`, `fiscal_year_id`, `status`),
    UNIQUE INDEX `fiscal_year_closings_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `journal_entries_closing_idx` ON `journal_entries`(`tenant_id`, `company_id`, `entry_date`, `is_closing`);

-- AddForeignKey
ALTER TABLE `fiscal_year_closings` ADD CONSTRAINT `fiscal_year_closings_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_year_closings` ADD CONSTRAINT `fiscal_year_closings_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_year_closings` ADD CONSTRAINT `fiscal_year_closings_tenant_id_fiscal_year_id_fkey` FOREIGN KEY (`tenant_id`, `fiscal_year_id`) REFERENCES `fiscal_years`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_year_closings` ADD CONSTRAINT `fiscal_year_closings_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_year_closings` ADD CONSTRAINT `fiscal_year_closings_tenant_id_reversal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill a closing-entry sequence for every fiscal year created before this phase.
INSERT INTO `document_sequences`
    (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`, `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, 'YEAR_CLOSING', fy.`id`, 'CL', 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
LEFT JOIN `document_sequences` ds
    ON ds.`tenant_id` = fy.`tenant_id`
    AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = 'YEAR_CLOSING'
    AND ds.`fiscal_year_id` = fy.`id`
WHERE ds.`id` IS NULL;
