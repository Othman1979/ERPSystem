-- AlterTable
ALTER TABLE `bom_lines` MODIFY `item_unit_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `boms` MODIFY `output_item_unit_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `production_voucher_lines` MODIFY `item_unit_id` BIGINT UNSIGNED NULL;

-- AlterTable
ALTER TABLE `production_vouchers` MODIFY `item_unit_id` BIGINT UNSIGNED NULL;
