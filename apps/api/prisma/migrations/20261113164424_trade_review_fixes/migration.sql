/*
  Warnings:

  - You are about to alter the column `unit_cost` on the `goods_note_lines` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,3)` to `Decimal(18,6)`.
  - You are about to alter the column `unit_cost` on the `stock_adjustment_lines` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,3)` to `Decimal(18,6)`.
  - You are about to alter the column `unit_cost` on the `stock_movements` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,3)` to `Decimal(18,6)`.

*/
-- AlterTable
ALTER TABLE `goods_note_lines` MODIFY `unit_cost` DECIMAL(18, 6) NULL;

-- AlterTable
ALTER TABLE `purchase_invoices` ADD COLUMN `prices_include_tax` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `received_grn_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `sales_invoices` ADD COLUMN `prices_include_tax` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `stock_adjustment_lines` MODIFY `unit_cost` DECIMAL(18, 6) NULL;

-- AlterTable
ALTER TABLE `stock_movements` MODIFY `unit_cost` DECIMAL(18, 6) NOT NULL;

-- CreateIndex
CREATE INDEX `purchase_invoices_tenant_id_received_grn_id_idx` ON `purchase_invoices`(`tenant_id`, `received_grn_id`);

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_received_grn_id_fkey` FOREIGN KEY (`tenant_id`, `received_grn_id`) REFERENCES `goods_notes`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
