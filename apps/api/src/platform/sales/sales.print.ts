import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { DocumentPrint } from '../printing/document-pdf.js';
import type { ReportColumn } from '../printing/report-table.js';

type Lang = 'ar' | 'en';
type Dec = { toString(): string };
const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const name = (lang: Lang, p: { nameAr: string; nameEn?: string | null } | null | undefined) =>
  p ? (lang === 'en' && p.nameEn ? p.nameEn : p.nameAr) : null;

interface EInvoiceState {
  status: string;
  uuid: string;
  icv: number;
  environment: string;
  qrPayload: string | null;
  completedAt?: Date | null;
}

const EINVOICE_STATUS: Record<string, [string, string]> = {
  PENDING: ['بانتظار الإرسال', 'waiting to be sent'],
  SENDING: ['قيد الإرسال', 'being sent'],
  REJECTED: ['مرفوضة', 'rejected'],
  FAILED: ['تعذر الإرسال', 'could not be sent'],
  UNKNOWN: ['غير معروفة النتيجة — تحقق من البوابة', 'result unknown — check the portal'],
};

/** QR when JoFotara accepted the document; a printed banner while it has not (BUILD_PLAN §12.4). */
export function einvoiceParts(lang: Lang, e: EInvoiceState | null | undefined): Pick<DocumentPrint, 'qr' | 'banner'> {
  if (!e) return { qr: null, banner: null };
  if (e.status === 'ACCEPTED' && e.qrPayload) {
    return {
      banner: null,
      qr: {
        payload: e.qrPayload,
        lines: [
          t(lang, 'مقبولة في نظام الفوترة الوطني (JoFotara)', 'Accepted by JoFotara'),
          `UUID: ${e.uuid}`,
          `ICV: ${e.icv}`,
          ...(e.environment === 'SANDBOX' ? [t(lang, 'بيئة تجريبية (محاكي محلي)', 'Sandbox (local mock)')] : []),
        ],
      },
    };
  }
  const [ar, en] = EINVOICE_STATUS[e.status] ?? [e.status, e.status];
  return {
    qr: null,
    banner: t(lang, `لم تُقبل في نظام الفوترة الوطني بعد: ${ar}`, `Not accepted by JoFotara yet: ${en}`),
  };
}

const lineColumns = (lang: Lang): ReportColumn[] => [
  { key: 'no', label: '#', kind: 'int', width: 22 },
  { key: 'item', label: t(lang, 'الصنف', 'Item'), kind: 'text' },
  { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 48 },
  { key: 'qty', label: t(lang, 'الكمية', 'Qty'), kind: 'qty', width: 48 },
  { key: 'price', label: t(lang, 'السعر', 'Price'), kind: 'amount', width: 58 },
  { key: 'discount', label: t(lang, 'الخصم', 'Discount'), kind: 'amount', width: 52 },
  { key: 'tax', label: t(lang, 'الضريبة', 'Tax'), kind: 'amount', width: 52 },
  { key: 'total', label: t(lang, 'الإجمالي', 'Total'), kind: 'amount', width: 64 },
];

interface InvoiceLike {
  invoiceNo: string | null;
  invoiceDate: Date;
  dueDate: Date | null;
  paymentType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  description: string | null;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  customer: { code: string; nameAr: string; nameEn: string | null; taxNumber: string | null; phone: string | null } | null;
  warehouse: { nameAr: string; nameEn?: string | null } | null;
  lines: {
    lineNo: number;
    qty: Dec;
    unitPrice: Dec;
    discountAmount: Dec;
    taxAmount: Dec;
    lineTotal: Dec;
    item: { code: string; nameAr: string } | null;
    itemUnit?: { unit: { nameAr: string } | null } | null;
  }[];
  einvoice?: EInvoiceState | null;
  outstanding?: string;
}

