-- AlterTable
ALTER TABLE `accounts` ADD COLUMN `cash_flow_activity` ENUM('OPERATING', 'INVESTING', 'FINANCING') NULL;
