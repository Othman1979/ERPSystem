-- AlterTable
ALTER TABLE `payroll_line_items` ADD COLUMN `leave_request_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `payroll_lines` ADD COLUMN `leave_provision` DECIMAL(18, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payroll_runs` ADD COLUMN `leave_provision_entry_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `payroll_settings` ADD COLUMN `annual_leave_days` DECIMAL(9, 2) NOT NULL DEFAULT 14,
    ADD COLUMN `annual_leave_days_senior` DECIMAL(9, 2) NOT NULL DEFAULT 21,
    ADD COLUMN `annual_leave_senior_years` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `weekly_rest_days` VARCHAR(20) NOT NULL DEFAULT '5';

-- CreateTable
CREATE TABLE `public_holidays` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `date` DATE NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `public_holidays_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `public_holidays_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `public_holidays_tenant_id_company_id_date_key`(`tenant_id`, `company_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_types` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `category` ENUM('ANNUAL', 'SICK', 'MATERNITY', 'PATERNITY', 'HAJJ', 'UNPAID', 'OTHER') NOT NULL,
    `count_basis` ENUM('WORKING_DAYS', 'CALENDAR_DAYS') NOT NULL,
    `max_days_per_year` DECIMAL(9, 2) NULL,
    `max_days_per_request` DECIMAL(9, 2) NULL,
    `hospital_extra_days` DECIMAL(9, 2) NULL,
    `once_per_employment` BOOLEAN NOT NULL DEFAULT false,
    `min_service_years` INTEGER NULL,
    `pay_element_id` BIGINT UNSIGNED NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_types_tenant_id_company_id_category_is_active_idx`(`tenant_id`, `company_id`, `category`, `is_active`),
    UNIQUE INDEX `leave_types_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `leave_types_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `leave_types_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `leave_type_id` BIGINT UNSIGNED NOT NULL,
    `request_no` VARCHAR(50) NULL,
    `start_date` DATE NOT NULL,
    `end_date` DATE NOT NULL,
    `days` DECIMAL(9, 2) NOT NULL,
    `calendar_days` INTEGER NOT NULL,
    `hospitalised` BOOLEAN NOT NULL DEFAULT false,
    `notes` VARCHAR(500) NULL,
    `status` ENUM('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'SUBMITTED',
    `approved_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `cancelled_at` DATE NULL,
    `created_by` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `leave_requests_tenant_id_company_id_employee_id_start_date_e_idx`(`tenant_id`, `company_id`, `employee_id`, `start_date`, `end_date`, `status`),
    INDEX `leave_requests_tenant_id_company_id_status_start_date_idx`(`tenant_id`, `company_id`, `status`, `start_date`),
    UNIQUE INDEX `leave_requests_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `leave_requests_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `leave_requests_tenant_id_company_id_request_no_key`(`tenant_id`, `company_id`, `request_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_balance_adjustments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `leave_type_id` BIGINT UNSIGNED NOT NULL,
    `year` INTEGER NOT NULL,
    `days` DECIMAL(9, 2) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `created_by` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_balance_adjustments_tenant_id_company_id_employee_id_l_idx`(`tenant_id`, `company_id`, `employee_id`, `leave_type_id`, `year`),
    UNIQUE INDEX `leave_balance_adjustments_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `leave_balance_adjustments_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payroll_line_items_tenant_id_leave_request_id_idx` ON `payroll_line_items`(`tenant_id`, `leave_request_id`);

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_leave_provision_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `leave_provision_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_line_items` ADD CONSTRAINT `payroll_line_items_tenant_id_leave_request_id_fkey` FOREIGN KEY (`tenant_id`, `leave_request_id`) REFERENCES `leave_requests`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `public_holidays` ADD CONSTRAINT `public_holidays_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `public_holidays` ADD CONSTRAINT `public_holidays_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_types` ADD CONSTRAINT `leave_types_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_types` ADD CONSTRAINT `leave_types_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_types` ADD CONSTRAINT `leave_types_tenant_id_company_id_pay_element_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `pay_element_id`) REFERENCES `pay_elements`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_tenant_id_company_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_requests` ADD CONSTRAINT `leave_requests_tenant_id_company_id_leave_type_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `leave_type_id`) REFERENCES `leave_types`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balance_adjustments` ADD CONSTRAINT `leave_balance_adjustments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balance_adjustments` ADD CONSTRAINT `leave_balance_adjustments_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balance_adjustments` ADD CONSTRAINT `leave_balance_adjustments_tenant_id_company_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leave_balance_adjustments` ADD CONSTRAINT `leave_balance_adjustments_tenant_id_company_id_leave_type_i_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `leave_type_id`) REFERENCES `leave_types`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 28B defaults for existing companies, following Phase 26 payroll backfill.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, a.`code`, a.`name_ar`, a.`name_en`,
       p.`level` + 1, a.`account_type`, a.`normal_balance`, 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
JOIN (
  SELECT '21' AS `parent_code`, '2109' AS `code`, 'مخصص الإجازات المستحقة' AS `name_ar`,
         'Accrued leave provision' AS `name_en`, 'LIABILITY' AS `account_type`, 'CREDIT' AS `normal_balance`
  UNION ALL SELECT '52', '5207', 'مصروف الإجازات', 'Leave expense', 'EXPENSE', 'DEBIT'
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
  SELECT '2109' AS `code`, 'PAYROLL_LEAVE_PROVISION' AS `mapping_key`
  UNION ALL SELECT '5207', 'PAYROLL_LEAVE_EXPENSE'
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
SELECT c.`tenant_id`, c.`id`, e.`code`, e.`name_ar`, e.`name_en`, 'DEDUCTION', 'PER_DAY',
       1.000000, 1, 1, 0, a.`id`, 1, NOW(3), NOW(3)
FROM `companies` c
JOIN (
  SELECT 'UNPAID_LEAVE_DAY' AS `code`, 'إجازة بدون أجر' AS `name_ar`,
         'Unpaid leave day' AS `name_en`
  UNION ALL SELECT 'MATERNITY_LEAVE_DAY', 'إجازة أمومة', 'Maternity leave day'
) e
JOIN `accounts` a
  ON a.`tenant_id` = c.`tenant_id` AND a.`company_id` = c.`id` AND a.`code` = '5201'
WHERE NOT EXISTS (
  SELECT 1 FROM `pay_elements` x
  WHERE x.`tenant_id` = c.`tenant_id` AND x.`company_id` = c.`id` AND x.`code` = e.`code`
);

INSERT INTO `leave_types`
  (`tenant_id`, `company_id`, `code`, `name_ar`, `name_en`, `category`, `count_basis`,
   `max_days_per_year`, `max_days_per_request`, `hospital_extra_days`,
   `once_per_employment`, `min_service_years`, `pay_element_id`, `is_active`, `created_at`, `updated_at`)
SELECT c.`tenant_id`, c.`id`, l.`code`, l.`name_ar`, l.`name_en`, l.`category`, l.`count_basis`,
       l.`max_days_per_year`, l.`max_days_per_request`, l.`hospital_extra_days`,
       l.`once_per_employment`, l.`min_service_years`, p.`id`, 1, NOW(3), NOW(3)
FROM `companies` c
CROSS JOIN (
  SELECT 'ANNUAL' AS `code`, 'سنوية' AS `name_ar`, 'Annual' AS `name_en`,
         'ANNUAL' AS `category`, 'WORKING_DAYS' AS `count_basis`,
         NULL AS `max_days_per_year`, NULL AS `max_days_per_request`, NULL AS `hospital_extra_days`,
         0 AS `once_per_employment`, NULL AS `min_service_years`, NULL AS `pay_element_code`
  UNION ALL SELECT 'SICK', 'مرضية', 'Sick', 'SICK', 'WORKING_DAYS', 14.00, NULL, 14.00, 0, NULL, NULL
  UNION ALL SELECT 'MATERNITY', 'أمومة', 'Maternity', 'MATERNITY', 'CALENDAR_DAYS', NULL, 70.00, NULL, 0, NULL, 'MATERNITY_LEAVE_DAY'
  UNION ALL SELECT 'PATERNITY', 'أبوة', 'Paternity', 'PATERNITY', 'WORKING_DAYS', NULL, 3.00, NULL, 0, NULL, NULL
  UNION ALL SELECT 'HAJJ', 'حج', 'Hajj', 'HAJJ', 'WORKING_DAYS', NULL, 14.00, NULL, 1, 5, NULL
  UNION ALL SELECT 'UNPAID', 'بدون أجر', 'Unpaid', 'UNPAID', 'CALENDAR_DAYS', NULL, NULL, NULL, 0, NULL, 'UNPAID_LEAVE_DAY'
) l
LEFT JOIN `pay_elements` p
  ON p.`tenant_id` = c.`tenant_id` AND p.`company_id` = c.`id` AND p.`code` = l.`pay_element_code`
WHERE NOT EXISTS (
  SELECT 1 FROM `leave_types` x
  WHERE x.`tenant_id` = c.`tenant_id` AND x.`company_id` = c.`id` AND x.`code` = l.`code`
);

INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`, `next_number`,
   `padding`, `created_at`, `updated_at`)
SELECT f.`tenant_id`, f.`company_id`, 'LEAVE_REQUEST', f.`id`, 'LV', 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` f
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` d
  WHERE d.`tenant_id` = f.`tenant_id` AND d.`company_id` = f.`company_id`
    AND d.`document_type` = 'LEAVE_REQUEST' AND d.`fiscal_year_id` = f.`id`
);
