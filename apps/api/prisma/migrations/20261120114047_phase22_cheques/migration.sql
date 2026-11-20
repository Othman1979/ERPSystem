-- CreateTable
CREATE TABLE `cheques` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `direction` VARCHAR(10) NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `cheque_no` VARCHAR(50) NOT NULL,
    `bank_name` VARCHAR(191) NULL,
    `due_date` DATE NOT NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER') NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `receipt_id` BIGINT UNSIGNED NULL,
    `payment_id` BIGINT UNSIGNED NULL,
    `bank_account_id` BIGINT UNSIGNED NULL,
    `cheque_key` VARCHAR(260) NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `cheques_tenant_id_company_id_direction_status_due_date_idx`(`tenant_id`, `company_id`, `direction`, `status`, `due_date`),
    INDEX `cheques_tenant_id_party_id_idx`(`tenant_id`, `party_id`),
    UNIQUE INDEX `cheques_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `cheques_tenant_id_company_id_cheque_key_key`(`tenant_id`, `company_id`, `cheque_key`),
    UNIQUE INDEX `cheques_tenant_id_receipt_id_key`(`tenant_id`, `receipt_id`),
    UNIQUE INDEX `cheques_tenant_id_payment_id_key`(`tenant_id`, `payment_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cheque_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `cheque_id` BIGINT UNSIGNED NOT NULL,
    `action` VARCHAR(20) NOT NULL,
    `from_status` VARCHAR(20) NULL,
    `to_status` VARCHAR(20) NOT NULL,
    `event_date` DATE NOT NULL,
    `bank_account_id` BIGINT UNSIGNED NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `notes` VARCHAR(500) NULL,
    `undone_at` DATETIME(3) NULL,
    `undone_by` BIGINT UNSIGNED NULL,
    `undo_entry_id` BIGINT UNSIGNED NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cheque_events_tenant_id_cheque_id_id_idx`(`tenant_id`, `cheque_id`, `id`),
    UNIQUE INDEX `cheque_events_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_party_id_fkey` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_receipt_id_fkey` FOREIGN KEY (`tenant_id`, `receipt_id`) REFERENCES `receipts`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_payment_id_fkey` FOREIGN KEY (`tenant_id`, `payment_id`) REFERENCES `payments`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheques` ADD CONSTRAINT `cheques_tenant_id_company_id_bank_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `bank_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheque_events` ADD CONSTRAINT `cheque_events_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheque_events` ADD CONSTRAINT `cheque_events_tenant_id_cheque_id_fkey` FOREIGN KEY (`tenant_id`, `cheque_id`) REFERENCES `cheques`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheque_events` ADD CONSTRAINT `cheque_events_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cheque_events` ADD CONSTRAINT `cheque_events_tenant_id_undo_entry_id_fkey` FOREIGN KEY (`tenant_id`, `undo_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Phase 22 data backfill (ADR-037 §8): the cheque accounts and their mappings
-- for existing companies, as in Phase 16.
-- ---------------------------------------------------------------------------

-- Account 1106 "شيكات برسم التحصيل" under each company's current assets '11'.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, '1106', 'شيكات برسم التحصيل',
       'Cheques under collection', p.`level` + 1, 'ASSET', 'DEBIT', 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
WHERE p.`code` = '11'
  AND NOT EXISTS (
    SELECT 1 FROM `accounts` c
    WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id` AND c.`code` = '1106'
  );

-- Account 2105 "شيكات آجلة الدفع" under each company's current liabilities '21'.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, '2105', 'شيكات آجلة الدفع',
       'Post-dated cheques payable', p.`level` + 1, 'LIABILITY', 'CREDIT', 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
WHERE p.`code` = '21'
  AND NOT EXISTS (
    SELECT 1 FROM `accounts` c
    WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id` AND c.`code` = '2105'
  );

INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, 'CHEQUES_RECEIVABLE', a.`id`, NOW(3), NOW(3)
FROM `accounts` a
WHERE a.`code` = '1106' AND a.`account_type` = 'ASSET'
  AND NOT EXISTS (
    SELECT 1 FROM `account_mappings` m
    WHERE m.`tenant_id` = a.`tenant_id` AND m.`company_id` = a.`company_id`
      AND m.`mapping_key` = 'CHEQUES_RECEIVABLE'
  );

INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, 'CHEQUES_PAYABLE', a.`id`, NOW(3), NOW(3)
FROM `accounts` a
WHERE a.`code` = '2105' AND a.`account_type` = 'LIABILITY'
  AND NOT EXISTS (
    SELECT 1 FROM `account_mappings` m
    WHERE m.`tenant_id` = a.`tenant_id` AND m.`company_id` = a.`company_id`
      AND m.`mapping_key` = 'CHEQUES_PAYABLE'
  );
