/*
  Warnings:

  - You are about to drop the `payroll_inputs` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `payroll_inputs` DROP FOREIGN KEY `payroll_inputs_tenant_id_company_id_employee_id_fkey`;

-- DropForeignKey
ALTER TABLE `payroll_inputs` DROP FOREIGN KEY `payroll_inputs_tenant_id_company_id_fkey`;

-- DropForeignKey
ALTER TABLE `payroll_inputs` DROP FOREIGN KEY `payroll_inputs_tenant_id_company_id_pay_element_id_fkey`;

-- DropForeignKey
ALTER TABLE `payroll_inputs` DROP FOREIGN KEY `payroll_inputs_tenant_id_fkey`;

-- AlterTable
ALTER TABLE `payroll_line_items` ADD COLUMN `payroll_movement_id` BIGINT UNSIGNED NULL;

-- DropTable
-- pre-release table from unmerged Phase 26a, no production data
DROP TABLE `payroll_inputs`;

-- CreateTable
CREATE TABLE `payroll_movements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `employee_id` BIGINT UNSIGNED NOT NULL,
    `pay_element_id` BIGINT UNSIGNED NOT NULL,
    `movement_no` VARCHAR(50) NULL,
    `movement_date` DATE NOT NULL,
    `period` CHAR(7) NOT NULL,
    `quantity` DECIMAL(18, 6) NULL,
    `rate` DECIMAL(18, 6) NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `status` ENUM('POSTED', 'REVERSED') NOT NULL DEFAULT 'POSTED',
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_entry_id` BIGINT UNSIGNED NULL,
    `reversed_at` DATE NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `payroll_movements_tenant_id_company_id_period_employee_id_idx`(`tenant_id`, `company_id`, `period`, `employee_id`),
    INDEX `payroll_movements_tenant_id_company_id_employee_id_movement__idx`(`tenant_id`, `company_id`, `employee_id`, `movement_date`),
    UNIQUE INDEX `payroll_movements_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_movements_tenant_id_company_id_id_key`(`tenant_id`, `company_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `payroll_line_items_tenant_id_payroll_movement_id_idx` ON `payroll_line_items`(`tenant_id`, `payroll_movement_id`);

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_company_id_employee_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `employee_id`) REFERENCES `employees`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_company_id_pay_element_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `pay_element_id`) REFERENCES `pay_elements`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_company_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_movements` ADD CONSTRAINT `payroll_movements_tenant_id_company_id_reversal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `reversal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_line_items` ADD CONSTRAINT `payroll_line_items_tenant_id_payroll_movement_id_fkey` FOREIGN KEY (`tenant_id`, `payroll_movement_id`) REFERENCES `payroll_movements`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

UPDATE `pay_elements` AS `element`
JOIN `account_mappings` AS `payable_mapping`
  ON `payable_mapping`.`tenant_id` = `element`.`tenant_id`
  AND `payable_mapping`.`company_id` = `element`.`company_id`
  AND `payable_mapping`.`mapping_key` = 'PAYROLL_PAYABLE'
JOIN `accounts` AS `target_account`
  ON `target_account`.`tenant_id` = `element`.`tenant_id`
  AND `target_account`.`company_id` = `element`.`company_id`
  AND `target_account`.`code` = '5201'
  AND `target_account`.`account_type` = 'EXPENSE'
  AND `target_account`.`is_postable` = 1
SET `element`.`account_id` = `target_account`.`id`
WHERE `element`.`tenant_id` = `payable_mapping`.`tenant_id`
  AND `element`.`company_id` = `payable_mapping`.`company_id`
  AND `element`.`code` = 'ABSENCE_DAY'
  AND `element`.`account_id` = `payable_mapping`.`account_id`
  AND `element`.`account_id` <> `target_account`.`id`;

UPDATE `pay_elements` AS `element`
JOIN `account_mappings` AS `payable_mapping`
  ON `payable_mapping`.`tenant_id` = `element`.`tenant_id`
  AND `payable_mapping`.`company_id` = `element`.`company_id`
  AND `payable_mapping`.`mapping_key` = 'PAYROLL_PAYABLE'
JOIN `accounts` AS `target_account`
  ON `target_account`.`tenant_id` = `element`.`tenant_id`
  AND `target_account`.`company_id` = `element`.`company_id`
  AND `target_account`.`code` = '4201'
  AND `target_account`.`account_type` = 'REVENUE'
  AND `target_account`.`is_postable` = 1
SET `element`.`account_id` = `target_account`.`id`
WHERE `element`.`tenant_id` = `payable_mapping`.`tenant_id`
  AND `element`.`company_id` = `payable_mapping`.`company_id`
  AND `element`.`code` = 'PENALTY'
  AND `element`.`account_id` = `payable_mapping`.`account_id`
  AND `element`.`account_id` <> `target_account`.`id`;

INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`, `next_number`,
   `padding`, `created_at`, `updated_at`)
SELECT f.`tenant_id`, f.`company_id`, 'PAYROLL_MOVEMENT', f.`id`, CONCAT('PM-', f.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` f
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` d
  WHERE d.`tenant_id` = f.`tenant_id` AND d.`company_id` = f.`company_id`
    AND d.`document_type` = 'PAYROLL_MOVEMENT' AND d.`fiscal_year_id` = f.`id`
);
