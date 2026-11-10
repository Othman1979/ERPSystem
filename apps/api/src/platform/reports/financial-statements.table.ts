import { Decimal } from '../../common/decimal/decimal.utils.js';
import { L, type ReportRow, type ReportTable } from '../printing/report-table.js';
import { asOfMeta, localName, periodMeta } from '../printing/report-meta.js';
import type { FinancialStatementsService } from './financial-statements.service.js';
import type { StatementRow } from './statements.js';

type Lang = 'ar' | 'en';
type IncomeStatement = Awaited<ReturnType<FinancialStatementsService['incomeStatement']>>;
type BalanceSheet = Awaited<ReturnType<FinancialStatementsService['balanceSheet']>>;

const columns = (lang: Lang) => [
  { key: 'account', label: L({ lang }, 'الحساب', 'Account') },
  { key: 'amount', label: L({ lang }, 'المبلغ', 'Amount'), kind: 'amount' as const, width: 90 },
];

const accountRows = (lang: Lang, rows: StatementRow[], indent = 1): ReportRow[] =>
  rows.map((r) => ({
    account: `${r.code} ${localName(lang, r.nameAr, r.nameEn)}`,
    amount: r.amount,
    _indent: r.depth + indent,
    _bold: r.isGroup,
  }));

const heading = (account: string): ReportRow => ({ account, _bold: true });
const subtotal = (account: string, amount: string): ReportRow => ({ account, amount, _bold: true });

/** Income statement JSON → export table: revenue tree, cost of sales, gross profit, expense tree, net. */
export function incomeStatementTable(data: IncomeStatement, lang: Lang): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('قائمة الدخل', 'Income statement'),
    meta: [periodMeta(lang, data.from, data.to)],
    fileName: `income-statement-${data.from}-${data.to}`,
    columns: columns(lang),
    rows: [
      heading(t('الإيرادات', 'Revenue')),
      ...accountRows(lang, data.revenue.rows),
      subtotal(t('صافي الإيرادات', 'Net revenue'), data.revenue.total),
      heading(t('تكلفة المبيعات', 'Cost of sales')),
      ...data.costOfSales.rows.map((r) => ({
        account: `${r.code} ${localName(lang, r.nameAr, r.nameEn)}`,
        amount: r.amount,
        _indent: 1,
      })),
      subtotal(t('إجمالي تكلفة المبيعات', 'Total cost of sales'), data.costOfSales.total),
      subtotal(t('مجمل الربح', 'Gross profit'), data.grossProfit),
      heading(t('المصروفات', 'Expenses')),
      ...accountRows(lang, data.expenses.rows),
      subtotal(t('إجمالي المصروفات', 'Total expenses'), data.expenses.total),
    ],
    totals: [{ account: t('صافي الربح (الخسارة)', 'Net profit (loss)'), amount: data.netProfit }],
  };
}

/** Balance sheet JSON → export table: assets, liabilities, equity with the unclosed profits. */
export function balanceSheetTable(data: BalanceSheet, lang: Lang): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const equityWithProfit = new Decimal(data.equity.total).plus(data.priorYears).plus(data.yearProfit).toFixed(3);
  return {
    title: t('الميزانية العمومية', 'Balance sheet'),
    meta: [
      asOfMeta(lang, data.asOf),
      `${t('بداية السنة المالية', 'Fiscal year start')}: ${data.yearStart}`,
      ...(data.balanced ? [] : [`${t('غير متوازنة، الفرق', 'Not balanced, difference')}: ${data.difference}`]),
    ],
    fileName: `balance-sheet-${data.asOf}`,
    columns: columns(lang),
    rows: [
      heading(t('الأصول', 'Assets')),
      ...accountRows(lang, data.assets.rows),
      subtotal(t('مجموع الأصول', 'Total assets'), data.assets.total),
      heading(t('الخصوم', 'Liabilities')),
      ...accountRows(lang, data.liabilities.rows),
      subtotal(t('مجموع الخصوم', 'Total liabilities'), data.liabilities.total),
      heading(t('حقوق الملكية', 'Equity')),
      ...accountRows(lang, data.equity.rows),
      { account: t('أرباح سنوات سابقة غير مقفلة', 'Prior years profit (not closed)'), amount: data.priorYears, _indent: 1 },
      { account: t('ربح السنة الحالية', 'Current year profit'), amount: data.yearProfit, _indent: 1 },
      subtotal(t('مجموع حقوق الملكية', 'Total equity'), equityWithProfit),
    ],
    totals: [{ account: t('مجموع الخصوم وحقوق الملكية', 'Total liabilities and equity'), amount: data.totalLiabilitiesAndEquity }],
  };
}
