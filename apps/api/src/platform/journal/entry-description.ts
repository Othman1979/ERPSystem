const templates: Record<string, { ar: string; en: string }> = {
  'journal.auto.payroll': { ar: 'رواتب {{period}}', en: 'Payroll {{period}}' },
  'journal.auto.leaveProvision': {
    ar: 'مخصص الإجازات {{period}}',
    en: 'Leave provision {{period}}',
  },
  'journal.auto.payrollPayment': {
    ar: 'دفعة الرواتب {{period}}',
    en: 'Payroll payment {{period}}',
  },
  'journal.auto.finalSettlement': {
    ar: 'تسوية نهائية {{number}}',
    en: 'Final settlement {{number}}',
  },
  'journal.auto.finalSettlementPayment': {
    ar: 'دفعة التسوية النهائية {{number}}',
    en: 'Final settlement payment {{number}}',
  },
  'journal.auto.chequeCollect': { ar: 'شيك {{number}} — تحصيل', en: 'Cheque {{number}} — collect' },
  'journal.auto.chequeClear': { ar: 'شيك {{number}} — صرف', en: 'Cheque {{number}} — clear' },
  'journal.auto.chequeReturn': { ar: 'شيك {{number}} — إرجاع', en: 'Cheque {{number}} — return' },
  'journal.auto.chequeUndoCollect': {
    ar: 'عكس تحصيل الشيك {{number}}',
    en: 'Undo cheque collection {{number}}',
  },
  'journal.auto.chequeUndoClear': {
    ar: 'عكس صرف الشيك {{number}}',
    en: 'Undo cheque clearance {{number}}',
  },
  'journal.auto.chequeUndoReturn': {
    ar: 'عكس إرجاع الشيك {{number}}',
    en: 'Undo cheque return {{number}}',
  },
  'journal.auto.salesInvoice': { ar: 'فاتورة مبيعات {{number}}', en: 'Sales invoice {{number}}' },
  'journal.auto.salesReturn': { ar: 'مرتجع مبيعات {{number}}', en: 'Sales return {{number}}' },
  'journal.auto.purchaseInvoice': {
    ar: 'فاتورة مشتريات {{number}}',
    en: 'Purchase invoice {{number}}',
  },
  'journal.auto.purchaseReturn': {
    ar: 'مرتجع مشتريات {{number}}',
    en: 'Purchase return {{number}}',
  },
  'journal.auto.goodsReceipt': { ar: 'استلام بضاعة {{number}}', en: 'Goods receipt {{number}}' },
  'journal.auto.goodsIssue': { ar: 'صرف بضاعة {{number}}', en: 'Goods issue {{number}}' },
  'journal.auto.production': { ar: 'إنتاج {{number}}', en: 'Production {{number}}' },
  'journal.auto.productionReversal': {
    ar: 'عكس إنتاج {{number}}',
    en: 'Reversal of production {{number}}',
  },
  'journal.auto.receipt': { ar: 'سند قبض {{number}}', en: 'Receipt {{number}}' },
  'journal.auto.payment': { ar: 'سند صرف {{number}}', en: 'Payment {{number}}' },
  'journal.auto.cashTransfer': { ar: 'تحويل نقدي {{number}}', en: 'Cash transfer {{number}}' },
  'journal.auto.stockCount': {
    ar: 'تسوية جرد {{number}}',
    en: 'Stock count adjustment {{number}}',
  },
  'journal.auto.stockAdjustmentReversal': {
    ar: 'عكس تسوية المخزون {{number}}',
    en: 'Reversal of stock adjustment {{number}}',
  },
  'journal.auto.stockAdjustment.opening': {
    ar: 'تسوية مخزون افتتاحية',
    en: 'Opening stock adjustment',
  },
  'journal.auto.stockAdjustment.in': { ar: 'إدخال مخزون', en: 'Stock increase' },
  'journal.auto.stockAdjustment.out': { ar: 'إخراج مخزون', en: 'Stock decrease' },
  'journal.auto.stockAdjustment.count_adjustment': {
    ar: 'تسوية جرد مخزون',
    en: 'Stock count adjustment',
  },
  'journal.auto.yearClosing': { ar: 'إقفال السنة', en: 'Year closing' },
};

export function journalEntryDescription(
  lang: 'ar' | 'en',
  row: { description?: string | null; descriptionKey?: string | null; descriptionParams?: unknown },
): string {
  if (!row.descriptionKey) return row.description ?? '';
  const template = templates[row.descriptionKey];
  if (!template) return row.description ?? '';
  const params =
    row.descriptionParams &&
    typeof row.descriptionParams === 'object' &&
    !Array.isArray(row.descriptionParams)
      ? (row.descriptionParams as Record<string, unknown>)
      : {};
  return template[lang].replace(/\{\{(\w+)\}\}/g, (_match, key: string) =>
    String(params[key] ?? ''),
  );
}
