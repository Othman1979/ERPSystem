-- CreateTable
CREATE TABLE `parties` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER', 'BOTH') NOT NULL,
    `tax_number` VARCHAR(50) NULL,
    `national_id` VARCHAR(50) NULL,
    `phone` VARCHAR(50) NULL,
    `address` VARCHAR(512) NULL,
    `city` VARCHAR(100) NULL,
    `credit_limit` DECIMAL(18, 3) NULL,
    `payment_terms_days` INTEGER NULL,
    `is_cash_customer` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `parties_tenant_id_party_type_idx`(`tenant_id`, `party_type`),
    UNIQUE INDEX `parties_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `parties_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_boxes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `cash_boxes_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `cash_boxes_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `bank_name` VARCHAR(191) NOT NULL,
    `account_no_masked` VARCHAR(50) NULL,
    `iban_masked` VARCHAR(50) NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `bank_accounts_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_invoices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `invoice_no` VARCHAR(50) NULL,
    `invoice_date` DATE NOT NULL,
    `due_date` DATE NULL,
    `customer_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `payment_type` ENUM('CASH', 'CREDIT') NOT NULL,
    `cash_account_id` BIGINT UNSIGNED NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `description` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `paid_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `cost_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `sales_invoices_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `sales_invoices_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_invoices_tenant_id_invoice_no_key`(`tenant_id`, `invoice_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_invoice_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `invoice_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_price` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL,
    `unit_cost` DECIMAL(18, 6) NULL,
    `cost_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sales_invoice_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_invoice_lines_tenant_id_invoice_id_line_no_key`(`tenant_id`, `invoice_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_invoices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `invoice_no` VARCHAR(50) NULL,
    `invoice_date` DATE NOT NULL,
    `due_date` DATE NULL,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `supplier_invoice_no` VARCHAR(100) NULL,
    `supplier_invoice_date` DATE NULL,
    `warehouse_id` BIGINT UNSIGNED NULL,
    `payment_type` ENUM('CASH', 'CREDIT') NOT NULL,
    `cash_account_id` BIGINT UNSIGNED NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `description` VARCHAR(500) NULL,
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `paid_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `purchase_invoices_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `purchase_invoices_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_invoices_tenant_id_invoice_no_key`(`tenant_id`, `invoice_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_invoice_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `invoice_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_cost` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_invoice_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_invoice_lines_tenant_id_invoice_id_line_no_key`(`tenant_id`, `invoice_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_returns` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `return_no` VARCHAR(50) NULL,
    `return_date` DATE NOT NULL,
    `original_invoice_id` BIGINT UNSIGNED NOT NULL,
    `customer_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `refund_type` ENUM('CASH', 'CREDIT') NOT NULL,
    `cash_account_id` BIGINT UNSIGNED NULL,
    `reason` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `cost_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `sales_returns_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `sales_returns_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_returns_tenant_id_return_no_key`(`tenant_id`, `return_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sales_return_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `return_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `original_line_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_price` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL,
    `unit_cost` DECIMAL(18, 6) NULL,
    `cost_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sales_return_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `sales_return_lines_tenant_id_return_id_line_no_key`(`tenant_id`, `return_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_returns` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `return_no` VARCHAR(50) NULL,
    `return_date` DATE NOT NULL,
    `original_invoice_id` BIGINT UNSIGNED NOT NULL,
    `supplier_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `refund_type` ENUM('CASH', 'CREDIT') NOT NULL,
    `cash_account_id` BIGINT UNSIGNED NULL,
    `reason` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `net_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `tax_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `grand_total` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `purchase_returns_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `purchase_returns_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_returns_tenant_id_return_no_key`(`tenant_id`, `return_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_return_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `return_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `original_line_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `qty_base` DECIMAL(18, 6) NOT NULL,
    `unit_cost` DECIMAL(18, 3) NOT NULL,
    `discount_pct` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `discount_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `net_amount` DECIMAL(18, 3) NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `tax_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `tax_amount` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `line_total` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_return_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `purchase_return_lines_tenant_id_return_id_line_no_key`(`tenant_id`, `return_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_notes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `note_date` DATE NOT NULL,
    `note_type` ENUM('GRN', 'GIN') NOT NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `doc_no` VARCHAR(50) NULL,
    `description` VARCHAR(500) NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `goods_notes_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `goods_notes_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `goods_notes_tenant_id_doc_no_key`(`tenant_id`, `doc_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_note_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `note_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `unit_cost` DECIMAL(18, 3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `goods_note_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `goods_note_lines_tenant_id_note_id_line_no_key`(`tenant_id`, `note_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `receipts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `receipt_no` VARCHAR(50) NULL,
    `receipt_date` DATE NOT NULL,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER') NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `cash_account_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `payment_method_id` BIGINT UNSIGNED NULL,
    `reference_no` VARCHAR(100) NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'POSTED',
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `receipts_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `receipts_tenant_id_receipt_no_key`(`tenant_id`, `receipt_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `payment_no` VARCHAR(50) NULL,
    `payment_date` DATE NOT NULL,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER') NULL,
    `party_id` BIGINT UNSIGNED NULL,
    `expense_account_id` BIGINT UNSIGNED NULL,
    `cash_account_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `payment_method_id` BIGINT UNSIGNED NULL,
    `reference_no` VARCHAR(100) NULL,
    `description` VARCHAR(500) NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'POSTED',
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `created_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `payments_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `payments_tenant_id_payment_no_key`(`tenant_id`, `payment_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `allocations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `receipt_id` BIGINT UNSIGNED NULL,
    `payment_id` BIGINT UNSIGNED NULL,
    `party_type` ENUM('CUSTOMER', 'SUPPLIER') NOT NULL,
    `party_id` BIGINT UNSIGNED NOT NULL,
    `document_type` VARCHAR(50) NOT NULL,
    `document_id` BIGINT UNSIGNED NOT NULL,
    `amount` DECIMAL(18, 3) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `allocations_tenant_id_document_type_document_id_idx`(`tenant_id`, `document_type`, `document_id`),
    UNIQUE INDEX `allocations_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `parties` ADD CONSTRAINT `parties_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `parties` ADD CONSTRAINT `parties_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_boxes` ADD CONSTRAINT `cash_boxes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_boxes` ADD CONSTRAINT `cash_boxes_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `cash_boxes` ADD CONSTRAINT `cash_boxes_tenant_id_company_id_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_accounts` ADD CONSTRAINT `bank_accounts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_accounts` ADD CONSTRAINT `bank_accounts_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bank_accounts` ADD CONSTRAINT `bank_accounts_tenant_id_company_id_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_customer_id_fkey` FOREIGN KEY (`tenant_id`, `customer_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoices` ADD CONSTRAINT `sales_invoices_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `sales_invoices`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_invoice_id_fkey` FOREIGN KEY (`tenant_id`, `invoice_id`) REFERENCES `sales_invoices`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_invoice_lines` ADD CONSTRAINT `sales_invoice_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoices` ADD CONSTRAINT `purchase_invoices_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `purchase_invoices`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_invoice_id_fkey` FOREIGN KEY (`tenant_id`, `invoice_id`) REFERENCES `purchase_invoices`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_invoice_lines` ADD CONSTRAINT `purchase_invoice_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_original_invoice_id_fkey` FOREIGN KEY (`tenant_id`, `original_invoice_id`) REFERENCES `sales_invoices`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_customer_id_fkey` FOREIGN KEY (`tenant_id`, `customer_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_returns` ADD CONSTRAINT `sales_returns_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_return_lines` ADD CONSTRAINT `sales_return_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_return_lines` ADD CONSTRAINT `sales_return_lines_tenant_id_return_id_fkey` FOREIGN KEY (`tenant_id`, `return_id`) REFERENCES `sales_returns`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_return_lines` ADD CONSTRAINT `sales_return_lines_tenant_id_original_line_id_fkey` FOREIGN KEY (`tenant_id`, `original_line_id`) REFERENCES `sales_invoice_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_return_lines` ADD CONSTRAINT `sales_return_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sales_return_lines` ADD CONSTRAINT `sales_return_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_original_invoice_id_fkey` FOREIGN KEY (`tenant_id`, `original_invoice_id`) REFERENCES `purchase_invoices`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_supplier_id_fkey` FOREIGN KEY (`tenant_id`, `supplier_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_returns` ADD CONSTRAINT `purchase_returns_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_return_lines` ADD CONSTRAINT `purchase_return_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_return_lines` ADD CONSTRAINT `purchase_return_lines_tenant_id_return_id_fkey` FOREIGN KEY (`tenant_id`, `return_id`) REFERENCES `purchase_returns`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_return_lines` ADD CONSTRAINT `purchase_return_lines_tenant_id_original_line_id_fkey` FOREIGN KEY (`tenant_id`, `original_line_id`) REFERENCES `purchase_invoice_lines`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_return_lines` ADD CONSTRAINT `purchase_return_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_return_lines` ADD CONSTRAINT `purchase_return_lines_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_notes` ADD CONSTRAINT `goods_notes_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `goods_notes`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_note_lines` ADD CONSTRAINT `goods_note_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_note_lines` ADD CONSTRAINT `goods_note_lines_tenant_id_note_id_fkey` FOREIGN KEY (`tenant_id`, `note_id`) REFERENCES `goods_notes`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_note_lines` ADD CONSTRAINT `goods_note_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_party_id_fkey` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_payment_method_id_fkey` FOREIGN KEY (`tenant_id`, `payment_method_id`) REFERENCES `payment_methods`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `receipts` ADD CONSTRAINT `receipts_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_party_id_fkey` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_company_id_expense_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `expense_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_company_id_cash_account_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`, `cash_account_id`) REFERENCES `accounts`(`tenant_id`, `company_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_payment_method_id_fkey` FOREIGN KEY (`tenant_id`, `payment_method_id`) REFERENCES `payment_methods`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_tenant_id_receipt_id_fkey` FOREIGN KEY (`tenant_id`, `receipt_id`) REFERENCES `receipts`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_tenant_id_payment_id_fkey` FOREIGN KEY (`tenant_id`, `payment_id`) REFERENCES `payments`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `allocations` ADD CONSTRAINT `allocations_tenant_id_party_id_fkey` FOREIGN KEY (`tenant_id`, `party_id`) REFERENCES `parties`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Phase 5 data backfill: two new template accounts + mappings for existing
-- companies, and document sequences for the new document types.
-- ---------------------------------------------------------------------------

-- Account 5103 "مشتريات" (EXPENSE) under each company's root '5'.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, '5103', 'مشتريات', 'Purchases',
       p.`level` + 1, 'EXPENSE', 'DEBIT', 1, 0, 1, NOW(3), NOW(3)
FROM `accounts` p
WHERE p.`code` = '5'
  AND NOT EXISTS (
    SELECT 1 FROM `accounts` c
    WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id`
      AND c.`code` = '5103'
  );

-- Account 2104 "بضاعة مستلمة غير مفوترة" (LIABILITY) under each company's '21'.
INSERT INTO `accounts`
  (`tenant_id`, `company_id`, `parent_id`, `code`, `name_ar`, `name_en`, `level`,
   `account_type`, `normal_balance`, `is_postable`, `is_control`, `is_active`,
   `created_at`, `updated_at`)
SELECT p.`tenant_id`, p.`company_id`, p.`id`, '2104', 'بضاعة مستلمة غير مفوترة',
       'Goods received not invoiced', p.`level` + 1, 'LIABILITY', 'CREDIT', 1, 0, 1,
       NOW(3), NOW(3)
FROM `accounts` p
WHERE p.`code` = '21'
  AND NOT EXISTS (
    SELECT 1 FROM `accounts` c
    WHERE c.`tenant_id` = p.`tenant_id` AND c.`company_id` = p.`company_id`
      AND c.`code` = '2104'
  );

-- Mappings for the new accounts.
INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, 'PURCHASES', a.`id`, NOW(3), NOW(3)
FROM `accounts` a
WHERE a.`code` = '5103'
  AND NOT EXISTS (
    SELECT 1 FROM `account_mappings` m
    WHERE m.`tenant_id` = a.`tenant_id` AND m.`company_id` = a.`company_id`
      AND m.`mapping_key` = 'PURCHASES'
  );

INSERT INTO `account_mappings`
  (`tenant_id`, `company_id`, `mapping_key`, `account_id`, `created_at`, `updated_at`)
SELECT a.`tenant_id`, a.`company_id`, 'GOODS_RECEIVED_NOT_INVOICED', a.`id`, NOW(3), NOW(3)
FROM `accounts` a
WHERE a.`code` = '2104'
  AND NOT EXISTS (
    SELECT 1 FROM `account_mappings` m
    WHERE m.`tenant_id` = a.`tenant_id` AND m.`company_id` = a.`company_id`
      AND m.`mapping_key` = 'GOODS_RECEIVED_NOT_INVOICED'
  );

-- Document sequences for new doc types on existing fiscal years.
INSERT INTO `document_sequences`
  (`tenant_id`, `company_id`, `document_type`, `fiscal_year_id`, `prefix`,
   `next_number`, `padding`, `created_at`, `updated_at`)
SELECT fy.`tenant_id`, fy.`company_id`, t.`doc_type`, fy.`id`,
       CONCAT(t.`prefix`, '-', fy.`code`), 1, 6, NOW(3), NOW(3)
FROM `fiscal_years` fy
JOIN (
  SELECT 'GOODS_RECEIPT' AS `doc_type`, 'GRN' AS `prefix`
  UNION ALL SELECT 'GOODS_ISSUE', 'GIN'
  UNION ALL SELECT 'RECEIPT', 'RC'
  UNION ALL SELECT 'PAYMENT', 'PY'
) t
WHERE NOT EXISTS (
  SELECT 1 FROM `document_sequences` ds
  WHERE ds.`tenant_id` = fy.`tenant_id` AND ds.`company_id` = fy.`company_id`
    AND ds.`document_type` = t.`doc_type` AND ds.`fiscal_year_id` = fy.`id`
);
