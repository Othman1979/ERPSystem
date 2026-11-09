-- AlterTable
ALTER TABLE `allocations` ADD COLUMN `cancelled_at` DATETIME(3) NULL,
    ADD COLUMN `cancelled_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `created_by` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `payments` ADD COLUMN `branch_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `reversal_entry_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `reversed_at` DATETIME(3) NULL,
    ADD COLUMN `reversed_by` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `receipts` ADD COLUMN `branch_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `reversal_entry_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `reversed_at` DATETIME(3) NULL,
    ADD COLUMN `reversed_by` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `cash_transfers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `transfer_no` VARCHAR(50) NULL,
    `transfer_date` DATE NOT NULL,
    `from_account_id` BIGINT UNSIGNED NOT NULL,
    `to_account_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `reference_no` VARCHAR(100) NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'POSTED',
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversed_at` DATETIME(3) NULL,
    `reversed_by` BIGINT UNSIGNED NULL,
    `reversal_entry_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    INDEX `cash_transfers_tenant_id_transfer_date_idx`(`tenant_id`, `transfer_date`),
    UNIQUE INDEX `cash_transfers_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `cash_transfers_tenant_id_transfer_no_key`(`tenant_id`, `transfer_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cash_transfers` ADD CONSTRAINT `cash_transfers_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_transfers` ADD CONSTRAINT `cash_transfers_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_transfers` ADD CONSTRAINT `cash_transfers_tenant_id_company_id_from_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `from_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_transfers` ADD CONSTRAINT `cash_transfers_tenant_id_company_id_to_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `to_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_transfers` ADD CONSTRAINT `cash_transfers_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
