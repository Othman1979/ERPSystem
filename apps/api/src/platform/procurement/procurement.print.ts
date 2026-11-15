import type { DocumentPrint } from '../printing/document-pdf.js';

type Lang = 'ar' | 'en';
type Dec = { toString(): string };
const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

interface SupplierLike {
  code: string;
  nameAr: string;
  nameEn: string | null;
  taxNumber: string | null;
  phone: string | null;
}

interface LineLike {
  lineNo: number;
  qty: Dec;
  note: string | null;
  item: { code: string; nameAr: string; nameEn: string | null } | null;
  itemUnit?: { unit: { nameAr: string } | null } | null;
}

const supplierName = (s: SupplierLike | null, lang: Lang) =>
  s ? `${s.code} — ${lang === 'en' && s.nameEn ? s.nameEn : s.nameAr}` : null;
const itemName = (l: LineLike, lang: Lang) =>
  l.item ? `${l.item.code} — ${lang === 'en' && l.item.nameEn ? l.item.nameEn : l.item.nameAr}` : '';

interface PurchaseOrderLike {
  orderNo: string | null;
  orderDate: Date;
  expectedDate: Date | null;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'CANCELLED' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED';
  notes: string | null;
  cancelReason: string | null;
  closeReason: string | null;
  pricesIncludeTax: boolean;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  supplier: SupplierLike | null;
  warehouse: { nameAr: string } | null;
  request: { requestNo: string | null } | null;
  lines: (LineLike & { unitPrice: Dec; discountAmount: Dec; taxAmount: Dec; lineTotal: Dec })[];
}

/**
 * Purchase order → printed document for the supplier (ADR-025 §14). Only an
 * approved order carries its number; anything else prints with the draft
 * watermark, and a cancelled one says so above the lines.
 */
export function purchaseOrderPrint(po: PurchaseOrderLike, lang: Lang): DocumentPrint {
  return {
    title: t(lang, 'أمر شراء', 'Purchase order'),
    docNo: po.orderNo,
    // Numbered from approval on (ADR-025 §8), whatever was received or closed since (ADR-026 §6).
    status: po.status === 'DRAFT' || po.status === 'SUBMITTED' ? 'DRAFT' : 'POSTED',
    banner:
      po.status === 'CANCELLED'
        ? t(lang, `ملغى: ${po.cancelReason ?? ''}`, `Cancelled: ${po.cancelReason ?? ''}`)
        : po.status === 'CLOSED'
          ? t(lang, `مغلق: ${po.closeReason ?? ''}`, `Closed: ${po.closeReason ?? ''}`)
          : null,
    fields: [
      { label: t(lang, 'المورد', 'Supplier'), value: supplierName(po.supplier, lang) },
      { label: t(lang, 'تاريخ الأمر', 'Order date'), value: ymd(po.orderDate) },
      { label: t(lang, 'الرقم الضريبي للمورد', 'Supplier tax no.'), value: po.supplier?.taxNumber ?? '—' },
      { label: t(lang, 'التاريخ المتوقع للتوريد', 'Expected delivery'), value: ymd(po.expectedDate) ?? '—' },
      { label: t(lang, 'مستودع الاستلام', 'Deliver to warehouse'), value: po.warehouse?.nameAr ?? null },
      { label: t(lang, 'طلب الشراء', 'Purchase request'), value: po.request?.requestNo ?? '—' },
      {
        label: t(lang, 'الأسعار', 'Prices'),
        value: po.pricesIncludeTax ? t(lang, 'شاملة الضريبة', 'Including tax') : t(lang, 'قبل الضريبة', 'Before tax'),
      },
    ],
    lines: {
      columns: [
        { key: 'no', label: '#', kind: 'int', width: 22 },
        { key: 'item', label: t(lang, 'الصنف', 'Item'), kind: 'text' },
        { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 48 },
        { key: 'qty', label: t(lang, 'الكمية', 'Qty'), kind: 'qty', width: 48 },
        { key: 'price', label: t(lang, 'السعر', 'Price'), kind: 'qty', width: 58 },
        { key: 'discount', label: t(lang, 'الخصم', 'Discount'), kind: 'amount', width: 52 },
        { key: 'tax', label: t(lang, 'الضريبة', 'Tax'), kind: 'amount', width: 52 },
        { key: 'total', label: t(lang, 'الإجمالي', 'Total'), kind: 'amount', width: 64 },
      ],
      rows: po.lines.map((l) => ({
        no: l.lineNo,
        item: itemName(l, lang),
        unit: l.itemUnit?.unit?.nameAr ?? '',
        qty: l.qty.toString(),
        price: l.unitPrice.toString(),
        discount: l.discountAmount.toString(),
        tax: l.taxAmount.toString(),
        total: l.lineTotal.toString(),
      })),
    },
    totals: [
      { label: t(lang, 'الصافي', 'Net'), value: po.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: po.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: po.grandTotal.toString(), strong: true },
    ],
    notes: po.notes ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: po.notes }] : [],
    signatures: [t(lang, 'المعتمِد', 'Approved by'), t(lang, 'المورد', 'Supplier')],
    fileName: po.orderNo ?? 'purchase-order-draft',
  };
}

