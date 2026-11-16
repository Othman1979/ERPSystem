-- CreateTable
CREATE TABLE `stock_count_counters` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `count_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `first_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_count_counters_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_count_counters_tenant_id_count_id_user_id_key`(`tenant_id`, `count_id`, `user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_count_counters` ADD CONSTRAINT `stock_count_counters_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_counters` ADD CONSTRAINT `stock_count_counters_tenant_id_count_id_fkey` FOREIGN KEY (`tenant_id`, `count_id`) REFERENCES `stock_counts`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;
