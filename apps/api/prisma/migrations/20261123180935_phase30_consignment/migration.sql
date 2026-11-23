/*
  Warnings:

  - A unique constraint covering the columns `[tenant_id,company_id,item_id,pool_warehouse_id]` on the table `item_costs` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `parties` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[tenant_id,company_id,id]` on the table `warehouses` will be added. If there are existing duplicate values, this will fail.

*/
-- DropForeignKey
ALTER TABLE `item_costs` DROP FOREIGN KEY `item_costs_tenant_id_company_id_fkey`;

-- DropForeignKey
ALTER TABLE `item_costs` DROP FOREIGN KEY `item_costs_tenant_id_fkey`;

-- DropIndex
DROP INDEX `item_costs_tenant_id_company_id_item_id_key` ON `item_costs`;

-- AlterTable
ALTER TABLE `companies` ADD COLUMN `consignment_enabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `goods_notes` MODIFY `note_type` ENUM('GRN', 'GIN', 'CONSIGNMENT_IN', 'CONSIGNMENT_OUT') NOT NULL;

-- AlterTable
ALTER TABLE `item_costs` ADD COLUMN `pool_warehouse_id` BIGINT UNSIGNED NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `purchase_invoice_lines` ADD COLUMN `consignment_cleared_value` DECIMAL(18, 3) NULL,
    ADD COLUMN `consignment_sale_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `purchase_invoices` ADD COLUMN `consignment_settlement` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `warehouses` ADD COLUMN `consignment_supplier_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `consignment_sales` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `source_type` ENUM('SALES_INVOICE', 'STOCK_COUNT') NOT NULL,
    `source_id` BIGINT UNSIGNED NOT NULL,
    `source_line_id` BIGINT UNSIGNED NOT NULL,
    `sale_date` DATE NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `value` DECIMAL(18, 3) NOT NULL,
    `returned_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `returned_value` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `invoiced_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `invoiced_value` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `consignment_sales_tenant_id_company_id_supplier_id_warehouse_idx`(`tenant_id`, `company_id`, `supplier_id`, `warehouse_id`),
    INDEX `consignment_sales_tenant_id_company_id_sale_date_idx`(`tenant_id`, `company_id`, `sale_date`),
    UNIQUE INDEX `consignment_sales_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `consignment_sales_tenant_id_source_type_source_line_id_key`(`tenant_id`, `source_type`, `source_line_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `item_costs_tenant_id_company_id_item_id_pool_warehouse_id_key` ON `item_costs`(`tenant_id`, `company_id`, `item_id`, `pool_warehouse_id`);

-- CreateIndex
CREATE UNIQUE INDEX `parties_tenant_id_company_id_id_key` ON `parties`(`tenant_id`, `company_id`, `id`);

-- CreateIndex
CREATE UNIQUE INDEX `warehouses_tenant_id_company_id_id_key` ON `warehouses`(`tenant_id`, `company_id`, `id`);

-- AddForeignKey
ALTER TABLE `warehouses` ADD CONSTRAINT `warehouses_tenant_id_company_id_consignment_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `consignment_supplier_id`) REFERENCES `parties`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_sales` ADD CONSTRAINT `consignment_sales_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_sales` ADD CONSTRAINT `consignment_sales_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_sales` ADD CONSTRAINT `consignment_sales_tenant_id_company_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_sales` ADD CONSTRAINT `consignment_sales_tenant_id_company_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_sales` ADD CONSTRAINT `consignment_sales_tenant_id_company_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `item_id`) REFERENCES `items`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_consignment_sale_id_fkey` FOREIGN KEY (`tenant_id`, `consignment_sale_id`) REFERENCES `consignment_sales`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, a.`code`, a.`name_ar`, a.`name_en`,
       p.`level` + 1, a.`account_type`, a.`normal_balance`, 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
JOIN (
  SELECT '21' AS `parent_code`, '2111' AS `code`, 'مستحق لموردي الأمانة' AS `name_ar`,
         'Consignment payable' AS `name_en`, 'LIABILITY' AS `account_type`, 'CREDIT' AS `normal_balance`
  UNION ALL SELECT '52', '5209', 'عجز بضاعة الأمانة', 'Consignment shrinkage', 'EXPENSE', 'DEBIT'
) a ON a.`parent_code` = p.`code`
WHERE NOT EXISTS (
  SELECT 1 FROM `accounts` c
  WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id` AND c.`code` = a.`code`
);

INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, m.`mapping_key`, a.`id`, NOW(3), NOW(3)
FROM `accounts` a
JOIN (
  SELECT '2111' AS `code`, 'CONSIGNMENT_PAYABLE' AS `mapping_key`
  UNION ALL SELECT '5209', 'CONSIGNMENT_SHRINKAGE'
) m ON m.`code` = a.`code`
WHERE NOT EXISTS (
  SELECT 1 FROM `account_mappings` x
  WHERE x.`tenant_id` = a.`tenant_id` AND x.`company_id` = a.`company_id`
    AND x.`mapping_key` = m.`mapping_key`
);
