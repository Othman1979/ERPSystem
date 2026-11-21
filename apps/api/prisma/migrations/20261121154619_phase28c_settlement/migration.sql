-- AlterTable
ALTER TABLE `payroll_lines` ADD COLUMN `eos_provision` DECIMAL(18, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payroll_settings` ADD COLUMN `eos_national_rate` DECIMAL(9, 6) NOT NULL DEFAULT 0.01,
    ADD COLUMN `eos_national_threshold` DECIMAL(18, 3) NOT NULL DEFAULT 200000,
    ADD COLUMN `eos_tax_exemption` DECIMAL(18, 3) NOT NULL DEFAULT 15000,
    ADD COLUMN `eos_tax_rate` DECIMAL(9, 6) NOT NULL DEFAULT 0.09;

-- CreateTable
CREATE TABLE `payroll_settlements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `settlement_no` VARCHAR(50) NULL,
    `settlement_date` DATE NOT NULL,
    `status` ENUM('DRAFT', 'POSTED', 'PAID', 'REVERSED') NOT NULL DEFAULT 'DRAFT',
    `service_years` DECIMAL(9, 6) NOT NULL,
    `last_wage` DECIMAL(18, 3) NOT NULL,
    `eos_amount` DECIMAL(18, 3) NOT NULL,
    `service_days_before_2010` INTEGER NOT NULL,
    `service_days_2010_to_2014` INTEGER NOT NULL,
    `service_days_from_2015` INTEGER NOT NULL,
    `taxable_amount` DECIMAL(18, 3) NOT NULL,
    `eos_tax` DECIMAL(18, 3) NOT NULL,
    `national_contribution` DECIMAL(18, 3) NOT NULL,
    `provision_used` DECIMAL(18, 3) NOT NULL,
    `net` DECIMAL(18, 3) NOT NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `payment_entry_id` BIGINT UNSIGNED NULL,
    `reversal_entry_id` BIGINT UNSIGNED NULL,
    `payment_reversal_entry_id` BIGINT UNSIGNED NULL,
    `paid_from_cash_box_id` BIGINT UNSIGNED NULL,
    `paid_from_bank_account_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `paid_at` DATETIME(3) NULL,
    `paid_by` BIGINT UNSIGNED NULL,
    `reversed_at` DATETIME(3) NULL,
    `reversed_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_settlements_tenant_id_company_id_employee_id_status_idx`(`tenant_id`, `company_id`, `employee_id`, `status`),
    INDEX `payroll_settlements_tenant_id_company_id_settlement_date_sta_idx`(`tenant_id`, `company_id`, `settlement_date`, `status`),
    UNIQUE INDEX `payroll_settlements_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_settlements_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `payroll_settlements_tenant_id_company_id_settlement_no_key`(`tenant_id`, `company_id`, `settlement_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_payment_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `payment_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_reversal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `reversal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_payment_reversal_e_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `payment_reversal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_paid_from_cash_box_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `paid_from_cash_box_id`) REFERENCES `cash_boxes`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settlements` ADD CONSTRAINT `payroll_settlements_tenant_id_company_id_paid_from_bank_acc_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `paid_from_bank_account_id`) REFERENCES `bank_accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, a.`code`, a.`name_ar`, a.`name_en`,
       p.`level` + 1, a.`account_type`, a.`normal_balance`, 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
JOIN (
  SELECT '21' AS `parent_code`, '2110' AS `code`, 'مخصص مكافأة نهاية الخدمة' AS `name_ar`,
         'End-of-service provision' AS `name_en`, 'LIABILITY' AS `account_type`, 'CREDIT' AS `normal_balance`
  UNION ALL SELECT '52', '5208', 'مصروف مكافأة نهاية الخدمة', 'End-of-service expense', 'EXPENSE', 'DEBIT'
) a ON a.`parent_code` = p.`code`
WHERE NOT EXISTS (
  SELECT 1 FROM `accounts` c
  WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id` AND c.`code` = a.`code`
);

INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, m.`mapping_key`, a.`id`, NOW(3), NOW(3)
FROM `accounts` a
JOIN (
  SELECT '2110' AS `code`, 'PAYROLL_EOS_PROVISION' AS `mapping_key`
  UNION ALL SELECT '5208', 'PAYROLL_EOS_EXPENSE'
) m ON m.`code` = a.`code`
WHERE NOT EXISTS (
  SELECT 1 FROM `account_mappings` x
  WHERE x.`tenant_id` = a.`tenant_id` AND x.`company_id` = a.`company_id`
    AND x.`mapping_key` = m.`mapping_key`
);

INSERT INTO `pay_elements`
  (`tenant_id`, `company_id`, `code`, `name_ar`, `name_en`, `kind`, `amount_type`,
   `rate_factor`, `ssc_subject`, `tax_subject`, `is_fixed_allowance`, `account_id`,
   `is_active`, `created_at`, `updated_at`)
SELECT c.`tenant_id`, c.`id`, 'LEAVE_ENCASHMENT', 'بدل إجازات غير مستعملة',
       'Unused leave encashment', 'EARNING', 'FIXED', 1.000000, 0, 1, 0, a.`id`, 1, NOW(3), NOW(3)
FROM `companies` c
JOIN `accounts` a
  ON a.`tenant_id` = c.`tenant_id` AND a.`company_id` = c.`id` AND a.`code` = '5207'
WHERE NOT EXISTS (
  SELECT 1 FROM `pay_elements` x
  WHERE x.`tenant_id` = c.`tenant_id` AND x.`company_id` = c.`id` AND x.`code` = 'LEAVE_ENCASHMENT'
);

INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`, `next_number`,
   `padding`, `created_at`, `updated_at`)
SELECT f.`tenant_id`, f.`company_id`, 'PAYROLL_SETTLEMENT', f.`id`, 'FS', 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` f
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` d
  WHERE d.`tenant_id` = f.`tenant_id` AND d.`company_id` = f.`company_id`
    AND d.`document_type` = 'PAYROLL_SETTLEMENT' AND d.`fiscal_year_id` = f.`id`
);
