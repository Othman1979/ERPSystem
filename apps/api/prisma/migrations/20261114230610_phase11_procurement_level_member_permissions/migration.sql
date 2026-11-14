-- AlterTable
ALTER TABLE `companies` ADD COLUMN `procurement_level` ENUM('SIMPLE', 'MEDIUM', 'FULL') NOT NULL DEFAULT 'SIMPLE';

-- CreateTable
CREATE TABLE `member_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `membership_id` BIGINT UNSIGNED NOT NULL,
    `permission_code` VARCHAR(100) NOT NULL,
    `amount_limit` DECIMAL(18, 3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `member_permissions_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `member_permissions_tenant_id_membership_id_permission_code_key`(`tenant_id`, `membership_id`, `permission_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `member_permissions` ADD CONSTRAINT `member_permissions_tenant_id_membership_id_fkey` FOREIGN KEY (`tenant_id`, `membership_id`) REFERENCES `tenant_memberships`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
