-- CreateTable
CREATE TABLE `journal_entries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `entry_no` VARCHAR(50) NULL,
    `entry_date` DATE NOT NULL,
    `fiscal_period_id` BIGINT UNSIGNED NULL,
    `source_type` VARCHAR(50) NOT NULL,
    `source_id` BIGINT UNSIGNED NULL,
    `posting_kind` ENUM('POST', 'REVERSAL') NOT NULL DEFAULT 'POST',
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `description` VARCHAR(500) NULL,
    `total_debit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `total_credit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `journal_entries_tenant_id_company_id_entry_date_idx`(`tenant_id`, `company_id`, `entry_date`),
    INDEX `journal_entries_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `journal_entries_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `journal_entries_tenant_id_source_type_source_id_posting_kind_key`(`tenant_id`, `source_type`, `source_id`, `posting_kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `journal_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `journal_entry_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `debit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `credit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER') NULL,
    `party_id` BIGINT UNSIGNED NULL,
    `description` VARCHAR(500) NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `journal_lines_tenant_id_account_id_idx`(`tenant_id`, `account_id`),
    INDEX `journal_lines_tenant_id_party_type_party_id_idx`(`tenant_id`, `party_type`, `party_id`),
    UNIQUE INDEX `journal_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `journal_lines_tenant_id_journal_entry_id_line_no_key`(`tenant_id`, `journal_entry_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_tenant_id_fiscal_period_id_fkey` FOREIGN KEY (`tenant_id`, `fiscal_period_id`) REFERENCES `fiscal_periods`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_entries` ADD CONSTRAINT `journal_entries_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_tenant_id_account_id_fkey` FOREIGN KEY (`tenant_id`, `account_id`) REFERENCES `accounts`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `journal_lines` ADD CONSTRAINT `journal_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
