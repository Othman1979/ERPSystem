-- Last tenant status change (ADR-009): grace and retention count from it.
-- AlterTable
ALTER TABLE `tenants` ADD COLUMN `status_changed_at` DATETIME(3) NULL;

-- Existing tenants: the last update is the best known status date.
UPDATE `tenants` SET `status_changed_at` = `updated_at` WHERE `status_changed_at` IS NULL;
