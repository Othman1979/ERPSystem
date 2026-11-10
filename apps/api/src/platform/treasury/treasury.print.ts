import type { DocumentPrint } from '../printing/document-pdf.js';

type Lang = 'ar' | 'en';
type Dec = { toString(): string };
const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

interface VoucherLike {
  amount: Dec;
  partyType: 'CUSTOMER' | 'SUPPLIER' | null;
  party: { code: string; nameAr: string; nameEn: string | null } | null;
  cashAccount: { code: string; nameAr: string } | null;
  expenseAccount?: { code: string; nameAr: string } | null;
  paymentMethod: { nameAr: string } | null;
  referenceNo: string | null;
  description: string | null;
  reversedAt: Date | null;
  allocations: { amount: Dec; cancelledAt: Date | null; documentType: string; invoiceNo?: string | null }[];
  allocatedAmount: string;
  unallocatedAmount: string;
}

/** Receipt or payment voucher → printed document (BUILD_PLAN §13.7). */
export function voucherPrint(
  kind: 'receipt' | 'payment',
  v: VoucherLike & { receiptNo?: string | null; paymentNo?: string | null; receiptDate?: Date; paymentDate?: Date },
  lang: Lang,
): DocumentPrint {
  const receipt = kind === 'receipt';
  const no = receipt ? v.receiptNo : v.paymentNo;
  const party = v.party ? `${v.party.code} — ${lang === 'en' && v.party.nameEn ? v.party.nameEn : v.party.nameAr}` : null;
  const active = v.allocations.filter((a) => a.cancelledAt === null);
  return {
    title: receipt ? t(lang, 'سند قبض', 'Receipt voucher') : t(lang, 'سند صرف', 'Payment voucher'),
    docNo: no ?? null,
    status: 'POSTED',
    banner: v.reversedAt ? t(lang, `معكوس بتاريخ ${ymd(v.reversedAt)}`, `Reversed on ${ymd(v.reversedAt)}`) : null,
    fields: [
      {
        label: receipt ? t(lang, 'استلمنا من', 'Received from') : t(lang, 'صرفنا إلى', 'Paid to'),
        value: party ?? (v.expenseAccount ? `${v.expenseAccount.code} — ${v.expenseAccount.nameAr}` : null),
      },
      { label: t(lang, 'التاريخ', 'Date'), value: ymd(receipt ? v.receiptDate : v.paymentDate) },
      { label: t(lang, 'الصندوق / البنك', 'Cash / bank'), value: v.cashAccount ? `${v.cashAccount.code} — ${v.cashAccount.nameAr}` : null },
      { label: t(lang, 'طريقة الدفع', 'Method'), value: v.paymentMethod?.nameAr ?? '—' },
      { label: t(lang, 'المرجع', 'Reference'), value: v.referenceNo ?? '—' },
      { label: t(lang, 'البيان', 'Description'), value: v.description ?? '—' },
    ],
    lines: active.length
      ? {
          columns: [
            { key: 'invoice', label: t(lang, 'الفاتورة المسددة', 'Invoice settled'), kind: 'text' },
            { key: 'amount', label: t(lang, 'المبلغ المخصص', 'Allocated'), kind: 'amount', width: 90 },
          ],
          rows: active.map((a) => ({ invoice: a.invoiceNo ?? a.documentType, amount: a.amount.toString() })),
        }
      : undefined,
    totals: [
      { label: t(lang, 'المخصص', 'Allocated'), value: v.allocatedAmount },
      { label: t(lang, 'غير المخصص', 'Unallocated'), value: v.unallocatedAmount },
      { label: t(lang, 'المبلغ', 'Amount'), value: v.amount.toString(), strong: true },
    ],
    signatures: receipt
      ? [t(lang, 'المستلم (أمين الصندوق)', 'Received by (cashier)'), t(lang, 'الدافع', 'Paid by')]
      : [t(lang, 'المستلم', 'Received by'), t(lang, 'أمين الصندوق', 'Cashier'), t(lang, 'المدير', 'Approved by')],
    fileName: no ?? kind,
  };
}
