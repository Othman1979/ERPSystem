-- AlterTable
ALTER TABLE `employees` ADD COLUMN `tax_dependants` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `tax_other_exemption` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    ADD COLUMN `tax_subject` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `pay_elements` ADD COLUMN `tax_subject` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `payroll_lines` ADD COLUMN `national_contribution` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    ADD COLUMN `tax_manual` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `taxable_income` DECIMAL(18, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `payroll_settings` ADD COLUMN `tax_dependants_exemption` DECIMAL(18, 3) NOT NULL DEFAULT 9000,
    ADD COLUMN `tax_national_rate` DECIMAL(9, 6) NOT NULL DEFAULT 0.01,
    ADD COLUMN `tax_national_threshold` DECIMAL(18, 3) NOT NULL DEFAULT 16666,
    ADD COLUMN `tax_personal_exemption` DECIMAL(18, 3) NOT NULL DEFAULT 9000;

-- CreateTable
CREATE TABLE `payroll_tax_brackets` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `payroll_settings_id` BIGINT UNSIGNED NOT NULL,
    `seq` INTEGER NOT NULL,
    `up_to` DECIMAL(18, 3) NULL,
    `rate` DECIMAL(9, 6) NOT NULL,

    INDEX `payroll_tax_brackets_tenant_id_payroll_settings_id_idx`(`tenant_id`, `payroll_settings_id`),
    UNIQUE INDEX `payroll_tax_brackets_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payroll_tax_brackets_tenant_id_payroll_settings_id_seq_key`(`tenant_id`, `payroll_settings_id`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payroll_tax_brackets` ADD CONSTRAINT `payroll_tax_brackets_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payroll_tax_brackets` ADD CONSTRAINT `payroll_tax_brackets_tenant_id_payroll_settings_id_fkey` FOREIGN KEY (`tenant_id`, `payroll_settings_id`) REFERENCES `payroll_settings`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE `pay_elements`
SET `tax_subject` = CASE
    WHEN `kind` = 'EARNING' THEN true
    WHEN `kind` = 'DEDUCTION' AND `amount_type` IN ('PER_DAY', 'PER_HOUR') THEN true
    ELSE false
END;

INSERT INTO `payroll_tax_brackets` (`tenant_id`, `payroll_settings_id`, `seq`, `up_to`, `rate`)
SELECT settings.`tenant_id`, settings.`id`, brackets.`seq`, brackets.`up_to`, brackets.`rate`
FROM `payroll_settings` AS settings
CROSS JOIN (
    SELECT 1 AS `seq`, CAST(416.000 AS DECIMAL(18, 3)) AS `up_to`, CAST(0.050000 AS DECIMAL(9, 6)) AS `rate`
    UNION ALL SELECT 2, CAST(832.000 AS DECIMAL(18, 3)), CAST(0.100000 AS DECIMAL(9, 6))
    UNION ALL SELECT 3, CAST(1248.000 AS DECIMAL(18, 3)), CAST(0.150000 AS DECIMAL(9, 6))
    UNION ALL SELECT 4, CAST(1664.000 AS DECIMAL(18, 3)), CAST(0.200000 AS DECIMAL(9, 6))
    UNION ALL SELECT 5, CAST(83333.000 AS DECIMAL(18, 3)), CAST(0.250000 AS DECIMAL(9, 6))
    UNION ALL SELECT 6, CAST(NULL AS DECIMAL(18, 3)), CAST(0.300000 AS DECIMAL(9, 6))
) AS brackets;

UPDATE `payroll_lines` SET `tax_manual` = true;
