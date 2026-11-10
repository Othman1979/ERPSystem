import { L, type ReportTable } from '../printing/report-table.js';
import { localName, periodMeta } from '../printing/report-meta.js';
import type { TaxSummaryService } from './tax-summary.service.js';

type Lang = 'ar' | 'en';
type TaxSummary = Awaited<ReturnType<TaxSummaryService['taxSummary']>>;

/** Tax summary JSON → export table: output / input base and tax per category and rate, payable. */
export function taxSummaryTable(data: TaxSummary, lang: Lang): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('ملخص ضريبة المبيعات', 'Sales tax summary'),
    meta: [
      periodMeta(lang, data.from, data.to),
      `${t('فرق الدفاتر', 'Ledger difference')}: ${t('المخرجات', 'output')} ${data.ledgerDifference.output}${t('، ', ', ')}${t('المدخلات', 'input')} ${data.ledgerDifference.input}`,
    ],
    fileName: `tax-summary-${data.from}-${data.to}`,
    orientation: 'landscape',
    columns: [
      { key: 'category', label: t('فئة الضريبة', 'Tax category') },
      { key: 'rate', label: t('النسبة', 'Rate'), width: 44 },
      { key: 'einvoiceCode', label: t('الرمز', 'Code'), width: 36 },
      { key: 'outputBase', label: t('مبيعات خاضعة', 'Taxable sales'), kind: 'amount' },
      { key: 'outputTax', label: t('ضريبة المخرجات', 'Output tax'), kind: 'amount' },
      { key: 'inputBase', label: t('مشتريات خاضعة', 'Taxable purchases'), kind: 'amount' },
      { key: 'inputTax', label: t('ضريبة المدخلات', 'Input tax'), kind: 'amount' },
      { key: 'payable', label: t('المستحق', 'Payable'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      category: r.code ? `${r.code} ${localName(lang, r.nameAr ?? '', r.nameEn)}` : t('بلا فئة', 'No category'),
      rate: `${r.rate}%`,
      einvoiceCode: r.einvoiceCode ?? '',
      outputBase: r.outputBase,
      outputTax: r.outputTax,
      inputBase: r.inputBase,
      inputTax: r.inputTax,
      payable: r.payable,
    })),
    totals: [
      {
        category: t('المجموع', 'Total'),
        outputBase: data.totals.outputBase,
        outputTax: data.totals.outputTax,
        inputBase: data.totals.inputBase,
        inputTax: data.totals.inputTax,
        payable: data.totals.payable,
      },
    ],
  };
}
