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
  acct('1', 'الأصول', 'ASSET', { nameEn: 'Assets', isPostable: false }),
  acct('2', 'الخصوم', 'LIABILITY', { nameEn: 'Liabilities', isPostable: false }),
  acct('3', 'حقوق الملكية', 'EQUITY', { nameEn: 'Equity', isPostable: false }),
  acct('4', 'الإيرادات', 'REVENUE', { nameEn: 'Revenue', isPostable: false }),
  acct('5', 'المصروفات', 'EXPENSE', { nameEn: 'Expenses', isPostable: false }),
  // Level 2 — groups (non-postable)
  acct('11', 'الأصول المتداولة', 'ASSET', { nameEn: 'Current assets', parentCode: '1', isPostable: false }),
  acct('12', 'الأصول الثابتة', 'ASSET', { nameEn: 'Fixed assets', parentCode: '1', isPostable: false }),
  acct('21', 'الخصوم المتداولة', 'LIABILITY', { nameEn: 'Current liabilities', parentCode: '2', isPostable: false }),
  acct('31', 'حقوق الملكية', 'EQUITY', { nameEn: 'Equity', parentCode: '3', isPostable: false }),
  acct('42', 'إيرادات أخرى', 'REVENUE', { nameEn: 'Other revenue', parentCode: '4', isPostable: false }),
  acct('52', 'مصروفات أخرى', 'EXPENSE', { nameEn: 'Other expenses', parentCode: '5', isPostable: false }),
  // Level 3 — postable accounts. 1202, 4102 and 4103 are contra accounts with
  // the nature opposite to their type (§8.7, LEDGER-26).
  acct('1101', 'الصندوق', 'ASSET', { nameEn: 'Cash', parentCode: '11', controlType: 'CASH' }),
  acct('1102', 'البنوك', 'ASSET', { nameEn: 'Banks', parentCode: '11', controlType: 'BANK' }),
  acct('1103', 'العملاء', 'ASSET', { nameEn: 'Customers', parentCode: '11', isControl: true, controlType: 'CUSTOMERS' }),
  acct('1104', 'المخزون', 'ASSET', { nameEn: 'Inventory', parentCode: '11' }),
  acct('1105', 'ضريبة المشتريات', 'ASSET', { nameEn: 'Input tax', parentCode: '11' }),
  acct('1201', 'الأثاث والمعدات', 'ASSET', { nameEn: 'Furniture and equipment', parentCode: '12' }),
  acct('1202', 'مجمع الاستهلاك', 'ASSET', { nameEn: 'Accumulated depreciation', normalBalance: 'CREDIT', parentCode: '12' }),
  acct('2101', 'الموردون', 'LIABILITY', { nameEn: 'Suppliers', parentCode: '21', isControl: true, controlType: 'SUPPLIERS' }),
  acct('2102', 'ضريبة المبيعات', 'LIABILITY', { nameEn: 'Output tax', parentCode: '21' }),
  acct('2103', 'مصاريف مستحقة', 'LIABILITY', { nameEn: 'Accrued expenses', parentCode: '21' }),
  acct('2104', 'بضاعة مستلمة غير مفوترة', 'LIABILITY', { nameEn: 'Goods received not invoiced', parentCode: '21' }),
  acct('3101', 'رأس المال', 'EQUITY', { nameEn: 'Capital', parentCode: '31' }),
  acct('3102', 'الأرباح المدورة', 'EQUITY', { nameEn: 'Retained earnings', parentCode: '31' }),
  acct('3103', 'أرصدة افتتاحية', 'EQUITY', { nameEn: 'Opening balances', parentCode: '31' }),
  acct('4101', 'المبيعات', 'REVENUE', { nameEn: 'Sales', parentCode: '4' }),
  acct('4102', 'مردودات المبيعات', 'REVENUE', { nameEn: 'Sales returns', normalBalance: 'DEBIT', parentCode: '4' }),
  acct('4103', 'خصم المبيعات', 'REVENUE', { nameEn: 'Sales discounts', normalBalance: 'DEBIT', parentCode: '4' }),
  acct('4201', 'إيرادات أخرى', 'REVENUE', { nameEn: 'Other revenue', parentCode: '42' }),
  acct('5101', 'تكلفة البضاعة المباعة', 'EXPENSE', { nameEn: 'Cost of goods sold', parentCode: '5' }),
  acct('5102', 'فروقات الجرد والتسويات', 'EXPENSE', { nameEn: 'Stock count differences and adjustments', parentCode: '5' }),
  acct('5103', 'مشتريات', 'EXPENSE', { nameEn: 'Purchases', parentCode: '5' }),
  acct('5201', 'الرواتب', 'EXPENSE', { nameEn: 'Salaries', parentCode: '52' }),
  acct('5202', 'الإيجار', 'EXPENSE', { nameEn: 'Rent', parentCode: '52' }),
  acct('5203', 'الكهرباء والمياه والاتصالات', 'EXPENSE', { nameEn: 'Electricity, water and telecom', parentCode: '52' }),
  acct('5204', 'مصاريف عمومية وإدارية', 'EXPENSE', { nameEn: 'General and administrative expenses', parentCode: '52' }),
  acct('5205', 'فروقات التقريب', 'EXPENSE', { nameEn: 'Rounding differences', parentCode: '52' }),
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

