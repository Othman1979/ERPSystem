import { L, type ReportTable } from '../printing/report-table.js';
import type { ChequesService } from './cheques.service.js';

type Outstanding = Awaited<ReturnType<ChequesService['outstanding']>>;

/** Outstanding cheques → export table (ADR-037 §7), by due date. */
export function chequesTable(data: Outstanding, lang: 'ar' | 'en'): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const status: Record<string, string> = {
    IN_HAND: t('في الصندوق', 'In hand'),
    DEPOSITED: t('مودع للتحصيل', 'Deposited'),
    COLLECTED: t('محصّل', 'Collected'),
    ISSUED: t('صادر', 'Issued'),
    CLEARED: t('مصروف', 'Cleared'),
    RETURNED: t('مرتجع', 'Returned'),
    CANCELLED: t('ملغى', 'Cancelled'),
  };
  const blank = { direction: '', chequeNo: '', bankName: '', dueDate: '', party: '', voucherNo: '', status: '' };
  return {
    title: t('الشيكات القائمة', 'Outstanding cheques'),
    meta: [
      data.filter.dueTo ? `${t('مستحق حتى', 'Due by')}: ${data.filter.dueTo}` : '',
      data.filter.dueFrom ? `${t('مستحق من', 'Due from')}: ${data.filter.dueFrom}` : '',
    ].filter(Boolean),
    fileName: 'cheques',
    orientation: 'landscape',
    columns: [
      { key: 'direction', label: t('النوع', 'Type'), width: 50 },
      { key: 'chequeNo', label: t('رقم الشيك', 'Cheque no.'), width: 70 },
      { key: 'bankName', label: t('البنك', 'Bank') },
      { key: 'dueDate', label: t('الاستحقاق', 'Due date'), width: 65 },
      { key: 'party', label: t('الطرف', 'Party') },
      { key: 'voucherNo', label: t('السند', 'Voucher'), width: 70 },
      { key: 'status', label: t('الحالة', 'Status'), width: 70 },
      { key: 'amount', label: t('المبلغ', 'Amount'), kind: 'amount' },
    ],
    rows: data.items.map((c) => ({
      direction: c.direction === 'INCOMING' ? t('وارد', 'Incoming') : t('صادر', 'Outgoing'),
      chequeNo: c.chequeNo,
      bankName: c.bankName ?? (c.bankAccount ? (lang === 'en' ? c.bankAccount.nameEn ?? c.bankAccount.nameAr : c.bankAccount.nameAr) : ''),
      dueDate: c.dueDate,
      party: lang === 'en' ? c.party.nameEn ?? c.party.nameAr : c.party.nameAr,
      voucherNo: c.voucherNo ?? '',
      status: status[c.status] ?? c.status,
      amount: c.amount,
    })),
    totals: [
      { ...blank, direction: t('مجموع الوارد', 'Incoming total'), amount: data.incomingTotal },
      { ...blank, direction: t('مجموع الصادر', 'Outgoing total'), amount: data.outgoingTotal },
    ],
  };
}
