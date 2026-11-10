import { L, type ReportColumn, type ReportTable } from '../printing/report-table.js';
import { localName, periodMeta } from '../printing/report-meta.js';
import type { TradeSummaryService } from './trade-summary.service.js';

type Lang = 'ar' | 'en';
type TradeSummary = Awaited<ReturnType<TradeSummaryService['sales']>>;

/** Sales / purchases summary JSON → export table; the columns follow `groupBy`. */
export function tradeSummaryTable(data: TradeSummary, lang: Lang, kind: 'sales' | 'purchases'): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const sales = kind === 'sales';
  const byItem = data.groupBy === 'item';
  const keyLabel: Record<TradeSummary['groupBy'], string> = {
    day: t('اليوم', 'Day'),
    month: t('الشهر', 'Month'),
    customer: t('العميل', 'Customer'),
    supplier: t('المورد', 'Supplier'),
    item: t('الصنف', 'Item'),
  };
  const columns: ReportColumn[] = [
    { key: 'group', label: keyLabel[data.groupBy] },
    ...(byItem
      ? [{ key: 'qty', label: t('الكمية', 'Quantity'), kind: 'qty' as const }]
      : [
          { key: 'invoiceCount', label: t('فواتير', 'Invoices'), kind: 'int' as const, width: 44 },
          { key: 'returnCount', label: t('مرتجعات', 'Returns'), kind: 'int' as const, width: 44 },
        ]),
    { key: 'net', label: t('الصافي', 'Net'), kind: 'amount' },
    { key: 'tax', label: t('الضريبة', 'Tax'), kind: 'amount' },
    { key: 'grand', label: t('الإجمالي', 'Total'), kind: 'amount' },
    ...(sales
      ? [
          { key: 'cost', label: t('التكلفة', 'Cost'), kind: 'amount' as const },
          { key: 'margin', label: t('الهامش', 'Margin'), kind: 'amount' as const },
        ]
      : []),
  ];
  const groupName = (r: TradeSummary['rows'][number]) =>
    r.code ? `${r.code} ${localName(lang, r.nameAr ?? '', r.nameEn)}` : r.key;
  return {
    title: sales ? t('ملخص المبيعات', 'Sales summary') : t('ملخص المشتريات', 'Purchases summary'),
    meta: [periodMeta(lang, data.from, data.to), t('الفواتير مطروحاً منها المرتجعات', 'Invoices less returns')],
    fileName: `${kind}-summary-${data.groupBy}-${data.from}-${data.to}`,
    columns,
    rows: data.rows.map((r) => ({ ...r, group: groupName(r) })),
    totals: [{ ...data.totals, group: t('المجموع', 'Total') }],
  };
}
