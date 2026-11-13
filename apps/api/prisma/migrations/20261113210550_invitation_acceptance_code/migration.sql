-- AlterTable
ALTER TABLE `tenant_memberships` ADD COLUMN `invite_code_attempts` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `invite_code_expires_at` DATETIME(3) NULL,
    ADD COLUMN `invite_code_hash` CHAR(64) NULL;
