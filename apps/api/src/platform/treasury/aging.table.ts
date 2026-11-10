import { L, type ReportTable } from '../printing/report-table.js';
import { asOfMeta, localName } from '../printing/report-meta.js';
import type { TreasuryReportsService } from './treasury-reports.service.js';

type Aging = Awaited<ReturnType<TreasuryReportsService['aging']>>;

/** Aging JSON → export table: one row per party, the five buckets, unapplied and balance. */
export function agingTable(data: Aging, lang: 'ar' | 'en'): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const customers = data.partyType === 'CUSTOMER';
  return {
    title: customers ? t('أعمار ذمم العملاء', 'Receivables aging') : t('أعمار ذمم الموردين', 'Payables aging'),
    meta: [asOfMeta(lang, data.asOf)],
    fileName: customers ? 'receivables-aging' : 'payables-aging',
    orientation: 'landscape',
    columns: [
      { key: 'code', label: t('الرمز', 'Code'), width: 50 },
      { key: 'name', label: customers ? t('العميل', 'Customer') : t('المورد', 'Supplier') },
      { key: 'notDue', label: t('غير مستحق', 'Not due'), kind: 'amount' },
      { key: 'd1_30', label: t('1–30 يوماً', '1–30 days'), kind: 'amount' },
      { key: 'd31_60', label: t('31–60 يوماً', '31–60 days'), kind: 'amount' },
      { key: 'd61_90', label: t('61–90 يوماً', '61–90 days'), kind: 'amount' },
      { key: 'd90plus', label: t('أكثر من 90', 'Over 90'), kind: 'amount' },
      { key: 'total', label: t('المجموع', 'Total'), kind: 'amount' },
      { key: 'unapplied', label: t('غير مخصص', 'Unapplied'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد', 'Balance'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({ ...r, name: localName(lang, r.nameAr, r.nameEn) })),
    totals: [{ ...data.totals, name: t('المجموع', 'Total') }],
  };
}
