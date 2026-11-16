import type { DocumentPrint } from '../printing/document-pdf.js';

type Lang = 'ar' | 'en';
type Dec = { toString(): string };
const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

interface CustomerLike {
  code: string;
  nameAr: string;
  nameEn: string | null;
  taxNumber: string | null;
}

interface LineLike {
  lineNo: number;
  qty: Dec;
  note: string | null;
  item: { code: string; nameAr: string; nameEn: string | null } | null;
  itemUnit?: { unit: { nameAr: string } | null } | null;
  unitPrice: Dec;
  discountAmount: Dec;
  taxAmount: Dec;
  lineTotal: Dec;
}

const customerName = (c: CustomerLike | null, lang: Lang) =>
  c ? `${c.code} — ${lang === 'en' && c.nameEn ? c.nameEn : c.nameAr}` : null;
const itemName = (l: LineLike, lang: Lang) =>
  l.item ? `${l.item.code} — ${lang === 'en' && l.item.nameEn ? l.item.nameEn : l.item.nameAr}` : '';

const lineColumns = (lang: Lang): NonNullable<DocumentPrint['lines']>['columns'] => [
  { key: 'no', label: '#', kind: 'int', width: 22 },
  { key: 'item', label: t(lang, 'الصنف', 'Item'), kind: 'text' },
  { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 48 },
  { key: 'qty', label: t(lang, 'الكمية', 'Qty'), kind: 'qty', width: 48 },
  { key: 'price', label: t(lang, 'السعر', 'Price'), kind: 'qty', width: 58 },
  { key: 'discount', label: t(lang, 'الخصم', 'Discount'), kind: 'amount', width: 52 },
  { key: 'tax', label: t(lang, 'الضريبة', 'Tax'), kind: 'amount', width: 52 },
  { key: 'total', label: t(lang, 'الإجمالي', 'Total'), kind: 'amount', width: 64 },
];

const lineRows = (lines: LineLike[], lang: Lang) =>
  lines.map((l) => ({
    no: l.lineNo,
    item: itemName(l, lang),
    unit: l.itemUnit?.unit?.nameAr ?? '',
    qty: l.qty.toString(),
    price: l.unitPrice.toString(),
    discount: l.discountAmount.toString(),
    tax: l.taxAmount.toString(),
    total: l.lineTotal.toString(),
  }));

interface SalesQuoteLike {
  quoteNo: string | null;
  quoteDate: Date;
  validUntil: Date | null;
  status: 'DRAFT' | 'SENT' | 'ACCEPTED' | 'REJECTED' | 'CANCELLED';
  description: string | null;
  cancelReason: string | null;
  pricesIncludeTax: boolean;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  customer: CustomerLike | null;
  warehouse: { nameAr: string } | null;
  lines: LineLike[];
}

/**
 * Sales quote → printed document for the customer (ADR-027 §2). Only a sent
 * quote carries its number; a draft prints with the draft watermark, and a
 * cancelled one says so above the lines.
 */
export function salesQuotePrint(q: SalesQuoteLike, lang: Lang): DocumentPrint {
  return {
    title: t(lang, 'عرض سعر', 'Sales quotation'),
    docNo: q.quoteNo,
    status: q.status === 'DRAFT' ? 'DRAFT' : 'POSTED',
    banner:
      q.status === 'CANCELLED' ? t(lang, `ملغى: ${q.cancelReason ?? ''}`, `Cancelled: ${q.cancelReason ?? ''}`) : null,
    fields: [
      { label: t(lang, 'العميل', 'Customer'), value: customerName(q.customer, lang) },
      { label: t(lang, 'تاريخ العرض', 'Quote date'), value: ymd(q.quoteDate) },
      { label: t(lang, 'الرقم الضريبي للعميل', 'Customer tax no.'), value: q.customer?.taxNumber ?? '—' },
      { label: t(lang, 'صالح حتى', 'Valid until'), value: ymd(q.validUntil) ?? '—' },
      { label: t(lang, 'المستودع', 'Warehouse'), value: q.warehouse?.nameAr ?? null },
      {
        label: t(lang, 'الأسعار', 'Prices'),
        value: q.pricesIncludeTax ? t(lang, 'شاملة الضريبة', 'Including tax') : t(lang, 'قبل الضريبة', 'Before tax'),
      },
    ],
    lines: { columns: lineColumns(lang), rows: lineRows(q.lines, lang) },
    totals: [
      { label: t(lang, 'الصافي', 'Net'), value: q.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: q.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: q.grandTotal.toString(), strong: true },
    ],
    notes: q.description ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: q.description }] : [],
    signatures: [t(lang, 'المعتمِد', 'Approved by'), t(lang, 'العميل', 'Customer')],
    fileName: q.quoteNo ?? 'sales-quote-draft',
  };
}

