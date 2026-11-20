-- AlterTable
ALTER TABLE `sales_invoice_lines` ADD COLUMN `invoice_discount_share` DECIMAL(18, 3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `sales_invoices` ADD COLUMN `invoice_discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    ADD COLUMN `invoice_discount_pct` DECIMAL(9, 4) NULL;

-- AlterTable
ALTER TABLE `sales_return_lines` ADD COLUMN `invoice_discount_share` DECIMAL(18, 3) NOT NULL DEFAULT 0;