interface PurchaseQuoteLike {
  quoteNo: string | null;
  quoteDate: Date;
  validUntil: Date | null;
  status: 'DRAFT' | 'SENT' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
  notes: string | null;
  supplierRef: string | null;
  supplier: SupplierLike | null;
  request: { requestNo: string | null } | null;
  lines: (LineLike & { unitPrice: Dec | null; lineTotal: Dec })[];
}

/**
 * Request for quotation → printed document for the supplier (ADR-025 §14):
 * the items and quantities asked for, with a blank price column to fill in
 * (the prices once received). Numbered from SENT on.
 */
export function purchaseQuotePrint(q: PurchaseQuoteLike, lang: Lang): DocumentPrint {
  const priced = q.status === 'RECEIVED' || (q.status === 'CLOSED' && q.lines.some((l) => l.unitPrice !== null));
  return {
    title: t(lang, 'طلب عرض سعر', 'Request for quotation'),
    docNo: q.quoteNo,
    status: q.status === 'DRAFT' ? 'DRAFT' : 'POSTED',
    banner: q.status === 'CANCELLED' ? t(lang, 'ملغى', 'Cancelled') : null,
    fields: [
      { label: t(lang, 'إلى المورد', 'To supplier'), value: supplierName(q.supplier, lang) },
      { label: t(lang, 'التاريخ', 'Date'), value: ymd(q.quoteDate) },
      { label: t(lang, 'هاتف المورد', 'Supplier phone'), value: q.supplier?.phone ?? '—' },
      { label: t(lang, 'صالح حتى', 'Valid until'), value: ymd(q.validUntil) ?? '—' },
      { label: t(lang, 'طلب الشراء', 'Purchase request'), value: q.request?.requestNo ?? '—' },
      { label: t(lang, 'مرجع المورد', 'Supplier reference'), value: q.supplierRef ?? '—' },
    ],
    lines: {
      columns: [
        { key: 'no', label: '#', kind: 'int', width: 22 },
        { key: 'item', label: t(lang, 'الصنف', 'Item'), kind: 'text' },
        { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 56 },
        { key: 'qty', label: t(lang, 'الكمية', 'Qty'), kind: 'qty', width: 56 },
        { key: 'price', label: t(lang, 'سعر الوحدة', 'Unit price'), kind: 'text', width: 72 },
        { key: 'total', label: t(lang, 'الإجمالي', 'Total'), kind: 'text', width: 72 },
        { key: 'note', label: t(lang, 'ملاحظة', 'Note'), kind: 'text', width: 90 },
      ],
      rows: q.lines.map((l) => ({
        no: l.lineNo,
        item: itemName(l, lang),
        unit: l.itemUnit?.unit?.nameAr ?? '',
        qty: l.qty.toString(),
        price: priced && l.unitPrice !== null ? l.unitPrice.toString() : '',
        total: priced ? l.lineTotal.toString() : '',
        note: l.note ?? '',
      })),
    },
    notes: q.notes ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: q.notes }] : [],
    signatures: [t(lang, 'المشتريات', 'Purchasing'), t(lang, 'المورد', 'Supplier')],
    fileName: q.quoteNo ?? 'rfq-draft',
  };
}
