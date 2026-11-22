-- CreateTable
CREATE TABLE `tenant_databases` (
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `host` VARCHAR(191) NOT NULL,
    `port` INTEGER NOT NULL DEFAULT 3306,
    `database_name` VARCHAR(64) NOT NULL,
    `db_user` VARCHAR(64) NOT NULL,
    `password_sealed` TEXT NOT NULL,
    `schema_version` VARCHAR(255) NULL,
    `state` ENUM('PROVISIONING', 'ACTIVE', 'MIGRATING', 'RETIRED') NOT NULL DEFAULT 'PROVISIONING',
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `tenant_databases_host_port_database_name_key`(`host`, `port`, `database_name`),
    PRIMARY KEY (`tenant_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_tenants` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `user_tenants_tenant_id_idx`(`tenant_id`),
    PRIMARY KEY (`user_id`, `tenant_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tenant_databases` ADD CONSTRAINT `tenant_databases_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_tenants` ADD CONSTRAINT `user_tenants_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_tenants` ADD CONSTRAINT `user_tenants_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill the control-database tenant index from existing memberships.
INSERT INTO `user_tenants` (`user_id`, `tenant_id`, `created_at`)
SELECT `user_id`, `tenant_id`, `created_at`
FROM `tenant_memberships`;
