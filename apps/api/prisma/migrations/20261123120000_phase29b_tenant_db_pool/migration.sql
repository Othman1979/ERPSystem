ALTER TABLE `tenant_databases` ADD COLUMN `pending_company_name_ar` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `tenant_db_pool` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `host` VARCHAR(191) NOT NULL,
    `port` INTEGER NOT NULL DEFAULT 3306,
    `database_name` VARCHAR(64) NOT NULL,
    `db_user` VARCHAR(64) NOT NULL,
    `password_sealed` TEXT NOT NULL,
    `schema_version` VARCHAR(255) NULL,
    `claimed_by_tenant_id` BIGINT UNSIGNED NULL,
    `claimed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `tenant_db_pool_claimed_by_tenant_id_key`(`claimed_by_tenant_id`),
    UNIQUE INDEX `tenant_db_pool_host_port_database_name_key`(`host`, `port`, `database_name`),
    INDEX `tenant_db_pool_schema_version_idx`(`schema_version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `tenant_db_pool` ADD CONSTRAINT `tenant_db_pool_claimed_by_tenant_id_fkey` FOREIGN KEY (`claimed_by_tenant_id`) REFERENCES `tenants`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