interface SalesOrderLike {
  orderNo: string | null;
  orderDate: Date;
  expectedDate: Date | null;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'CONFIRMED' | 'PARTIALLY_INVOICED' | 'INVOICED' | 'CLOSED' | 'CANCELLED';
  description: string | null;
  cancelReason: string | null;
  closeReason: string | null;
  pricesIncludeTax: boolean;
  paymentTermsDays: number | null;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  customer: CustomerLike | null;
  warehouse: { nameAr: string } | null;
  quote: { quoteNo: string | null } | null;
  lines: LineLike[];
}

/**
 * Sales order → printed document for the customer (ADR-027 §3). Only a
 * confirmed order carries its number; anything else prints with the draft watermark.
 */
export function salesOrderPrint(o: SalesOrderLike, lang: Lang): DocumentPrint {
  const confirmed = o.status !== 'DRAFT' && o.status !== 'PENDING_APPROVAL';
  return {
    title: t(lang, 'أمر بيع', 'Sales order'),
    docNo: o.orderNo,
    status: confirmed ? 'POSTED' : 'DRAFT',
    banner:
      o.status === 'CANCELLED'
        ? t(lang, `ملغى: ${o.cancelReason ?? ''}`, `Cancelled: ${o.cancelReason ?? ''}`)
        : o.status === 'CLOSED'
          ? t(lang, `مغلق: ${o.closeReason ?? ''}`, `Closed: ${o.closeReason ?? ''}`)
          : null,
    fields: [
      { label: t(lang, 'العميل', 'Customer'), value: customerName(o.customer, lang) },
      { label: t(lang, 'تاريخ الأمر', 'Order date'), value: ymd(o.orderDate) },
      { label: t(lang, 'الرقم الضريبي للعميل', 'Customer tax no.'), value: o.customer?.taxNumber ?? '—' },
      { label: t(lang, 'التاريخ المتوقع للتسليم', 'Expected delivery'), value: ymd(o.expectedDate) ?? '—' },
      { label: t(lang, 'المستودع', 'Warehouse'), value: o.warehouse?.nameAr ?? null },
      { label: t(lang, 'عرض السعر', 'Quotation'), value: o.quote?.quoteNo ?? '—' },
      { label: t(lang, 'شروط الدفع (أيام)', 'Payment terms (days)'), value: o.paymentTermsDays?.toString() ?? '—' },
      {
        label: t(lang, 'الأسعار', 'Prices'),
        value: o.pricesIncludeTax ? t(lang, 'شاملة الضريبة', 'Including tax') : t(lang, 'قبل الضريبة', 'Before tax'),
      },
    ],
    lines: { columns: lineColumns(lang), rows: lineRows(o.lines, lang) },
    totals: [
      { label: t(lang, 'الصافي', 'Net'), value: o.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: o.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: o.grandTotal.toString(), strong: true },
    ],
    notes: o.description ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: o.description }] : [],
    signatures: [t(lang, 'المعتمِد', 'Approved by'), t(lang, 'العميل', 'Customer')],
    fileName: o.orderNo ?? 'sales-order-draft',
  };
}
