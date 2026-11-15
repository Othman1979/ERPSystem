-- Phase 12: purchase requests, requests for quotation and purchase orders (ADR-025).
-- New tables only: no column on an existing table, so nothing existing is copied or locked
-- beyond the new foreign keys' parent indexes, which already exist. None of these documents
-- posts a journal entry or a stock movement (ADR-025, the general rule).
-- Data at the end: the PRQ / RFQ / PO sequences of every existing fiscal year (ADR-025 §8),
-- and the new role permission purchase_request.manage (ADR-025 §13).

-- CreateTable
CREATE TABLE `purchase_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `request_no` VARCHAR(50) NULL,
    `request_date` DATE NOT NULL,
    `needed_by` DATE NULL,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED') NOT NULL DEFAULT 'DRAFT',
    `notes` VARCHAR(500) NULL,
    `submitted_at` DATETIME(3) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
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
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `purchase_requests_tenant_id_company_id_request_date_id_idx`(`tenant_id`, `company_id`, `request_date`, `id`),
    INDEX `purchase_requests_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `purchase_requests_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_requests_tenant_id_company_id_request_no_key`(`tenant_id`, `company_id`, `request_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_request_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `request_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `estimated_price` DECIMAL(18, 6) NULL,
    `note` VARCHAR(500) NULL,
    `ordered_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_request_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_request_lines_tenant_id_request_id_line_no_key`(`tenant_id`, `request_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_quotes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `request_id` BIGINT UNSIGNED NOT NULL,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `quote_no` VARCHAR(50) NULL,
    `quote_date` DATE NOT NULL,
    `valid_until` DATE NULL,
    `supplier_ref` VARCHAR(100) NULL,
    `prices_include_tax` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('DRAFT', 'SENT', 'RECEIVED', 'CLOSED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `notes` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `sent_at` DATETIME(3) NULL,
    `sent_by` BIGINT UNSIGNED NULL,
    `received_at` DATETIME(3) NULL,
    `received_by` BIGINT UNSIGNED NULL,
    `closed_at` DATETIME(3) NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `cancelled_at` DATETIME(3) NULL,
    `cancelled_by` BIGINT UNSIGNED NULL,
    `cancel_reason` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `purchase_quotes_tenant_id_company_id_quote_date_id_idx`(`tenant_id`, `company_id`, `quote_date`, `id`),
    INDEX `purchase_quotes_tenant_id_request_id_status_idx`(`tenant_id`, `request_id`, `status`),
    INDEX `purchase_quotes_tenant_id_supplier_id_idx`(`tenant_id`, `supplier_id`),
    INDEX `purchase_quotes_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `purchase_quotes_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_quotes_tenant_id_company_id_quote_no_key`(`tenant_id`, `company_id`, `quote_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_quote_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `quote_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `request_line_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_price` DECIMAL(18, 6) NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_quote_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_quote_lines_tenant_id_quote_id_line_no_key`(`tenant_id`, `quote_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `order_no` VARCHAR(50) NULL,
    `order_date` DATE NOT NULL,
    `expected_date` DATE NULL,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `cost_center_id` BIGINT UNSIGNED NULL,
    `request_id` BIGINT UNSIGNED NULL,
    `prices_include_tax` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `notes` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `submitted_at` DATETIME(3) NULL,
    `submitted_by` BIGINT UNSIGNED NULL,
    `approved_at` DATETIME(3) NULL,
    `approved_by` BIGINT UNSIGNED NULL,
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

    INDEX `purchase_orders_tenant_id_company_id_order_date_id_idx`(`tenant_id`, `company_id`, `order_date`, `id`),
    INDEX `purchase_orders_tenant_id_supplier_id_idx`(`tenant_id`, `supplier_id`),
    INDEX `purchase_orders_tenant_id_request_id_idx`(`tenant_id`, `request_id`),
    INDEX `purchase_orders_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `purchase_orders_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_orders_tenant_id_company_id_order_no_key`(`tenant_id`, `company_id`, `order_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_order_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `order_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `request_line_id` BIGINT UNSIGNED NULL,
    `quote_line_id` BIGINT UNSIGNED NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_price` DECIMAL(18, 6) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `purchase_order_lines_tenant_id_request_line_id_idx`(`tenant_id`, `request_line_id`),
    UNIQUE INDEX `purchase_order_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_order_lines_tenant_id_order_id_line_no_key`(`tenant_id`, `order_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_requests` ADD CONSTRAINT `purchase_requests_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_lines` ADD CONSTRAINT `purchase_request_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_lines` ADD CONSTRAINT `purchase_request_lines_tenant_id_request_id_fkey` FOREIGN KEY (`tenant_id`, `request_id`) REFERENCES `purchase_requests`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_lines` ADD CONSTRAINT `purchase_request_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_request_lines` ADD CONSTRAINT `purchase_request_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quotes` ADD CONSTRAINT `purchase_quotes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quotes` ADD CONSTRAINT `purchase_quotes_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quotes` ADD CONSTRAINT `purchase_quotes_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quotes` ADD CONSTRAINT `purchase_quotes_tenant_id_request_id_fkey` FOREIGN KEY (`tenant_id`, `request_id`) REFERENCES `purchase_requests`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quotes` ADD CONSTRAINT `purchase_quotes_tenant_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_quote_id_fkey` FOREIGN KEY (`tenant_id`, `quote_id`) REFERENCES `purchase_quotes`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_request_line_id_fkey` FOREIGN KEY (`tenant_id`, `request_line_id`) REFERENCES `purchase_request_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_quote_lines` ADD CONSTRAINT `purchase_quote_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_company_id_cost_center_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cost_center_id`) REFERENCES `cost_centers`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_tenant_id_request_id_fkey` FOREIGN KEY (`tenant_id`, `request_id`) REFERENCES `purchase_requests`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_order_id_fkey` FOREIGN KEY (`tenant_id`, `order_id`) REFERENCES `purchase_orders`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_request_line_id_fkey` FOREIGN KEY (`tenant_id`, `request_line_id`) REFERENCES `purchase_request_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_quote_line_id_fkey` FOREIGN KEY (`tenant_id`, `quote_line_id`) REFERENCES `purchase_quote_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Data: document sequences for the new types on existing fiscal years (ADR-025 §8);
-- fiscal.service.ts creates them for new years from DOCUMENT_TYPE_PREFIXES.
INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, t.`doc_type`, fy.`id`,
       CONCAT(t.`prefix`, '-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
JOIN (
  SELECT 'PURCHASE_REQUEST' AS `doc_type`, 'PRQ' AS `prefix`
  UNION ALL SELECT 'PURCHASE_QUOTE', 'RFQ'
  UNION ALL SELECT 'PURCHASE_ORDER', 'PO'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = t.`doc_type` AND ds.`fiscal_year_id` = fy.`id`
);

-- Data: the new role permission (permissions.ts). Roles are platform-global, so this covers
-- every existing tenant; prisma/seed.ts grants it to new ones.
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_code`)
SELECT r.`id`, 'purchase_request.manage' FROM `roles` r WHERE r.`code` IN ('OWNER', 'ACCOUNTANT', 'STOREKEEPER');