/**
 * What each account_mappings key may point to (LEDGER-05). Control keys need
 * the matching control type; every other key refuses control and cash/bank
 * accounts. Natures are not checked: contra accounts and older charts vary.
 */
export interface MappingRule {
  types: readonly ('ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE')[];
  controlType?: 'CUSTOMERS' | 'SUPPLIERS';
}

export const MAPPING_RULES: Record<AccountMappingKey, MappingRule> = {
  SALES: { types: ['REVENUE'] },
  SALES_RETURNS: { types: ['REVENUE'] },
  SALES_DISCOUNTS: { types: ['REVENUE'] },
  INVENTORY: { types: ['ASSET'] },
  COGS: { types: ['EXPENSE'] },
  INVENTORY_ADJUSTMENT: { types: ['EXPENSE', 'REVENUE'] },
  OUTPUT_TAX: { types: ['LIABILITY'] },
  INPUT_TAX: { types: ['ASSET', 'LIABILITY'] },
  CUSTOMERS_CONTROL: { types: ['ASSET'], controlType: 'CUSTOMERS' },
  SUPPLIERS_CONTROL: { types: ['LIABILITY'], controlType: 'SUPPLIERS' },
  ROUNDING: { types: ['EXPENSE', 'REVENUE'] },
  OPENING_BALANCE_EQUITY: { types: ['EQUITY'] },
  RETAINED_EARNINGS: { types: ['EQUITY'] },
  PURCHASES: { types: ['EXPENSE'] },
  GOODS_RECEIVED_NOT_INVOICED: { types: ['LIABILITY'] },
};

/** Keys whose account accumulates a balance other documents settle: changing them after posting would split it (LEDGER-05). */
export const LOCKED_AFTER_POSTING: ReadonlySet<AccountMappingKey> = new Set<AccountMappingKey>([
  'CUSTOMERS_CONTROL',
  'SUPPLIERS_CONTROL',
  'INVENTORY',
  'GOODS_RECEIVED_NOT_INVOICED',
]);

export const DEFAULT_UNITS = [
  { code: 'PCS', nameAr: 'قطعة', nameEn: 'Piece', unEceCode: 'PCE' },
  { code: 'BOX', nameAr: 'صندوق', nameEn: 'Box', unEceCode: 'BX' },
  { code: 'DOZEN', nameAr: 'دستة', nameEn: 'Dozen', unEceCode: 'DOZ' },
  { code: 'KG', nameAr: 'كيلوغرام', nameEn: 'Kilogram', unEceCode: 'KGM' },
  { code: 'G', nameAr: 'غرام', nameEn: 'Gram', unEceCode: 'GRM' },
  { code: 'L', nameAr: 'لتر', nameEn: 'Liter', unEceCode: 'LTR' },
  { code: 'M', nameAr: 'متر', nameEn: 'Meter', unEceCode: 'MTR' },
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