/** Sales invoice → printed document (§13.7). */
export function salesInvoicePrint(inv: InvoiceLike, lang: Lang): DocumentPrint {
  const discount = inv.lines.reduce((s, l) => s.plus(l.discountAmount.toString()), new Decimal(0));
  return {
    title: t(lang, 'فاتورة مبيعات', 'Sales invoice'),
    docNo: inv.invoiceNo,
    status: inv.status,
    fields: [
      { label: t(lang, 'العميل', 'Customer'), value: inv.customer ? `${inv.customer.code} — ${name(lang, inv.customer)}` : null },
      { label: t(lang, 'تاريخ الفاتورة', 'Invoice date'), value: ymd(inv.invoiceDate) },
      { label: t(lang, 'الرقم الضريبي للعميل', 'Customer tax no.'), value: inv.customer?.taxNumber ?? '—' },
      { label: t(lang, 'نوع الدفع', 'Payment'), value: inv.paymentType === 'CASH' ? t(lang, 'نقدي', 'Cash') : t(lang, 'آجل', 'Credit') },
      { label: t(lang, 'المستودع', 'Warehouse'), value: name(lang, inv.warehouse) },
      { label: t(lang, 'تاريخ الاستحقاق', 'Due date'), value: ymd(inv.dueDate) ?? '—' },
    ],
    lines: {
      columns: lineColumns(lang),
      rows: inv.lines.map((l) => ({
        no: l.lineNo,
        item: l.item ? `${l.item.code} — ${l.item.nameAr}` : '',
        unit: l.itemUnit?.unit?.nameAr ?? '',
        qty: l.qty.toString(),
        price: l.unitPrice.toString(),
        discount: l.discountAmount.toString(),
        tax: l.taxAmount.toString(),
        total: l.lineTotal.toString(),
      })),
    },
    totals: [
      { label: t(lang, 'الإجمالي قبل الخصم', 'Subtotal'), value: discount.plus(inv.netTotal.toString()).toFixed(3) },
      { label: t(lang, 'الخصم', 'Discount'), value: discount.toFixed(3) },
      { label: t(lang, 'الصافي', 'Net'), value: inv.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: inv.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: inv.grandTotal.toString(), strong: true },
      ...(inv.paymentType === 'CREDIT' && inv.outstanding !== undefined
        ? [{ label: t(lang, 'المتبقي', 'Outstanding'), value: inv.outstanding }]
        : []),
    ],
    notes: inv.description ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: inv.description }] : [],
    ...einvoiceParts(lang, inv.einvoice),
    signatures: [t(lang, 'المستلم', 'Received by'), t(lang, 'المحاسب', 'Accountant')],
    fileName: inv.invoiceNo ?? 'sales-invoice-draft',
  };
}

interface ReturnLike {
  returnNo: string | null;
  returnDate: Date;
  status: 'DRAFT' | 'POSTED';
  refundType: 'CASH' | 'CREDIT';
  reason: string | null;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  customer: { code: string; nameAr: string; nameEn: string | null; taxNumber: string | null } | null;
  originalInvoice: { invoiceNo: string | null; invoiceDate: Date } | null;
  lines: {
    lineNo: number;
    qty: Dec;
    unitPrice: Dec;
    discountAmount: Dec;
    taxAmount: Dec;
    lineTotal: Dec;
    item: { code: string; nameAr: string } | null;
    /** The quantity and price are in the original line's unit (TRADE-13). */
    originalLine?: { itemUnit?: { unit: { nameAr: string } | null } | null } | null;
  }[];
  einvoice?: EInvoiceState | null;
}

/** Sales return → printed credit note (§13.7): with its original invoice and reason. */
export function salesReturnPrint(ret: ReturnLike, lang: Lang): DocumentPrint {
  return {
    title: t(lang, 'مرتجع مبيعات (إشعار دائن)', 'Sales return (credit note)'),
    docNo: ret.returnNo,
    status: ret.status,
    fields: [
      { label: t(lang, 'العميل', 'Customer'), value: ret.customer ? `${ret.customer.code} — ${name(lang, ret.customer)}` : null },
      { label: t(lang, 'تاريخ المرتجع', 'Return date'), value: ymd(ret.returnDate) },
      { label: t(lang, 'الفاتورة الأصلية', 'Original invoice'), value: ret.originalInvoice?.invoiceNo ?? '—' },
      { label: t(lang, 'تاريخ الفاتورة الأصلية', 'Original date'), value: ymd(ret.originalInvoice?.invoiceDate) },
      { label: t(lang, 'طريقة الرد', 'Refund'), value: ret.refundType === 'CASH' ? t(lang, 'نقداً', 'Cash') : t(lang, 'على الحساب', 'On account') },
      { label: t(lang, 'الرقم الضريبي للعميل', 'Customer tax no.'), value: ret.customer?.taxNumber ?? '—' },
    ],
    lines: {
      columns: lineColumns(lang),
      rows: ret.lines.map((l) => ({
        no: l.lineNo,
        item: l.item ? `${l.item.code} — ${l.item.nameAr}` : '',
        unit: l.originalLine?.itemUnit?.unit?.nameAr ?? '',
        qty: l.qty.toString(),
        price: l.unitPrice.toString(),
        discount: l.discountAmount.toString(),
        tax: l.taxAmount.toString(),
        total: l.lineTotal.toString(),
      })),
    },
    totals: [
      { label: t(lang, 'الصافي', 'Net'), value: ret.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: ret.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: ret.grandTotal.toString(), strong: true },
    ],
    notes: ret.reason ? [{ label: t(lang, 'سبب الإرجاع', 'Reason'), value: ret.reason }] : [],
    ...einvoiceParts(lang, ret.einvoice),
    signatures: [t(lang, 'المستلم', 'Received by'), t(lang, 'المحاسب', 'Accountant')],
    fileName: ret.returnNo ?? 'sales-return-draft',
  };
}
