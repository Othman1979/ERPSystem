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
  'CONSIGNMENT_SHRINKAGE',
  'PRODUCTION_APPLIED_COST',
  'CHEQUES_RECEIVABLE',
  'CHEQUES_PAYABLE',
  'PAYROLL_SALARIES_EXPENSE',
  'PAYROLL_SSC_EXPENSE',
  'PAYROLL_PAYABLE',
  'PAYROLL_SSC_PAYABLE',
  'PAYROLL_TAX_PAYABLE',
  'PAYROLL_LEAVE_PROVISION',
  'PAYROLL_LEAVE_EXPENSE',
  'PAYROLL_EOS_PROVISION',
  'PAYROLL_EOS_EXPENSE',
  'EMPLOYEE_ADVANCES',
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
  /** ADR-036 §3: unset = the type's default section. */
  cashFlowActivity?: 'OPERATING' | 'INVESTING' | 'FINANCING';
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
  acct('1106', 'شيكات برسم التحصيل', 'ASSET', { nameEn: 'Cheques under collection', parentCode: '11' }),
  acct('1107', 'سلف الموظفين', 'ASSET', { nameEn: 'Employee advances', parentCode: '11' }),
  acct('1201', 'الأثاث والمعدات', 'ASSET', { nameEn: 'Furniture and equipment', parentCode: '12', cashFlowActivity: 'INVESTING' }),
  acct('1202', 'مجمع الاستهلاك', 'ASSET', { nameEn: 'Accumulated depreciation', normalBalance: 'CREDIT', parentCode: '12' }),
  acct('2101', 'الموردون', 'LIABILITY', { nameEn: 'Suppliers', parentCode: '21', isControl: true, controlType: 'SUPPLIERS' }),
  acct('2102', 'ضريبة المبيعات', 'LIABILITY', { nameEn: 'Output tax', parentCode: '21' }),
  acct('2103', 'مصاريف مستحقة', 'LIABILITY', { nameEn: 'Accrued expenses', parentCode: '21' }),
  acct('2104', 'بضاعة مستلمة غير مفوترة', 'LIABILITY', { nameEn: 'Goods received not invoiced', parentCode: '21' }),
  acct('2105', 'شيكات آجلة الدفع', 'LIABILITY', { nameEn: 'Post-dated cheques payable', parentCode: '21' }),
  acct('2106', 'رواتب مستحقة', 'LIABILITY', { nameEn: 'Salaries payable', parentCode: '21' }),
  acct('2107', 'الضمان الاجتماعي المستحق', 'LIABILITY', { nameEn: 'Social security payable', parentCode: '21' }),
  acct('2108', 'ضريبة دخل مقتطعة', 'LIABILITY', { nameEn: 'Income tax withheld', parentCode: '21' }),
  acct('2109', 'مخصص الإجازات المستحقة', 'LIABILITY', { nameEn: 'Accrued leave provision', parentCode: '21' }),
  acct('2110', 'مخصص مكافأة نهاية الخدمة', 'LIABILITY', { nameEn: 'End-of-service provision', parentCode: '21' }),
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
  // Phase 16 (ADR-031 §8): applied production costs; credited by production vouchers.
  acct('5104', 'تكاليف إنتاج محمّلة', 'EXPENSE', { nameEn: 'Applied production costs', parentCode: '5' }),
  acct('5201', 'الرواتب', 'EXPENSE', { nameEn: 'Salaries', parentCode: '52' }),
  acct('5202', 'الإيجار', 'EXPENSE', { nameEn: 'Rent', parentCode: '52' }),
  acct('5203', 'الكهرباء والمياه والاتصالات', 'EXPENSE', { nameEn: 'Electricity, water and telecom', parentCode: '52' }),
  acct('5204', 'مصاريف عمومية وإدارية', 'EXPENSE', { nameEn: 'General and administrative expenses', parentCode: '52' }),
  acct('5205', 'فروقات التقريب', 'EXPENSE', { nameEn: 'Rounding differences', parentCode: '52' }),
  acct('5206', 'حصة الشركة في الضمان', 'EXPENSE', { nameEn: 'Employer social security', parentCode: '52' }),
  acct('5207', 'مصروف الإجازات', 'EXPENSE', { nameEn: 'Leave expense', parentCode: '52' }),
  acct('5208', 'مصروف مكافأة نهاية الخدمة', 'EXPENSE', { nameEn: 'End-of-service expense', parentCode: '52' }),
  acct('5209', 'عجز بضاعة المورد', 'EXPENSE', { nameEn: 'Supplier goods shortage', parentCode: '52' }),
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
  CONSIGNMENT_SHRINKAGE: '5209',
  PRODUCTION_APPLIED_COST: '5104',
  CHEQUES_RECEIVABLE: '1106',
  CHEQUES_PAYABLE: '2105',
  PAYROLL_SALARIES_EXPENSE: '5201',
  PAYROLL_SSC_EXPENSE: '5206',
  PAYROLL_PAYABLE: '2106',
  PAYROLL_SSC_PAYABLE: '2107',
  PAYROLL_TAX_PAYABLE: '2108',
  PAYROLL_LEAVE_PROVISION: '2109',
  PAYROLL_LEAVE_EXPENSE: '5207',
  PAYROLL_EOS_PROVISION: '2110',
  PAYROLL_EOS_EXPENSE: '5208',
  EMPLOYEE_ADVANCES: '1107',
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
  CONSIGNMENT_SHRINKAGE: { types: ['EXPENSE'] },
  PRODUCTION_APPLIED_COST: { types: ['EXPENSE'] },
  CHEQUES_RECEIVABLE: { types: ['ASSET'] },
  CHEQUES_PAYABLE: { types: ['LIABILITY'] },
  PAYROLL_SALARIES_EXPENSE: { types: ['EXPENSE'] },
  PAYROLL_SSC_EXPENSE: { types: ['EXPENSE'] },
  PAYROLL_PAYABLE: { types: ['LIABILITY'] },
  PAYROLL_SSC_PAYABLE: { types: ['LIABILITY'] },
  PAYROLL_TAX_PAYABLE: { types: ['LIABILITY'] },
  PAYROLL_LEAVE_PROVISION: { types: ['LIABILITY'] },
  PAYROLL_LEAVE_EXPENSE: { types: ['EXPENSE'] },
  PAYROLL_EOS_PROVISION: { types: ['LIABILITY'] },
  PAYROLL_EOS_EXPENSE: { types: ['EXPENSE'] },
  EMPLOYEE_ADVANCES: { types: ['ASSET'] },
};

