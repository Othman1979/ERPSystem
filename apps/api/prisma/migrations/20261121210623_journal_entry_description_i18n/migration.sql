-- AlterTable
ALTER TABLE `journal_entries` ADD COLUMN `description_key` VARCHAR(100) NULL,
    ADD COLUMN `description_params` JSON NULL;

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.payroll',
    `description_params` = JSON_OBJECT('period', SUBSTRING(`description`, 9))
WHERE `source_type` = 'PAYROLL_RUN'
  AND LEFT(`description`, 8) = 'Payroll ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.leaveProvision',
    `description_params` = JSON_OBJECT('period', SUBSTRING(`description`, 17))
WHERE `source_type` = 'PAYROLL_LEAVE_PROVISION'
  AND LEFT(`description`, 16) = 'Leave provision ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.payrollPayment',
    `description_params` = JSON_OBJECT('period', SUBSTRING(`description`, 17))
WHERE `source_type` = 'PAYROLL_PAYMENT'
  AND LEFT(`description`, 16) = 'Payroll payment ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.finalSettlementPayment',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 26))
WHERE `source_type` = 'PAYROLL_SETTLEMENT_PAYMENT'
  AND LEFT(`description`, 25) = 'Final settlement payment ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.finalSettlement',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 18))
WHERE `source_type` = 'PAYROLL_SETTLEMENT'
  AND LEFT(`description`, 17) = 'Final settlement ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeCollect',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 8, CHAR_LENGTH(`description`) - 15))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND RIGHT(`description`, 8) = ' collect';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeClear',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 8, CHAR_LENGTH(`description`) - 13))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND RIGHT(`description`, 6) = ' clear';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeReturn',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 8, CHAR_LENGTH(`description`) - 14))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND RIGHT(`description`, 7) = ' return';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeUndoCollect',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 13, CHAR_LENGTH(`description`) - 20))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND `posting_kind` = 'REVERSAL'
  AND LEFT(`description`, 12) = 'Undo cheque '
  AND RIGHT(`description`, 8) = ' collect';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeUndoClear',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 13, CHAR_LENGTH(`description`) - 18))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND `posting_kind` = 'REVERSAL'
  AND LEFT(`description`, 12) = 'Undo cheque '
  AND RIGHT(`description`, 6) = ' clear';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.chequeUndoReturn',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 13, CHAR_LENGTH(`description`) - 19))
WHERE `source_type` = 'CHEQUE_EVENT'
  AND `posting_kind` = 'REVERSAL'
  AND LEFT(`description`, 12) = 'Undo cheque '
  AND RIGHT(`description`, 7) = ' return';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.salesInvoice',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 15))
WHERE `source_type` = 'SALES_INVOICE'
  AND LEFT(`description`, 14) = 'Sales invoice ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.salesReturn',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 14))
WHERE `source_type` = 'SALES_RETURN'
  AND LEFT(`description`, 13) = 'Sales return ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.purchaseInvoice',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 18))
WHERE `source_type` = 'PURCHASE_INVOICE'
  AND LEFT(`description`, 17) = 'Purchase invoice ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.purchaseReturn',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 17))
WHERE `source_type` = 'PURCHASE_RETURN'
  AND LEFT(`description`, 16) = 'Purchase return ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.goodsReceipt',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 5))
WHERE `source_type` = 'GOODS_RECEIPT'
  AND LEFT(`description`, 4) = 'GRN ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.goodsIssue',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 5))
WHERE `source_type` = 'GOODS_ISSUE'
  AND LEFT(`description`, 4) = 'GIN ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.production',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 12))
WHERE `source_type` = 'PRODUCTION'
  AND LEFT(`description`, 11) = 'Production ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.productionReversal',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 24))
WHERE `source_type` = 'PRODUCTION'
  AND LEFT(`description`, 23) = 'Reversal of production ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.receipt',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 9))
WHERE `source_type` = 'RECEIPT'
  AND LEFT(`description`, 8) = 'Receipt ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.payment',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 9))
WHERE `source_type` = 'PAYMENT'
  AND LEFT(`description`, 8) = 'Payment ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.cashTransfer',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 15))
WHERE `source_type` = 'CASH_TRANSFER'
  AND LEFT(`description`, 14) = 'Cash transfer ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.stockCount',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 13))
WHERE `source_type` = 'STOCK_ADJUSTMENT'
  AND LEFT(`description`, 12) = 'Stock count ';

UPDATE `journal_entries`
SET `description_key` = 'journal.auto.stockAdjustmentReversal',
    `description_params` = JSON_OBJECT('number', SUBSTRING(`description`, 24))
WHERE `source_type` = 'STOCK_ADJUSTMENT'
  AND LEFT(`description`, 23) = 'Reversal of adjustment ';

UPDATE `journal_entries`
SET `description_key` = CASE SUBSTRING(`description`, 18)
      WHEN 'OPENING' THEN 'journal.auto.stockAdjustment.opening'
      WHEN 'IN' THEN 'journal.auto.stockAdjustment.in'
      WHEN 'OUT' THEN 'journal.auto.stockAdjustment.out'
      WHEN 'INCREASE' THEN 'journal.auto.stockAdjustment.increase'
      WHEN 'DECREASE' THEN 'journal.auto.stockAdjustment.decrease'
      WHEN 'COUNT_ADJUSTMENT' THEN 'journal.auto.stockAdjustment.count_adjustment'
    END,
    `description_params` = JSON_OBJECT()
WHERE `source_type` = 'STOCK_ADJUSTMENT'
  AND LEFT(`description`, 17) = 'Stock adjustment '
  AND SUBSTRING(`description`, 18) IN ('OPENING', 'IN', 'OUT', 'INCREASE', 'DECREASE', 'COUNT_ADJUSTMENT');

UPDATE `journal_entries`
SET `description` = 'Year closing',
    `description_key` = 'journal.auto.yearClosing',
    `description_params` = JSON_OBJECT()
WHERE `source_type` = 'YEAR_CLOSING'
  AND (`description` = 'Year closing' OR `description` IS NULL);
