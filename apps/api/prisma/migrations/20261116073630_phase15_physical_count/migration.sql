-- AlterTable
ALTER TABLE `stock_count_lines` ADD COLUMN `counted_at` DATETIME(3) NULL,
    ADD COLUMN `counted_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `counted_unit_qty` DECIMAL(18, 6) NULL,
    ADD COLUMN `item_unit_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `stock_counts` ADD COLUMN `blind` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `created_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `include_zero` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `item_group_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `scope` ENUM('WAREHOUSE', 'GROUP', 'ITEMS') NOT NULL DEFAULT 'WAREHOUSE',
    ADD COLUMN `submitted_at` DATETIME(3) NULL,
    ADD COLUMN `submitted_by` BIGINT UNSIGNED NULL,
    MODIFY `status` ENUM('DRAFT', 'SUBMITTED', 'POSTED') NOT NULL DEFAULT 'DRAFT';

-- AddForeignKey
ALTER TABLE `stock_counts` ADD CONSTRAINT `stock_counts_tenant_id_item_group_id_fkey` FOREIGN KEY (`tenant_id`, `item_group_id`) REFERENCES `item_groups`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_lines` ADD CONSTRAINT `stock_count_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
