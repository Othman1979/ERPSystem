-- AlterTable
ALTER TABLE `sales_return_lines` ADD COLUMN `invoice_discount_net_share` DECIMAL(18, 3) NOT NULL DEFAULT 0;
