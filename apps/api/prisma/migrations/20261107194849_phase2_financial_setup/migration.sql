-- CreateTable
CREATE TABLE `countries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(10) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `phone_code` VARCHAR(10) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `countries_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `units` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `units_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `units_tenant_id_code_key`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tax_categories` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `rate` DECIMAL(9, 4) NOT NULL,
    `einvoice_code` VARCHAR(50) NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tax_categories_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `tax_categories_tenant_id_code_key`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_methods` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_methods_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payment_methods_tenant_id_code_key`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fiscal_years` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(20) NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `fiscal_years_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `fiscal_years_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fiscal_periods` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `period_no` INTEGER NOT NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `status` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `closed_at` DATETIME(3) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `fiscal_periods_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `fiscal_periods_tenant_id_fiscal_year_id_period_no_key`(`tenant_id`, `fiscal_year_id`, `period_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `level` INTEGER NOT NULL,
    `account_type` ENUM('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE') NOT NULL,
    `normal_balance` ENUM('DEBIT', 'CREDIT') NOT NULL,
    `is_postable` BOOLEAN NOT NULL DEFAULT true,
    `is_control` BOOLEAN NOT NULL DEFAULT false,
    `control_type` ENUM('CUSTOMERS', 'SUPPLIERS', 'CASH', 'BANK') NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `accounts_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `accounts_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `accounts_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `account_mappings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `mapping_key` VARCHAR(100) NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `account_mappings_tenant_id_company_id_mapping_key_key`(`tenant_id`, `company_id`, `mapping_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `document_sequences` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `document_type` VARCHAR(50) NOT NULL,
    `fiscal_year_id` BIGINT UNSIGNED NOT NULL,
    `prefix` VARCHAR(20) NOT NULL,
    `next_number` INTEGER NOT NULL DEFAULT 1,
    `padding` INTEGER NOT NULL DEFAULT 6,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `document_sequences_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `document_sequences_tenant_id_company_id_document_type_fiscal_key`(`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `units` ADD CONSTRAINT `units_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tax_categories` ADD CONSTRAINT `tax_categories_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_methods` ADD CONSTRAINT `payment_methods_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_years` ADD CONSTRAINT `fiscal_years_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_years` ADD CONSTRAINT `fiscal_years_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `fiscal_periods` ADD CONSTRAINT `fiscal_periods_tenant_id_fiscal_year_id_fkey` FOREIGN KEY (`tenant_id`, `fiscal_year_id`) REFERENCES `fiscal_years`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `accounts` ADD CONSTRAINT `accounts_tenant_id_company_id_parent_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `parent_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_mappings` ADD CONSTRAINT `account_mappings_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `account_mappings` ADD CONSTRAINT `account_mappings_tenant_id_company_id_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_sequences` ADD CONSTRAINT `document_sequences_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_sequences` ADD CONSTRAINT `document_sequences_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_sequences` ADD CONSTRAINT `document_sequences_tenant_id_fiscal_year_id_fkey` FOREIGN KEY (`tenant_id`, `fiscal_year_id`) REFERENCES `fiscal_years`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
