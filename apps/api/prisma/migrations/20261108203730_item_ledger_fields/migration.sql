-- AlterTable
ALTER TABLE `items` ADD COLUMN `default_warehouse_id` BIGINT UNSIGNED NULL,
    ADD COLUMN `image_url` VARCHAR(512) NULL,
    ADD COLUMN `max_stock` DECIMAL(18, 6) NULL,
    ADD COLUMN `sale_price_includes_tax` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `units` ADD COLUMN `un_ece_code` VARCHAR(10) NULL;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_default_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `default_warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
