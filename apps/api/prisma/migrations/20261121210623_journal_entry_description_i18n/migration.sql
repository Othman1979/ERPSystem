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

UPDATE `journal_entries` je
JOIN `sales_invoices` si
  ON si.tenant_id = je.tenant_id
 AND si.id = je.source_id
SET je.description_key = 'journal.auto.salesInvoice',
    je.description_params = JSON_OBJECT('number', si.invoice_no)
WHERE je.source_type = 'SALES_INVOICE'
  AND je.description = CONCAT('Sales invoice ', si.invoice_no);

UPDATE `journal_entries` je
JOIN `sales_returns` sr
  ON sr.tenant_id = je.tenant_id
 AND sr.id = je.source_id
SET je.description_key = 'journal.auto.salesReturn',
    je.description_params = JSON_OBJECT('number', sr.return_no)
WHERE je.source_type = 'SALES_RETURN'
  AND je.description = CONCAT('Sales return ', sr.return_no);

UPDATE `journal_entries` je
JOIN `purchase_invoices` pi
  ON pi.tenant_id = je.tenant_id
 AND pi.id = je.source_id
SET je.description_key = 'journal.auto.purchaseInvoice',
    je.description_params = JSON_OBJECT('number', pi.invoice_no)
WHERE je.source_type = 'PURCHASE_INVOICE'
  AND je.description = CONCAT('Purchase invoice ', pi.invoice_no);

UPDATE `journal_entries` je
JOIN `purchase_returns` pr
  ON pr.tenant_id = je.tenant_id
 AND pr.id = je.source_id
SET je.description_key = 'journal.auto.purchaseReturn',
    je.description_params = JSON_OBJECT('number', pr.return_no)
WHERE je.source_type = 'PURCHASE_RETURN'
  AND je.description = CONCAT('Purchase return ', pr.return_no);

UPDATE `journal_entries` je
JOIN `goods_notes` gn
  ON gn.tenant_id = je.tenant_id
 AND gn.id = je.source_id
SET je.description_key = 'journal.auto.goodsReceipt',
    je.description_params = JSON_OBJECT('number', gn.doc_no)
WHERE je.source_type = 'GOODS_RECEIPT'
  AND je.description = CONCAT('GRN ', gn.doc_no);

UPDATE `journal_entries` je
JOIN `goods_notes` gn
  ON gn.tenant_id = je.tenant_id
 AND gn.id = je.source_id
SET je.description_key = 'journal.auto.goodsIssue',
    je.description_params = JSON_OBJECT('number', gn.doc_no)
WHERE je.source_type = 'GOODS_ISSUE'
  AND je.description = CONCAT('GIN ', gn.doc_no);

UPDATE `journal_entries` je
JOIN `production_vouchers` pv
  ON pv.tenant_id = je.tenant_id
 AND pv.id = je.source_id
SET je.description_key = 'journal.auto.production',
    je.description_params = JSON_OBJECT('number', pv.doc_no)
WHERE je.source_type = 'PRODUCTION'
  AND je.description = CONCAT('Production ', pv.doc_no);

UPDATE `journal_entries` je
JOIN `production_vouchers` reversal
  ON reversal.tenant_id = je.tenant_id
 AND reversal.id = je.source_id
JOIN `production_vouchers` original
  ON original.tenant_id = reversal.tenant_id
 AND original.id = reversal.reversal_of_id
SET je.description_key = 'journal.auto.productionReversal',
    je.description_params = JSON_OBJECT('number', CAST(COALESCE(original.doc_no, original.id) AS CHAR))
WHERE je.source_type = 'PRODUCTION'
  AND je.posting_kind = 'REVERSAL'
  AND je.description = CONCAT('Reversal of production ', COALESCE(original.doc_no, original.id));

UPDATE `journal_entries` je
JOIN `receipts` r
  ON r.tenant_id = je.tenant_id
 AND r.id = je.source_id
SET je.description_key = 'journal.auto.receipt',
    je.description_params = JSON_OBJECT('number', r.receipt_no)
WHERE je.source_type = 'RECEIPT'
  AND je.description = CONCAT('Receipt ', r.receipt_no);

UPDATE `journal_entries` je
JOIN `payments` p
  ON p.tenant_id = je.tenant_id
 AND p.id = je.source_id
SET je.description_key = 'journal.auto.payment',
    je.description_params = JSON_OBJECT('number', p.payment_no)
WHERE je.source_type = 'PAYMENT'
  AND je.description = CONCAT('Payment ', p.payment_no);

UPDATE `journal_entries` je
JOIN `cash_transfers` ct
  ON ct.tenant_id = je.tenant_id
 AND ct.id = je.source_id
SET je.description_key = 'journal.auto.cashTransfer',
    je.description_params = JSON_OBJECT('number', ct.transfer_no)
WHERE je.source_type = 'CASH_TRANSFER'
  AND je.description = CONCAT('Cash transfer ', ct.transfer_no);

UPDATE `journal_entries` je
JOIN `stock_adjustments` sa
  ON sa.tenant_id = je.tenant_id
 AND sa.id = je.source_id
JOIN `stock_counts` sc
  ON sc.tenant_id = sa.tenant_id
 AND sc.adjustment_id = sa.id
SET je.description_key = 'journal.auto.stockCount',
    je.description_params = JSON_OBJECT('number', CAST(sc.id AS CHAR))
WHERE je.source_type = 'STOCK_ADJUSTMENT'
  AND je.description = CONCAT('Stock count ', sc.id);

UPDATE `journal_entries` je
JOIN `stock_adjustments` reversal
  ON reversal.tenant_id = je.tenant_id
 AND reversal.id = je.source_id
JOIN `stock_adjustments` original
  ON original.tenant_id = reversal.tenant_id
 AND original.id = reversal.reversal_of_id
SET je.description_key = 'journal.auto.stockAdjustmentReversal',
    je.description_params = JSON_OBJECT('number', CAST(COALESCE(original.doc_no, original.id) AS CHAR))
WHERE je.source_type = 'STOCK_ADJUSTMENT'
  AND je.posting_kind = 'REVERSAL'
  AND je.description = CONCAT('Reversal of adjustment ', COALESCE(original.doc_no, original.id));

UPDATE `journal_entries` je
JOIN `stock_adjustments` sa
  ON sa.tenant_id = je.tenant_id
 AND sa.id = je.source_id
SET je.description_key = CASE sa.adjustment_type
      WHEN 'OPENING' THEN 'journal.auto.stockAdjustment.opening'
      WHEN 'IN' THEN 'journal.auto.stockAdjustment.in'
      WHEN 'OUT' THEN 'journal.auto.stockAdjustment.out'
      WHEN 'INCREASE' THEN 'journal.auto.stockAdjustment.increase'
      WHEN 'DECREASE' THEN 'journal.auto.stockAdjustment.decrease'
      WHEN 'COUNT_ADJUSTMENT' THEN 'journal.auto.stockAdjustment.count_adjustment'
    END,
    je.description_params = JSON_OBJECT()
WHERE je.source_type = 'STOCK_ADJUSTMENT'
  AND je.description = CONCAT('Stock adjustment ', sa.adjustment_type)
  AND sa.adjustment_type IN ('OPENING', 'IN', 'OUT', 'INCREASE', 'DECREASE', 'COUNT_ADJUSTMENT');

UPDATE `journal_entries`
SET `description` = 'Year closing',
    `description_key` = 'journal.auto.yearClosing',
    `description_params` = JSON_OBJECT()
WHERE `source_type` = 'YEAR_CLOSING'
  AND (`description` = 'Year closing' OR `description` IS NULL);
