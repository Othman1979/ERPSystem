/**
 * Default chart of accounts template (docs/BUILD_PLAN.md §8.7) and the
 * mandatory account_mappings keys (§7.2). Reviewed by an accountant before
 * production use — tenants can edit the tree after provisioning.
 */

export const ACCOUNT_MAPPING_KEYS = [
  'SALES',
  'SALES_RETURNS',
  'SALES_DISCOUNTS',
  'INVENTORY',
  'COGS',
  'INVENTORY_ADJUSTMENT',
  'OUTPUT_TAX',
  'INPUT_TAX',
  'CUSTOMERS_CONTROL',
  'SUPPLIERS_CONTROL',
  'ROUNDING',
  'OPENING_BALANCE_EQUITY',
  'RETAINED_EARNINGS',
  'PURCHASES',
  'GOODS_RECEIVED_NOT_INVOICED',
] as const;

export type AccountMappingKey = (typeof ACCOUNT_MAPPING_KEYS)[number];

export interface TemplateAccount {
  code: string;
  nameAr: string;
  nameEn?: string;
  parentCode?: string;
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normalBalance: 'DEBIT' | 'CREDIT';
  isPostable: boolean;
  isControl?: boolean;
  controlType?: 'CUSTOMERS' | 'SUPPLIERS' | 'CASH' | 'BANK';
}

const DEBIT_TYPES = new Set(['ASSET', 'EXPENSE']);

function acct(
  code: string,
  nameAr: string,
  accountType: TemplateAccount['accountType'],
  opts: Partial<TemplateAccount> = {},
): TemplateAccount {
  return {
    code,
    nameAr,
    accountType,
    normalBalance: DEBIT_TYPES.has(accountType) ? 'DEBIT' : 'CREDIT',
    isPostable: true,
    ...opts,
  };
}

export const CHART_TEMPLATE: TemplateAccount[] = [
  // Level 1 — roots (non-postable)
  acct('1', 'الأصول', 'ASSET', { isPostable: false }),
  acct('2', 'الخصوم', 'LIABILITY', { isPostable: false }),
  acct('3', 'حقوق الملكية', 'EQUITY', { isPostable: false }),
  acct('4', 'الإيرادات', 'REVENUE', { isPostable: false }),
  acct('5', 'المصروفات', 'EXPENSE', { isPostable: false }),
  // Level 2 — groups (non-postable)
  acct('11', 'الأصول المتداولة', 'ASSET', { parentCode: '1', isPostable: false }),
  acct('12', 'الأصول الثابتة', 'ASSET', { parentCode: '1', isPostable: false }),
  acct('21', 'الخصوم المتداولة', 'LIABILITY', { parentCode: '2', isPostable: false }),
  acct('31', 'حقوق الملكية', 'EQUITY', { parentCode: '3', isPostable: false }),
  acct('42', 'إيرادات أخرى', 'REVENUE', { parentCode: '4', isPostable: false }),
  acct('52', 'مصروفات أخرى', 'EXPENSE', { parentCode: '5', isPostable: false }),
  // Level 3 — postable accounts
  acct('1101', 'الصندوق', 'ASSET', { parentCode: '11', controlType: 'CASH' }),
  acct('1102', 'البنوك', 'ASSET', { parentCode: '11', controlType: 'BANK' }),
  acct('1103', 'العملاء', 'ASSET', { parentCode: '11', isControl: true, controlType: 'CUSTOMERS' }),
  acct('1104', 'المخزون', 'ASSET', { parentCode: '11' }),
  acct('1105', 'ضريبة المشتريات', 'ASSET', { parentCode: '11' }),
  acct('1201', 'الأثاث والمعدات', 'ASSET', { parentCode: '12' }),
  acct('1202', 'مجمع الاستهلاك', 'ASSET', { parentCode: '12' }),
  acct('2101', 'الموردون', 'LIABILITY', { parentCode: '21', isControl: true, controlType: 'SUPPLIERS' }),
  acct('2102', 'ضريبة المبيعات', 'LIABILITY', { parentCode: '21' }),
  acct('2103', 'مصاريف مستحقة', 'LIABILITY', { parentCode: '21' }),
  acct('2104', 'بضاعة مستلمة غير مفوترة', 'LIABILITY', { parentCode: '21' }),
  acct('3101', 'رأس المال', 'EQUITY', { parentCode: '31' }),
  acct('3102', 'الأرباح المدورة', 'EQUITY', { parentCode: '31' }),
  acct('3103', 'أرصدة افتتاحية', 'EQUITY', { parentCode: '31' }),
  acct('4101', 'المبيعات', 'REVENUE', { parentCode: '4' }),
  acct('4102', 'مردودات المبيعات', 'REVENUE', { parentCode: '4' }),
  acct('4103', 'خصم المبيعات', 'REVENUE', { parentCode: '4' }),
  acct('4201', 'إيرادات أخرى', 'REVENUE', { parentCode: '42' }),
  acct('5101', 'تكلفة البضاعة المباعة', 'EXPENSE', { parentCode: '5' }),
  acct('5102', 'فروقات الجرد والتسويات', 'EXPENSE', { parentCode: '5' }),
  acct('5103', 'مشتريات', 'EXPENSE', { parentCode: '5' }),
  acct('5201', 'الرواتب', 'EXPENSE', { parentCode: '52' }),
  acct('5202', 'الإيجار', 'EXPENSE', { parentCode: '52' }),
  acct('5203', 'الكهرباء والمياه والاتصالات', 'EXPENSE', { parentCode: '52' }),
  acct('5204', 'مصاريف عمومية وإدارية', 'EXPENSE', { parentCode: '52' }),
  acct('5205', 'فروقات التقريب', 'EXPENSE', { parentCode: '52' }),
];

