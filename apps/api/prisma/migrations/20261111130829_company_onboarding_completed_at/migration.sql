-- Setup wizard completion (§13.4, ADR-009).
-- AlterTable
ALTER TABLE `companies` ADD COLUMN `onboarding_completed_at` DATETIME(3) NULL;

-- Companies that already have a fiscal year were set up before the wizard
-- existed: do not send them through it.
UPDATE `companies` c
SET c.`onboarding_completed_at` = NOW(3)
WHERE c.`onboarding_completed_at` IS NULL
  AND EXISTS (SELECT 1 FROM `fiscal_years` f WHERE f.`tenant_id` = c.`tenant_id` AND f.`company_id` = c.`id`);
