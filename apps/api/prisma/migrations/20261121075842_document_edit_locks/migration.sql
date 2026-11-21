-- CreateTable
CREATE TABLE `document_edit_locks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `doc_type` ENUM('JOURNAL_ENTRY', 'RECEIPT', 'PAYMENT', 'SALES_INVOICE', 'PURCHASE_INVOICE') NOT NULL,
    `doc_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `holder_token` VARCHAR(36) NOT NULL,
    `acquired_at` DATETIME(3) NOT NULL,
    `heartbeat_at` DATETIME(3) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `document_edit_locks_tenant_id_expires_at_idx`(`tenant_id`, `expires_at`),
    UNIQUE INDEX `document_edit_locks_tenant_id_company_id_doc_type_doc_id_key`(`tenant_id`, `company_id`, `doc_type`, `doc_id`),
    UNIQUE INDEX `document_edit_locks_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `document_edit_locks` ADD CONSTRAINT `document_edit_locks_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_edit_locks` ADD CONSTRAINT `document_edit_locks_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `document_edit_locks` ADD CONSTRAINT `document_edit_locks_tenant_id_user_id_fkey` FOREIGN KEY (`tenant_id`, `user_id`) REFERENCES `tenant_memberships`(`tenant_id`, `user_id`) ON DELETE CASCADE ON UPDATE CASCADE;
