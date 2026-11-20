-- AlterTable
ALTER TABLE `tenant_memberships` ADD COLUMN `custom_role_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `tenant_roles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tenant_roles_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `tenant_roles_tenant_id_code_key`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tenant_role_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `tenant_role_id` BIGINT UNSIGNED NOT NULL,
    `permission_code` VARCHAR(100) NOT NULL,

    UNIQUE INDEX `tenant_role_permissions_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `tenant_role_permissions_tenant_id_tenant_role_id_permission__key`(`tenant_id`, `tenant_role_id`, `permission_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tenant_memberships` ADD CONSTRAINT `tenant_memberships_tenant_id_custom_role_id_fkey` FOREIGN KEY (`tenant_id`, `custom_role_id`) REFERENCES `tenant_roles`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenant_roles` ADD CONSTRAINT `tenant_roles_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tenant_role_permissions` ADD CONSTRAINT `tenant_role_permissions_tenant_id_tenant_role_id_fkey` FOREIGN KEY (`tenant_id`, `tenant_role_id`) REFERENCES `tenant_roles`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