/** Keys whose account accumulates a balance other documents settle: changing them after posting would split it (LEDGER-05). */
export const LOCKED_AFTER_POSTING: ReadonlySet<AccountMappingKey> = new Set<AccountMappingKey>([
  'CUSTOMERS_CONTROL',
  'SUPPLIERS_CONTROL',
  'INVENTORY',
  'GOODS_RECEIVED_NOT_INVOICED',
  'CHEQUES_RECEIVABLE',
  'CHEQUES_PAYABLE',
  'PAYROLL_PAYABLE',
  'PAYROLL_SSC_PAYABLE',
  'PAYROLL_TAX_PAYABLE',
  'PAYROLL_LEAVE_PROVISION',
  'PAYROLL_EOS_PROVISION',
  'EMPLOYEE_ADVANCES',
]);

export const DEFAULT_PAY_ELEMENTS = [
  {
    code: 'OVERTIME_125',
    nameAr: 'عمل إضافي ١٢٥٪',
    nameEn: 'Overtime 125%',
    kind: 'EARNING',
    amountType: 'PER_HOUR',
    rateFactor: '1.250000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'HOLIDAY_OVERTIME_150',
    nameAr: 'عمل إضافي في العطلات ١٥٠٪',
    nameEn: 'Holiday overtime 150%',
    kind: 'EARNING',
    amountType: 'PER_HOUR',
    rateFactor: '1.500000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'ABSENCE_DAY',
    nameAr: 'غياب يوم',
    nameEn: 'Absence day',
    kind: 'DEDUCTION',
    amountType: 'PER_DAY',
    rateFactor: '1.000000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'TRANSPORT',
    nameAr: 'بدل مواصلات',
    nameEn: 'Transport',
    kind: 'EARNING',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: false,
    taxSubject: true,
    isFixedAllowance: true,
    accountCode: '5201',
  },
  {
    code: 'HOUSING',
    nameAr: 'بدل سكن',
    nameEn: 'Housing',
    kind: 'EARNING',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: true,
    accountCode: '5201',
  },
  {
    code: 'BONUS',
    nameAr: 'مكافأة',
    nameEn: 'Bonus',
    kind: 'EARNING',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'ADVANCE_REPAYMENT',
    nameAr: 'تسديد سلفة',
    nameEn: 'Advance repayment',
    kind: 'DEDUCTION',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: false,
    taxSubject: false,
    isFixedAllowance: false,
    accountCode: '1107',
  },
  {
    code: 'PENALTY',
    nameAr: 'غرامة',
    nameEn: 'Penalty',
    kind: 'DEDUCTION',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: false,
    taxSubject: false,
    isFixedAllowance: false,
    accountCode: '4201',
  },
  {
    code: 'UNPAID_LEAVE_DAY',
    nameAr: 'إجازة بدون أجر',
    nameEn: 'Unpaid leave day',
    kind: 'DEDUCTION',
    amountType: 'PER_DAY',
    rateFactor: '1.000000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'MATERNITY_LEAVE_DAY',
    nameAr: 'إجازة أمومة',
    nameEn: 'Maternity leave day',
    kind: 'DEDUCTION',
    amountType: 'PER_DAY',
    rateFactor: '1.000000',
    sscSubject: true,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5201',
  },
  {
    code: 'LEAVE_ENCASHMENT',
    nameAr: 'بدل إجازات غير مستعملة',
    nameEn: 'Unused leave encashment',
    kind: 'EARNING',
    amountType: 'FIXED',
    rateFactor: '1.000000',
    sscSubject: false,
    taxSubject: true,
    isFixedAllowance: false,
    accountCode: '5207',
  },
] as const;

