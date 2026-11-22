import { L, type ReportTable } from '../printing/report-table.js';
import { journalEntryDescription } from '../journal/entry-description.js';
import { localizedLineDescription } from '../journal/line-description.js';
import type { BankReconciliationService } from './bank-reconciliation.service.js';

type Detail = Awaited<ReturnType<BankReconciliationService['detail']>>;

/** Reconciliation JSON → export table (ADR-035 §9): the outstanding items, then the balances. */
export function bankReconciliationTable(data: Detail, lang: 'ar' | 'en'): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const item = (kind: string) => (line: Detail['outstandingDeposits'][number]) => ({
    kind,
    date: line.entryDate,
    entryNo: line.entryNo ?? '',
    reference: line.reference ?? '',
    description: line.descriptionKey?.startsWith('journal.line.')
      ? localizedLineDescription(line.description, lang) ?? ''
      : line.descriptionKey
        ? journalEntryDescription(lang, line)
        : localizedLineDescription(line.description, lang) ?? '',
    amount: line.amount,
  });
  const balance = (kind: string, amount: string) => ({ kind, date: '', entryNo: '', reference: '', description: '', amount });
  return {
    title: t('تقرير التسوية البنكية', 'Bank reconciliation'),
    meta: [
      `${t('البنك', 'Bank')}: ${data.bankName}`,
      `${t('الفترة', 'Period')}: ${data.startDate} – ${data.endDate}`,
      `${t('الحالة', 'Status')}: ${data.status === 'RECONCILED' ? t('مسوّى', 'Reconciled') : t('مسودة', 'Draft')}`,
    ],
    fileName: `bank-reconciliation-${data.id}`,
    orientation: 'portrait',
    columns: [
      { key: 'kind', label: t('البند', 'Item') },
      { key: 'date', label: t('التاريخ', 'Date'), width: 60 },
      { key: 'entryNo', label: t('القيد', 'Entry'), width: 60 },
      { key: 'reference', label: t('المرجع', 'Reference'), width: 60 },
      { key: 'description', label: t('البيان', 'Description') },
      { key: 'amount', label: t('المبلغ', 'Amount'), kind: 'amount' },
    ],
    rows: [
      ...data.outstandingDeposits.map(item(t('إيداع معلق', 'Deposit in transit'))),
      ...data.outstandingPayments.map(item(t('دفعة معلقة', 'Outstanding payment'))),
    ],
    totals: [
      balance(t('الرصيد الافتتاحي للكشف', 'Statement opening balance'), data.openingBalance),
      balance(t('رصيد الدفاتر', 'Book balance'), data.summary.bookBalance),
      balance(t('الإيداعات المعلقة', 'Deposits in transit'), data.summary.outstandingDeposits),
      balance(t('المدفوعات المعلقة', 'Outstanding payments'), data.summary.outstandingPayments),
      balance(t('رصيد الدفاتر المعدّل', 'Adjusted book balance'), data.summary.adjustedBookBalance),
      balance(t('الرصيد الختامي للكشف', 'Statement closing balance'), data.closingBalance),
      balance(t('الفرق', 'Difference'), data.summary.difference),
    ],
  };
}
