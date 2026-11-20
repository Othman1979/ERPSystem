-- CreateTable
CREATE TABLE `bank_statements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `bank_account_id` BIGINT UNSIGNED NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `opening_balance` DECIMAL(18, 3) NOT NULL,
    `closing_balance` DECIMAL(18, 3) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `book_balance` DECIMAL(18, 3) NULL,
    `outstanding_deposits` DECIMAL(18, 3) NULL,
    `outstanding_payments` DECIMAL(18, 3) NULL,
    `reconciled_by` BIGINT UNSIGNED NULL,
    `reconciled_at` DATETIME(3) NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `bank_statements_tenant_id_bank_account_id_end_date_idx`(`tenant_id`, `bank_account_id`, `end_date`),
    UNIQUE INDEX `bank_statements_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_statement_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `statement_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `line_date` DATE NOT NULL,
    `description` VARCHAR(500) NULL,
    `reference` VARCHAR(100) NULL,
    `deposit` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `withdrawal` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `bank_statement_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `bank_statement_lines_tenant_id_statement_id_line_no_key`(`tenant_id`, `statement_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_statement_matches` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `statement_id` BIGINT UNSIGNED NOT NULL,
    `statement_line_id` BIGINT UNSIGNED NOT NULL,
    `journal_line_id` BIGINT UNSIGNED NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `bank_statement_matches_tenant_id_statement_line_id_idx`(`tenant_id`, `statement_line_id`),
    INDEX `bank_statement_matches_tenant_id_statement_id_idx`(`tenant_id`, `statement_id`),
    UNIQUE INDEX `bank_statement_matches_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `bank_statement_matches_tenant_id_journal_line_id_key`(`tenant_id`, `journal_line_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `bank_statements` ADD CONSTRAINT `bank_statements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statements` ADD CONSTRAINT `bank_statements_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statements` ADD CONSTRAINT `bank_statements_tenant_id_bank_account_id_fkey` FOREIGN KEY (`tenant_id`, `bank_account_id`) REFERENCES `bank_accounts`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_lines` ADD CONSTRAINT `bank_statement_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_lines` ADD CONSTRAINT `bank_statement_lines_tenant_id_statement_id_fkey` FOREIGN KEY (`tenant_id`, `statement_id`) REFERENCES `bank_statements`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_matches` ADD CONSTRAINT `bank_statement_matches_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_matches` ADD CONSTRAINT `bank_statement_matches_tenant_id_statement_id_fkey` FOREIGN KEY (`tenant_id`, `statement_id`) REFERENCES `bank_statements`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_matches` ADD CONSTRAINT `bank_statement_matches_tenant_id_statement_line_id_fkey` FOREIGN KEY (`tenant_id`, `statement_line_id`) REFERENCES `bank_statement_lines`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_statement_matches` ADD CONSTRAINT `bank_statement_matches_tenant_id_journal_line_id_fkey` FOREIGN KEY (`tenant_id`, `journal_line_id`) REFERENCES `journal_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