/** mappingKey → template account code (resolved to account ids on provision). */
export const TEMPLATE_MAPPINGS: Record<AccountMappingKey, string> = {
  SALES: '4101',
  SALES_RETURNS: '4102',
  SALES_DISCOUNTS: '4103',
  INVENTORY: '1104',
  COGS: '5101',
  INVENTORY_ADJUSTMENT: '5102',
  OUTPUT_TAX: '2102',
  INPUT_TAX: '1105',
  CUSTOMERS_CONTROL: '1103',
  SUPPLIERS_CONTROL: '2101',
  ROUNDING: '5205',
  OPENING_BALANCE_EQUITY: '3103',
  RETAINED_EARNINGS: '3102',
  PURCHASES: '5103',
  GOODS_RECEIVED_NOT_INVOICED: '2104',
};

export const DEFAULT_UNITS = [
  { code: 'PCS', nameAr: 'قطعة', nameEn: 'Piece' },
  { code: 'BOX', nameAr: 'صندوق', nameEn: 'Box' },
  { code: 'DOZEN', nameAr: 'دستة', nameEn: 'Dozen' },
  { code: 'KG', nameAr: 'كيلوغرام', nameEn: 'Kilogram' },
  { code: 'G', nameAr: 'غرام', nameEn: 'Gram' },
  { code: 'L', nameAr: 'لتر', nameEn: 'Liter' },
  { code: 'M', nameAr: 'متر', nameEn: 'Meter' },
];

export const DEFAULT_TAX_CATEGORIES = [
  { code: 'STANDARD', nameAr: 'ضريبة عامة', nameEn: 'Standard', rate: '16.0000', isDefault: true },
  { code: 'ZERO', nameAr: 'معفى / صفرية', nameEn: 'Zero-rated', rate: '0.0000' },
];

export const DEFAULT_PAYMENT_METHODS = [
  { code: 'CASH', nameAr: 'نقداً', nameEn: 'Cash' },
  { code: 'BANK', nameAr: 'تحويل بنكي', nameEn: 'Bank transfer' },
  { code: 'CHEQUE', nameAr: 'شيك', nameEn: 'Cheque' },
  { code: 'CARD', nameAr: 'بطاقة', nameEn: 'Card' },
];

/** document_type → default prefix (docs/BUILD_PLAN.md §11). */
export const DOCUMENT_TYPE_PREFIXES: Record<string, string> = {
  SALES_INVOICE: 'SI',
  SALES_RETURN: 'SR',
  PURCHASE_INVOICE: 'PI',
  PURCHASE_RETURN: 'PR',
  RECEIPT_VOUCHER: 'RV',
  PAYMENT_VOUCHER: 'PV',
  CASH_TRANSFER: 'CT',
  JOURNAL_ENTRY: 'JV',
  STOCK_TRANSFER: 'ST',
  STOCK_ADJUSTMENT: 'SA',
  OPENING_ENTRY: 'OP',
  GOODS_RECEIPT: 'GRN',
  GOODS_ISSUE: 'GIN',
  RECEIPT: 'RC',
  PAYMENT: 'PY',
};
