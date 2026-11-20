/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `bank_accounts` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `branches` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `cash_boxes` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `items` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `journal_entries` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateTable
CREATE TABLE `employees` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `national_id` VARCHAR(50) NULL,
    `ssc_number` VARCHAR(50) NULL,
    `hire_date` DATE NOT NULL,
    `leave_date` DATE NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `pay_method` ENUM('BANK', 'CASH') NOT NULL,
    `iban` VARCHAR(50) NULL,
    `ssc_covered` BOOLEAN NOT NULL DEFAULT true,
    `ssc_hazardous` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employees_tenant_id_company_id_is_active_code_idx`(`tenant_id`, `company_id`, `is_active`, `code`),
    UNIQUE INDEX `employees_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `employees_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `employees_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_salaries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `effective_from` DATE NOT NULL,
    `basic_salary` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `employee_salaries_tenant_id_employee_id_effective_from_idx`(`tenant_id`, `employee_id`, `effective_from`),
    UNIQUE INDEX `employee_salaries_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `employee_salaries_employee_id_effective_from_key`(`employee_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pay_elements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `kind` ENUM('EARNING', 'DEDUCTION') NOT NULL,
    `amount_type` ENUM('FIXED', 'PER_HOUR', 'PER_DAY') NOT NULL,
    `rate_factor` DECIMAL(9, 6) NOT NULL DEFAULT 1,
    `ssc_subject` BOOLEAN NOT NULL DEFAULT true,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `pay_elements_tenant_id_company_id_kind_is_active_idx`(`tenant_id`, `company_id`, `kind`, `is_active`),
    UNIQUE INDEX `pay_elements_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `pay_elements_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `pay_elements_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `employee_recurring_elements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `pay_element_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 3) NULL,
    `quantity` DECIMAL(18, 6) NULL,
    `valid_from` DATE NOT NULL,
    `valid_to` DATE NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `employee_recurring_elements_tenant_id_employee_id_valid_from_idx`(`tenant_id`, `employee_id`, `valid_from`, `valid_to`),
    UNIQUE INDEX `employee_recurring_elements_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_inputs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `pay_element_id` BIGINT UNSIGNED NOT NULL,
    `period` CHAR(7) NOT NULL,
    `work_date` DATE NULL,
    `quantity` DECIMAL(18, 6) NULL,
    `amount` DECIMAL(18, 3) NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_inputs_tenant_id_company_id_period_employee_id_idx`(`tenant_id`, `company_id`, `period`, `employee_id`),
    INDEX `payroll_inputs_tenant_id_company_id_employee_id_pay_element__idx`(`tenant_id`, `company_id`, `employee_id`, `pay_element_id`, `work_date`),
    UNIQUE INDEX `payroll_inputs_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_inputs_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `effective_from` DATE NOT NULL,
    `ssc_employee_rate` DECIMAL(9, 6) NOT NULL,
    `ssc_employer_rate` DECIMAL(9, 6) NOT NULL,
    `ssc_hazardous_extra` DECIMAL(9, 6) NOT NULL,
    `ssc_min_wage` DECIMAL(18, 3) NOT NULL,
    `ssc_max_wage` DECIMAL(18, 3) NULL,
    `hours_per_month` DECIMAL(9, 2) NOT NULL,
    `days_per_month` DECIMAL(9, 2) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_settings_tenant_id_company_id_effective_from_idx`(`tenant_id`, `company_id`, `effective_from`),
    UNIQUE INDEX `payroll_settings_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_settings_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    UNIQUE INDEX `payroll_settings_tenant_id_company_id_effective_from_key`(`tenant_id`, `company_id`, `effective_from`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_runs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `period` CHAR(7) NOT NULL,
    `run_date` DATE NOT NULL,
    `status` ENUM('DRAFT', 'POSTED', 'PAID', 'REVERSED') NOT NULL DEFAULT 'DRAFT',
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `payment_entry_id` BIGINT UNSIGNED NULL,
    `paid_from_cash_box_id` BIGINT UNSIGNED NULL,
    `paid_from_bank_account_id` BIGINT UNSIGNED NULL,
    `run_no` VARCHAR(50) NULL,
    `basic_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `earnings_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `gross_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `ssc_base_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `ssc_employee_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `ssc_employer_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `income_tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `deductions_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_runs_tenant_id_company_id_period_status_idx`(`tenant_id`, `company_id`, `period`, `status`),
    INDEX `payroll_runs_tenant_id_company_id_run_date_idx`(`tenant_id`, `company_id`, `run_date`),
    UNIQUE INDEX `payroll_runs_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_runs_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `payroll_run_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `basic` DECIMAL(18, 3) NOT NULL,
    `earnings` DECIMAL(18, 3) NOT NULL,
    `gross` DECIMAL(18, 3) NOT NULL,
    `ssc_base` DECIMAL(18, 3) NOT NULL,
    `ssc_employee` DECIMAL(18, 3) NOT NULL,
    `ssc_employer` DECIMAL(18, 3) NOT NULL,
    `income_tax` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `deductions` DECIMAL(18, 3) NOT NULL,
    `net` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_lines_tenant_id_payroll_run_id_idx`(`tenant_id`, `payroll_run_id`),
    UNIQUE INDEX `payroll_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_lines_tenant_id_payroll_run_id_employee_id_key`(`tenant_id`, `payroll_run_id`, `employee_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payroll_line_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `payroll_line_id` BIGINT UNSIGNED NOT NULL,
    `pay_element_id` BIGINT UNSIGNED NULL,
    `kind` ENUM('EARNING', 'DEDUCTION') NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `quantity` DECIMAL(18, 6) NULL,
    `rate` DECIMAL(18, 6) NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `payroll_line_items_tenant_id_payroll_line_id_idx`(`tenant_id`, `payroll_line_id`),
    UNIQUE INDEX `payroll_line_items_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `bank_accounts_tenant_id_company_id_id_key` ON `bank_accounts`(`tenant_id`, `company_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `branches_tenant_id_company_id_id_key` ON `branches`(`tenant_id`, `company_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `cash_boxes_tenant_id_company_id_id_key` ON `cash_boxes`(`tenant_id`, `company_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `items_tenant_id_company_id_id_key` ON `items`(`tenant_id`, `company_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `journal_entries_tenant_id_company_id_id_key` ON `journal_entries`(`tenant_id`, `company_id`, `id`);

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_tenant_id_company_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_salaries` ADD CONSTRAINT `employee_salaries_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_salaries` ADD CONSTRAINT `employee_salaries_tenant_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pay_elements` ADD CONSTRAINT `pay_elements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pay_elements` ADD CONSTRAINT `pay_elements_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pay_elements` ADD CONSTRAINT `pay_elements_tenant_id_company_id_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_elements` ADD CONSTRAINT `employee_recurring_elements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_elements` ADD CONSTRAINT `employee_recurring_elements_tenant_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `employee_recurring_elements` ADD CONSTRAINT `employee_recurring_elements_tenant_id_pay_element_id_fkey` FOREIGN KEY (`tenant_id`, `pay_element_id`) REFERENCES `pay_elements`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_inputs` ADD CONSTRAINT `payroll_inputs_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_inputs` ADD CONSTRAINT `payroll_inputs_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_inputs` ADD CONSTRAINT `payroll_inputs_tenant_id_company_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_inputs` ADD CONSTRAINT `payroll_inputs_tenant_id_company_id_pay_element_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `pay_element_id`) REFERENCES `pay_elements`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settings` ADD CONSTRAINT `payroll_settings_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_settings` ADD CONSTRAINT `payroll_settings_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_payment_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `payment_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_paid_from_cash_box_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `paid_from_cash_box_id`) REFERENCES `cash_boxes`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_runs` ADD CONSTRAINT `payroll_runs_tenant_id_company_id_paid_from_bank_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `paid_from_bank_account_id`) REFERENCES `bank_accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_lines` ADD CONSTRAINT `payroll_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_lines` ADD CONSTRAINT `payroll_lines_tenant_id_payroll_run_id_fkey` FOREIGN KEY (`tenant_id`, `payroll_run_id`) REFERENCES `payroll_runs`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_lines` ADD CONSTRAINT `payroll_lines_tenant_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_line_items` ADD CONSTRAINT `payroll_line_items_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_line_items` ADD CONSTRAINT `payroll_line_items_tenant_id_payroll_line_id_fkey` FOREIGN KEY (`tenant_id`, `payroll_line_id`) REFERENCES `payroll_lines`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_line_items` ADD CONSTRAINT `payroll_line_items_tenant_id_pay_element_id_fkey` FOREIGN KEY (`tenant_id`, `pay_element_id`) REFERENCES `pay_elements`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Phase 26 (ADR-041): chart, mapping, payroll-settings, pay-element and run-number backfill.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, a.`code`, a.`name_ar`, a.`name_en`,
       p.`level` + 1, a.`account_type`, a.`normal_balance`, 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
JOIN (
  SELECT '11' AS `parent_code`, '1107' AS `code`, 'سلف الموظفين' AS `name_ar`,
         'Employee advances' AS `name_en`, 'ASSET' AS `account_type`, 'DEBIT' AS `normal_balance`
  UNION ALL SELECT '21', '2106', 'رواتب مستحقة', 'Salaries payable', 'LIABILITY', 'CREDIT'
  UNION ALL SELECT '21', '2107', 'الضمان الاجتماعي المستحق', 'Social security payable', 'LIABILITY', 'CREDIT'
  UNION ALL SELECT '21', '2108', 'ضريبة دخل مقتطعة', 'Income tax withheld', 'LIABILITY', 'CREDIT'
  UNION ALL SELECT '52', '5206', 'حصة الشركة في الضمان', 'Employer social security', 'EXPENSE', 'DEBIT'
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
  SELECT '5201' AS `code`, 'PAYROLL_SALARIES_EXPENSE' AS `mapping_key`
  UNION ALL SELECT '5206', 'PAYROLL_SSC_EXPENSE'
  UNION ALL SELECT '2106', 'PAYROLL_PAYABLE'
  UNION ALL SELECT '2107', 'PAYROLL_SSC_PAYABLE'
  UNION ALL SELECT '2108', 'PAYROLL_TAX_PAYABLE'
  UNION ALL SELECT '1107', 'EMPLOYEE_ADVANCES'
) m ON m.`code` = a.`code`
WHERE NOT EXISTS (
  SELECT 1 FROM `account_mappings` x
  WHERE x.`tenant_id` = a.`tenant_id` AND x.`company_id` = a.`company_id`
    AND x.`mapping_key` = m.`mapping_key`
);

INSERT INTO `payroll_settings`
  (`tenant_id`, `company_id`, `effective_from`, `ssc_employee_rate`, `ssc_employer_rate`,
   `ssc_hazardous_extra`, `ssc_min_wage`, `ssc_max_wage`, `hours_per_month`, `days_per_month`,
   `created_at`)
SELECT c.`tenant_id`, c.`id`, '2026-01-01', 0.075000, 0.142500, 0.010000,
       290.000, NULL, 240.00, 30.00, NOW(3)
FROM `companies` c
WHERE NOT EXISTS (
  SELECT 1 FROM `payroll_settings` s
  WHERE s.`tenant_id` = c.`tenant_id` AND s.`company_id` = c.`id`
    AND s.`effective_from` = '2026-01-01'
);

INSERT INTO `pay_elements`
  (`tenant_id`, `company_id`, `code`, `name_ar`, `name_en`, `kind`, `amount_type`,
   `rate_factor`, `ssc_subject`, `account_id`, `is_active`, `created_at`, `updated_at`)
SELECT c.`tenant_id`, c.`id`, e.`code`, e.`name_ar`, e.`name_en`, e.`kind`, e.`amount_type`,
       e.`rate_factor`, e.`ssc_subject`, a.`id`, 1, NOW(3), NOW(3)
FROM `companies` c
JOIN (
  SELECT 'OVERTIME_125' AS `code`, 'عمل إضافي ١٢٥٪' AS `name_ar`, 'Overtime 125%' AS `name_en`,
         'EARNING' AS `kind`, 'PER_HOUR' AS `amount_type`, 1.250000 AS `rate_factor`, 1 AS `ssc_subject`, '5201' AS `account_code`
  UNION ALL SELECT 'HOLIDAY_OVERTIME_150', 'عمل إضافي في العطلات ١٥٠٪', 'Holiday overtime 150%',
         'EARNING', 'PER_HOUR', 1.500000, 1, '5201'
  UNION ALL SELECT 'ABSENCE_DAY', 'غياب يوم', 'Absence day', 'DEDUCTION', 'PER_DAY', 1.000000, 1, '2106'
  UNION ALL SELECT 'TRANSPORT', 'بدل مواصلات', 'Transport', 'EARNING', 'FIXED', 1.000000, 0, '5201'
  UNION ALL SELECT 'HOUSING', 'بدل سكن', 'Housing', 'EARNING', 'FIXED', 1.000000, 1, '5201'
  UNION ALL SELECT 'BONUS', 'مكافأة', 'Bonus', 'EARNING', 'FIXED', 1.000000, 1, '5201'
  UNION ALL SELECT 'ADVANCE_REPAYMENT', 'تسديد سلفة', 'Advance repayment', 'DEDUCTION', 'FIXED', 1.000000, 0, '1107'
  UNION ALL SELECT 'PENALTY', 'غرامة', 'Penalty', 'DEDUCTION', 'FIXED', 1.000000, 0, '2106'
) e
JOIN `accounts` a
  ON a.`tenant_id` = c.`tenant_id` AND a.`company_id` = c.`id` AND a.`code` = e.`account_code`
WHERE NOT EXISTS (
  SELECT 1 FROM `pay_elements` x
  WHERE x.`tenant_id` = c.`tenant_id` AND x.`company_id` = c.`id` AND x.`code` = e.`code`
);

INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`, `next_number`,
   `padding`, `created_at`, `updated_at`)
SELECT f.`tenant_id`, f.`company_id`, 'PAYROLL_RUN', f.`id`, CONCAT('PAY-', f.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` f
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` d
  WHERE d.`tenant_id` = f.`tenant_id` AND d.`company_id` = f.`company_id`
    AND d.`document_type` = 'PAYROLL_RUN' AND d.`fiscal_year_id` = f.`id`
);
