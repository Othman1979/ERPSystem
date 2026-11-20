-- CreateTable
CREATE TABLE `membership_companies` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `membership_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `membership_companies_tenant_id_company_id_idx`(`tenant_id`, `company_id`),
    UNIQUE INDEX `membership_companies_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `membership_companies_tenant_id_membership_id_company_id_key`(`tenant_id`, `membership_id`, `company_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `membership_companies` ADD CONSTRAINT `membership_companies_tenant_id_membership_id_fkey` FOREIGN KEY (`tenant_id`, `membership_id`) REFERENCES `tenant_memberships`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `membership_companies` ADD CONSTRAINT `membership_companies_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
