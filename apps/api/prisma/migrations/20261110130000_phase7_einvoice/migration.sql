-- AlterTable
ALTER TABLE `parties` ADD COLUMN `national_id_kind` ENUM('NIN', 'PN') NOT NULL DEFAULT 'NIN';

-- CreateTable
CREATE TABLE `einvoice_settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `environment` ENUM('SANDBOX', 'PRODUCTION') NOT NULL DEFAULT 'SANDBOX',
    `base_url` VARCHAR(255) NULL,
    `client_id` VARCHAR(191) NULL,
    `secret_encrypted` VARCHAR(512) NULL,
    `income_source_sequence` VARCHAR(50) NULL,
    `track` ENUM('INCOME', 'GENERAL_SALES') NOT NULL DEFAULT 'GENERAL_SALES',
    `next_icv` INTEGER NOT NULL DEFAULT 1,
    `is_enabled` BOOLEAN NOT NULL DEFAULT false,
    `enabled_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `einvoice_settings_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `einvoice_settings_tenant_id_company_id_key`(`tenant_id`, `company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `einvoice_submissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `document_type` VARCHAR(30) NOT NULL,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `document_no` VARCHAR(50) NOT NULL,
    `uuid` CHAR(36) NOT NULL,
    `icv` INTEGER NOT NULL,
    `environment` ENUM('SANDBOX', 'PRODUCTION') NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'REJECTED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `claim_token` CHAR(36) NULL,
    `claimed_at` DATETIME(3) NULL,
    `reuse_xml` BOOLEAN NOT NULL DEFAULT false,
    `original_submission_id` BIGINT UNSIGNED NULL,
    `request_xml` MEDIUMTEXT NULL,
    `response_code` INTEGER NULL,
    `response_body` MEDIUMTEXT NULL,
    `errors` JSON NULL,
    `qr_payload` TEXT NULL,
    `government_uuid` VARCHAR(100) NULL,
    `sent_at` DATETIME(3) NULL,
    `completed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `einvoice_submissions_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    INDEX `einvoice_submissions_claim_token_idx`(`claim_token`),
    UNIQUE INDEX `einvoice_submissions_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `einvoice_submissions_tenant_id_document_type_document_id_key`(`tenant_id`, `document_type`, `document_id`),
    UNIQUE INDEX `einvoice_submissions_tenant_id_company_id_icv_key`(`tenant_id`, `company_id`, `icv`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `einvoice_attempts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `submission_id` BIGINT UNSIGNED NOT NULL,
    `attempt_no` INTEGER NOT NULL,
    `outcome` VARCHAR(20) NOT NULL,
    `http_status` INTEGER NULL,
    `response_body` MEDIUMTEXT NULL,
    `message` VARCHAR(1000) NULL,
    `started_at` DATETIME(3) NOT NULL,
    `finished_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `einvoice_attempts_tenant_id_submission_id_attempt_no_key`(`tenant_id`, `submission_id`, `attempt_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `einvoice_settings` ADD CONSTRAINT `einvoice_settings_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_settings` ADD CONSTRAINT `einvoice_settings_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_submissions` ADD CONSTRAINT `einvoice_submissions_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_submissions` ADD CONSTRAINT `einvoice_submissions_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_submissions` ADD CONSTRAINT `einvoice_submissions_tenant_id_original_submission_id_fkey` FOREIGN KEY (`tenant_id`, `original_submission_id`) REFERENCES `einvoice_submissions`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_attempts` ADD CONSTRAINT `einvoice_attempts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `einvoice_attempts` ADD CONSTRAINT `einvoice_attempts_tenant_id_submission_id_fkey` FOREIGN KEY (`tenant_id`, `submission_id`) REFERENCES `einvoice_submissions`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
