-- AlterTable
ALTER TABLE `items` MODIFY `item_kind` ENUM('STOCK', 'SERVICE', 'MANUFACTURED', 'RECIPE') NOT NULL DEFAULT 'STOCK';

-- AlterTable
ALTER TABLE `sales_invoice_lines` ADD COLUMN `recipe_bom_missing` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `sales_invoice_line_components` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `invoice_id` BIGINT UNSIGNED NOT NULL,
    `invoice_line_id` BIGINT UNSIGNED NOT NULL,
    `component_item_id` BIGINT UNSIGNED NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_cost` DECIMAL(18, 6) NOT NULL,
    `total_cost` DECIMAL(18, 3) NOT NULL,
    `movement_id` BIGINT UNSIGNED NOT NULL,
    `bom_id` BIGINT UNSIGNED NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sales_invoice_line_components_tenant_id_invoice_id_idx`(`tenant_id`, `invoice_id`),
    INDEX `sales_invoice_line_components_tenant_id_invoice_line_id_idx`(`tenant_id`, `invoice_line_id`),
    INDEX `sales_invoice_line_components_tenant_id_component_item_id_idx`(`tenant_id`, `component_item_id`),
    INDEX `sales_invoice_line_components_tenant_id_movement_id_idx`(`tenant_id`, `movement_id`),
    UNIQUE INDEX `sales_invoice_line_components_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_invoice_id_fkey` FOREIGN KEY (`tenant_id`, `invoice_id`) REFERENCES `sales_invoices`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_invoice_line_id_fkey` FOREIGN KEY (`tenant_id`, `invoice_line_id`) REFERENCES `sales_invoice_lines`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_component_item_id_fkey` FOREIGN KEY (`tenant_id`, `component_item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_movement_id_fkey` FOREIGN KEY (`tenant_id`, `movement_id`) REFERENCES `stock_movements`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_line_components` ADD CONSTRAINT `sales_invoice_line_components_tenant_id_bom_id_fkey` FOREIGN KEY (`tenant_id`, `bom_id`) REFERENCES `boms`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
