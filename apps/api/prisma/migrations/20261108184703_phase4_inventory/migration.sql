-- CreateTable
CREATE TABLE `item_groups` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `item_groups_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `item_groups_tenant_id_code_key`(`tenant_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `description` VARCHAR(500) NULL,
    `item_group_id` BIGINT UNSIGNED NULL,
    `item_kind` ENUM('STOCK', 'SERVICE') NOT NULL DEFAULT 'STOCK',
    `base_unit_id` BIGINT UNSIGNED NOT NULL,
    `tax_category_id` BIGINT UNSIGNED NULL,
    `sale_price` DECIMAL(18, 3) NULL,
    `purchase_price` DECIMAL(18, 3) NULL,
    `min_stock` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    INDEX `items_tenant_id_item_kind_idx`(`tenant_id`, `item_kind`),
    UNIQUE INDEX `items_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `items_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_units` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `unit_id` BIGINT UNSIGNED NOT NULL,
    `factor_to_base` DECIMAL(18, 6) NOT NULL,
    `is_default_sale` BOOLEAN NOT NULL DEFAULT false,
    `is_default_purchase` BOOLEAN NOT NULL DEFAULT false,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `item_units_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `item_units_tenant_id_item_id_unit_id_key`(`tenant_id`, `item_id`, `unit_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_barcodes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `item_unit_id` BIGINT UNSIGNED NULL,
    `barcode` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `item_barcodes_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `item_barcodes_tenant_id_barcode_key`(`tenant_id`, `barcode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `branch_id` BIGINT UNSIGNED NULL,
    `code` VARCHAR(50) NOT NULL,
    `name_ar` VARCHAR(191) NOT NULL,
    `name_en` VARCHAR(191) NULL,
    `address` VARCHAR(512) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `updated_by` BIGINT UNSIGNED NULL,

    UNIQUE INDEX `warehouses_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `warehouses_tenant_id_company_id_code_key`(`tenant_id`, `company_id`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_movements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `movement_date` DATE NOT NULL,
    `movement_type` ENUM('IN', 'OUT') NOT NULL,
    `source_type` VARCHAR(50) NOT NULL,
    `source_id` BIGINT UNSIGNED NULL,
    `source_line_id` BIGINT UNSIGNED NULL,
    `qty_in` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `qty_out` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `unit_cost` DECIMAL(18, 3) NOT NULL,
    `total_cost` DECIMAL(18, 3) NOT NULL,
    `balance_qty_after` DECIMAL(18, 6) NOT NULL,
    `avg_cost_after` DECIMAL(18, 6) NOT NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_movements_tenant_id_warehouse_id_item_id_idx`(`tenant_id`, `warehouse_id`, `item_id`),
    INDEX `stock_movements_tenant_id_item_id_movement_date_idx`(`tenant_id`, `item_id`, `movement_date`),
    INDEX `stock_movements_tenant_id_source_type_source_id_idx`(`tenant_id`, `source_type`, `source_id`),
    UNIQUE INDEX `stock_movements_tenant_id_id_key`(`tenant_id`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_balances` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty_on_hand` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `last_movement_date` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stock_balances_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_balances_tenant_id_warehouse_id_item_id_key`(`tenant_id`, `warehouse_id`, `item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `item_costs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `total_qty` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `total_value` DECIMAL(18, 3) NOT NULL DEFAULT 0,
    `avg_cost` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `last_movement_date` DATETIME(3) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `item_costs_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `item_costs_tenant_id_company_id_item_id_key`(`tenant_id`, `company_id`, `item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_adjustments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `adjustment_date` DATE NOT NULL,
    `adjustment_type` ENUM('OPENING', 'IN', 'OUT', 'COUNT_ADJUSTMENT') NOT NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `doc_no` VARCHAR(50) NULL,
    `description` VARCHAR(500) NULL,
    `journal_entry_id` BIGINT UNSIGNED NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `stock_adjustments_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `stock_adjustments_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_adjustments_tenant_id_doc_no_key`(`tenant_id`, `doc_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_adjustment_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `adjustment_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty_in` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `qty_out` DECIMAL(18, 6) NOT NULL DEFAULT 0,
    `unit_cost` DECIMAL(18, 3) NULL,
    `description` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_adjustment_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_adjustment_lines_tenant_id_adjustment_id_line_no_key`(`tenant_id`, `adjustment_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_transfers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `transfer_date` DATE NOT NULL,
    `from_warehouse_id` BIGINT UNSIGNED NOT NULL,
    `to_warehouse_id` BIGINT UNSIGNED NOT NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `doc_no` VARCHAR(50) NULL,
    `description` VARCHAR(500) NULL,
    `reversal_of_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `stock_transfers_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `stock_transfers_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_transfers_tenant_id_doc_no_key`(`tenant_id`, `doc_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_transfer_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `transfer_id` BIGINT UNSIGNED NOT NULL,
    `line_no` INTEGER NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `qty` DECIMAL(18, 6) NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_transfer_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_transfer_lines_tenant_id_transfer_id_line_no_key`(`tenant_id`, `transfer_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_counts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `warehouse_id` BIGINT UNSIGNED NOT NULL,
    `count_date` DATE NOT NULL,
    `status` ENUM('DRAFT', 'POSTED') NOT NULL DEFAULT 'DRAFT',
    `doc_no` VARCHAR(50) NULL,
    `description` VARCHAR(500) NULL,
    `adjustment_id` BIGINT UNSIGNED NULL,
    `posted_at` DATETIME(3) NULL,
    `posted_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `stock_counts_tenant_id_status_idx`(`tenant_id`, `status`),
    UNIQUE INDEX `stock_counts_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_counts_tenant_id_doc_no_key`(`tenant_id`, `doc_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_count_lines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tenant_id` BIGINT UNSIGNED NOT NULL,
    `count_id` BIGINT UNSIGNED NOT NULL,
    `item_id` BIGINT UNSIGNED NOT NULL,
    `system_qty` DECIMAL(18, 6) NOT NULL,
    `counted_qty` DECIMAL(18, 6) NULL,
    `difference_qty` DECIMAL(18, 6) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stock_count_lines_tenant_id_id_key`(`tenant_id`, `id`),
    UNIQUE INDEX `stock_count_lines_tenant_id_count_id_item_id_key`(`tenant_id`, `count_id`, `item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `item_groups` ADD CONSTRAINT `item_groups_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_groups` ADD CONSTRAINT `item_groups_tenant_id_parent_id_fkey` FOREIGN KEY (`tenant_id`, `parent_id`) REFERENCES `item_groups`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_item_group_id_fkey` FOREIGN KEY (`tenant_id`, `item_group_id`) REFERENCES `item_groups`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_base_unit_id_fkey` FOREIGN KEY (`tenant_id`, `base_unit_id`) REFERENCES `units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `items` ADD CONSTRAINT `items_tenant_id_tax_category_id_fkey` FOREIGN KEY (`tenant_id`, `tax_category_id`) REFERENCES `tax_categories`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_units` ADD CONSTRAINT `item_units_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_units` ADD CONSTRAINT `item_units_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_units` ADD CONSTRAINT `item_units_tenant_id_unit_id_fkey` FOREIGN KEY (`tenant_id`, `unit_id`) REFERENCES `units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_barcodes` ADD CONSTRAINT `item_barcodes_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_barcodes` ADD CONSTRAINT `item_barcodes_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_barcodes` ADD CONSTRAINT `item_barcodes_tenant_id_item_unit_id_fkey` FOREIGN KEY (`tenant_id`, `item_unit_id`) REFERENCES `item_units`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouses` ADD CONSTRAINT `warehouses_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouses` ADD CONSTRAINT `warehouses_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouses` ADD CONSTRAINT `warehouses_tenant_id_branch_id_fkey` FOREIGN KEY (`tenant_id`, `branch_id`) REFERENCES `branches`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_movements` ADD CONSTRAINT `stock_movements_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `stock_movements`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_balances` ADD CONSTRAINT `stock_balances_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_costs` ADD CONSTRAINT `item_costs_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_costs` ADD CONSTRAINT `item_costs_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `item_costs` ADD CONSTRAINT `item_costs_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tenant_id_journal_entry_id_fkey` FOREIGN KEY (`tenant_id`, `journal_entry_id`) REFERENCES `journal_entries`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustments` ADD CONSTRAINT `stock_adjustments_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `stock_adjustments`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustment_lines` ADD CONSTRAINT `stock_adjustment_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustment_lines` ADD CONSTRAINT `stock_adjustment_lines_tenant_id_adjustment_id_fkey` FOREIGN KEY (`tenant_id`, `adjustment_id`) REFERENCES `stock_adjustments`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_adjustment_lines` ADD CONSTRAINT `stock_adjustment_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_tenant_id_from_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `from_warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_tenant_id_to_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `to_warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfers` ADD CONSTRAINT `stock_transfers_tenant_id_reversal_of_id_fkey` FOREIGN KEY (`tenant_id`, `reversal_of_id`) REFERENCES `stock_transfers`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_tenant_id_transfer_id_fkey` FOREIGN KEY (`tenant_id`, `transfer_id`) REFERENCES `stock_transfers`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_counts` ADD CONSTRAINT `stock_counts_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_counts` ADD CONSTRAINT `stock_counts_tenant_id_company_id_fkey` FOREIGN KEY (`tenant_id`, `company_id`) REFERENCES `companies`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_counts` ADD CONSTRAINT `stock_counts_tenant_id_warehouse_id_fkey` FOREIGN KEY (`tenant_id`, `warehouse_id`) REFERENCES `warehouses`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_lines` ADD CONSTRAINT `stock_count_lines_tenant_id_fkey` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_lines` ADD CONSTRAINT `stock_count_lines_tenant_id_count_id_fkey` FOREIGN KEY (`tenant_id`, `count_id`) REFERENCES `stock_counts`(`tenant_id`, `id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_lines` ADD CONSTRAINT `stock_count_lines_tenant_id_item_id_fkey` FOREIGN KEY (`tenant_id`, `item_id`) REFERENCES `items`(`tenant_id`, `id`) ON DELETE RESTRICT ON UPDATE CASCADE;