export const DEFAULT_LEAVE_TYPES = [
  { code: 'ANNUAL', nameAr: 'سنوية', nameEn: 'Annual', category: 'ANNUAL', countBasis: 'WORKING_DAYS' },
  { code: 'SICK', nameAr: 'مرضية', nameEn: 'Sick', category: 'SICK', countBasis: 'WORKING_DAYS', maxDaysPerYear: '14.00', hospitalExtraDays: '14.00' },
  { code: 'MATERNITY', nameAr: 'أمومة', nameEn: 'Maternity', category: 'MATERNITY', countBasis: 'CALENDAR_DAYS', maxDaysPerRequest: '70.00', payElementCode: 'MATERNITY_LEAVE_DAY' },
  { code: 'PATERNITY', nameAr: 'أبوة', nameEn: 'Paternity', category: 'PATERNITY', countBasis: 'WORKING_DAYS', maxDaysPerRequest: '3.00' },
  { code: 'HAJJ', nameAr: 'حج', nameEn: 'Hajj', category: 'HAJJ', countBasis: 'WORKING_DAYS', maxDaysPerRequest: '14.00', oncePerEmployment: true, minServiceYears: 5 },
  { code: 'UNPAID', nameAr: 'بدون أجر', nameEn: 'Unpaid', category: 'UNPAID', countBasis: 'CALENDAR_DAYS', payElementCode: 'UNPAID_LEAVE_DAY' },
] as const;

export const DEFAULT_PAYROLL_TAX_BRACKETS = [
  { seq: 1, upTo: '416.000', rate: '0.050000' },
  { seq: 2, upTo: '832.000', rate: '0.100000' },
  { seq: 3, upTo: '1248.000', rate: '0.150000' },
  { seq: 4, upTo: '1664.000', rate: '0.200000' },
  { seq: 5, upTo: '83333.000', rate: '0.250000' },
  { seq: 6, upTo: null, rate: '0.300000' },
] as const;

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
  YEAR_CLOSING: 'CL',
  STOCK_TRANSFER: 'ST',
  STOCK_ADJUSTMENT: 'SA',
  OPENING_ENTRY: 'OP',
  GOODS_RECEIPT: 'GRN',
  GOODS_ISSUE: 'GIN',
  CONSIGNMENT_IN: 'CIN',
  CONSIGNMENT_OUT: 'COUT',
  RECEIPT: 'RC',
  PAYMENT: 'PY',
  // Phase 12 (ADR-025 §8): numbered at approval (PRQ, PO) or when sent (RFQ). PR is the purchase return.
  PURCHASE_REQUEST: 'PRQ',
  PURCHASE_QUOTE: 'RFQ',
  PURCHASE_ORDER: 'PO',
  // Phase 13 (ADR-026 §9): an issue request, numbered at approval.
  ISSUE_REQUEST: 'IRQ',
  // Phase 14 (ADR-027 §8): a sales quote numbered when sent, a sales order when confirmed.
  SALES_QUOTE: 'SQ',
  SALES_ORDER: 'SO',
  // Phase 16 (ADR-031 §7): a production voucher, numbered at posting.
  PRODUCTION: 'MFG',
  PAYROLL_RUN: 'PAY',
  PAYROLL_MOVEMENT: 'PM',
  LEAVE_REQUEST: 'LV',
  PAYROLL_SETTLEMENT: 'FS',
};
