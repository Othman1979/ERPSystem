-- AlterTable
ALTER TABLE `companies` ADD COLUMN `quote_validity_days` INTEGER NOT NULL DEFAULT 30,
    ADD COLUMN `sales_order_approval` ENUM('NONE', 'OVER_CREDIT_LIMIT', 'ALWAYS') NOT NULL DEFAULT 'OVER_CREDIT_LIMIT',
    ADD COLUMN `sales_order_required` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sales_price_locked` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `sales_reservation` ENUM('NONE', 'SOFT', 'HARD') NOT NULL DEFAULT 'SOFT';

-- AlterTable
ALTER TABLE `sales_invoice_lines` ADD COLUMN `order_line_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `sales_invoices` ADD COLUMN `price_approved_at` DATETIME(3) NULL,
    ADD COLUMN `price_approved_by` BIGINT UNSIGNED NULL,
    ADD COLUMN `sales_order_id` BIGINT UNSIGNED NULL;

-- CreateTable
CREATE TABLE `sales_quotes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `warehouse_id` BIGINT UNSIGNED NULL,
    `customer_id` BIGINT UNSIGNED NOT NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `quote_no` VARCHAR(50) NULL,
    `quote_date` DATE NOT NULL,
    `valid_until` DATE NULL,
    `prices_include_tax` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `description` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `sent_at` DATETIME(3) NULL,
    `sent_by` BIGINT UNSIGNED NULL,
    `accepted_at` DATETIME(3) NULL,
    `accepted_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(3) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `reject_reason` VARCHAR(500) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancel_reason` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `sales_quotes_tenant_id_company_id_quote_date_id_idx`(`tenant_id`, `company_id`, `quote_date`, `id`),
    INDEX `sales_quotes_tenant_id_customer_id_idx`(`tenant_id`, `customer_id`),
    INDEX `sales_quotes_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `sales_quotes_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_quotes_tenant_id_company_id_quote_no_key`(`tenant_id`, `company_id`, `quote_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_quote_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `quote_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_price` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sales_quote_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_quote_lines_tenant_id_quote_id_line_no_key`(`tenant_id`, `quote_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_orders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `order_no` VARCHAR(50) NULL,
    `order_date` DATE NOT NULL,
    `expected_date` DATE NULL,
    `customer_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `sales_quote_id` BIGINT UNSIGNED NULL,
    `prices_include_tax` BOOLEAN NOT NULL DEFAULT false,
    `payment_terms_days` INTEGER NULL,
    `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'CONFIRMED', 'PARTIALLY_INVOICED', 'INVOICED', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `description` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `submitted_at` DATETIME(3) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `confirmed_at` DATETIME(3) NULL,
    `confirmed_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
    `rejected_at` DATETIME(3) NULL,
    `rejected_by` BIGINT UNSIGNED NULL,
    `reject_reason` VARCHAR(500) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancel_reason` VARCHAR(500) NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `close_reason` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `sales_orders_tenant_id_company_id_order_date_id_idx`(`tenant_id`, `company_id`, `order_date`, `id`),
    INDEX `sales_orders_tenant_id_customer_id_idx`(`tenant_id`, `customer_id`),
    INDEX `sales_orders_tenant_id_warehouse_id_status_idx`(`tenant_id`, `warehouse_id`, `status`),
    INDEX `sales_orders_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `sales_orders_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_orders_tenant_id_company_id_order_no_key`(`tenant_id`, `company_id`, `order_no`),
    UNIQUE INDEX `sales_orders_tenant_id_sales_quote_id_key`(`tenant_id`, `sales_quote_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_order_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `order_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `quote_line_id` BIGINT UNSIGNED NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `invoiced_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `unit_price` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `sales_order_lines_tenant_id_item_id_idx`(`tenant_id`, `item_id`),
    UNIQUE INDEX `sales_order_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_order_lines_tenant_id_order_id_line_no_key`(`tenant_id`, `order_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `sales_invoice_lines_tenant_id_order_line_id_idx` ON `sales_invoice_lines`(`tenant_id`, `order_line_id`);

-- CreateIndex
CREATE INDEX `sales_invoices_tenant_id_sales_order_id_idx` ON `sales_invoices`(`tenant_id`, `sales_order_id`);

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_sales_order_id_fkey` FOREIGN KEY (`tenant_id`, `sales_order_id`) REFERENCES `sales_orders`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_order_line_id_fkey` FOREIGN KEY (`tenant_id`, `order_line_id`) REFERENCES `sales_order_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_customer_id_fkey` FOREIGN KEY (`tenant_id`, `customer_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quotes` ADD CONSTRAINT `sales_quotes_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quote_lines` ADD CONSTRAINT `sales_quote_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quote_lines` ADD CONSTRAINT `sales_quote_lines_tenant_id_quote_id_fkey` FOREIGN KEY (`tenant_id`, `quote_id`) REFERENCES `sales_quotes`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quote_lines` ADD CONSTRAINT `sales_quote_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quote_lines` ADD CONSTRAINT `sales_quote_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_quote_lines` ADD CONSTRAINT `sales_quote_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_customer_id_fkey` FOREIGN KEY (`tenant_id`, `customer_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_orders` ADD CONSTRAINT `sales_orders_tenant_id_sales_quote_id_fkey` FOREIGN KEY (`tenant_id`, `sales_quote_id`) REFERENCES `sales_quotes`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_order_id_fkey` FOREIGN KEY (`tenant_id`, `order_id`) REFERENCES `sales_orders`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_quote_line_id_fkey` FOREIGN KEY (`tenant_id`, `quote_line_id`) REFERENCES `sales_quote_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_order_lines` ADD CONSTRAINT `sales_order_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: document sequences for the sales quote and order on existing fiscal years (ADR-027 §8);
-- fiscal.service.ts creates them for new years from DOCUMENT_TYPE_PREFIXES.
INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, t.`doc_type`, fy.`id`,
       CONCAT(t.`prefix`, '-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
JOIN (
  SELECT 'SALES_QUOTE' AS `doc_type`, 'SQ' AS `prefix`
  UNION ALL SELECT 'SALES_ORDER', 'SO'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = t.`doc_type` AND ds.`fiscal_year_id` = fy.`id`
);
