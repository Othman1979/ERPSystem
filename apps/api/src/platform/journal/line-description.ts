export const LINE_DESCRIPTIONS: Record<string, { ar: string; en: string }> = {
  'journal.line.creditPurchase': { ar: 'مشتريات آجلة', en: 'Credit purchase' },
  'journal.line.cashPurchase': { ar: 'مشتريات نقدية', en: 'Cash purchase' },
  'journal.line.invoiceVsGoodsReceived': {
    ar: 'فرق الفاتورة عن البضاعة المستلمة',
    en: 'Invoice vs goods received',
  },
  'journal.line.cashSale': { ar: 'مبيعات نقدية', en: 'Cash sale' },
  'journal.line.creditSale': { ar: 'مبيعات آجلة', en: 'Credit sale' },
  'journal.line.cashRefund': { ar: 'مردود نقدي', en: 'Cash refund' },
  'journal.line.creditNote': { ar: 'إشعار دائن', en: 'Credit note' },
  'journal.line.cashRefundFromSupplier': {
    ar: 'استرداد نقدي من المورد',
    en: 'Cash refund from supplier',
  },
  'journal.line.purchaseReturnCreditNote': {
    ar: 'مرتجع مشتريات (إشعار دائن)',
    en: 'Purchase return (credit note)',
  },
  'journal.line.productionOutput': { ar: 'ناتج الإنتاج', en: 'Production output' },
  'journal.line.productionMaterials': { ar: 'مواد الإنتاج', en: 'Production materials' },
  'journal.line.appliedProductionCost': {
    ar: 'تكلفة إنتاج محمّلة',
    en: 'Applied production cost',
  },
  'journal.line.productionMaterialsBack': {
    ar: 'إرجاع مواد الإنتاج',
    en: 'Production materials back',
  },
  'journal.line.appliedProductionCostReversed': {
    ar: 'عكس تكلفة الإنتاج المحمّلة',
    en: 'Applied production cost reversed',
  },
  'journal.line.productionOutputOut': {
    ar: 'إخراج ناتج الإنتاج',
    en: 'Production output out',
  },
  'journal.line.basicSalaries': { ar: 'رواتب أساسية', en: 'Basic salaries' },
  'journal.line.employerSocialSecurity': {
    ar: 'حصة الشركة في الضمان',
    en: 'Employer social security',
  },
  'journal.line.socialSecurityPayable': {
    ar: 'ضمان اجتماعي مستحق',
    en: 'Social security payable',
  },
  'journal.line.incomeTaxWithheld': { ar: 'ضريبة دخل مقتطعة', en: 'Income tax withheld' },
  'journal.line.netSalariesPayable': { ar: 'صافي الرواتب المستحق', en: 'Net salaries payable' },
  'journal.line.leaveProvisionExpense': {
    ar: 'مصروف مخصص الإجازات',
    en: 'Leave provision expense',
  },
  'journal.line.accruedLeaveProvision': {
    ar: 'مخصص إجازات متراكم',
    en: 'Accrued leave provision',
  },
  'journal.line.endOfServiceProvisionExpense': {
    ar: 'مصروف مخصص نهاية الخدمة',
    en: 'End-of-service provision expense',
  },
  'journal.line.endOfServiceProvision': {
    ar: 'مخصص نهاية الخدمة المستحق',
    en: 'End-of-service provision',
  },
  'journal.line.stockRevaluation': {
    ar: 'إعادة تقييم المخزون (ADR-018)',
    en: 'Stock revaluation (ADR-018)',
  },
};

const keysByEnglishDescription = new Map(
  Object.entries(LINE_DESCRIPTIONS).map(([key, { en }]) => [en, key]),
);

export function lineDescription(key: string): string {
  const description = LINE_DESCRIPTIONS[key];
  if (!description) throw new Error(`Unknown journal line description: ${key}`);
  return description.en;
}

export function lineDescriptionKey(text: string | null | undefined): string | null {
  if (text == null) return null;
  return keysByEnglishDescription.get(text) ?? null;
}

export function localizedLineDescription(
  text: string | null | undefined,
  lang: 'ar' | 'en',
): string | null {
  if (text == null) return null;
  const key = lineDescriptionKey(text);
  return key ? LINE_DESCRIPTIONS[key]![lang] : text;
}
