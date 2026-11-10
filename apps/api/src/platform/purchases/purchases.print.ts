import { Decimal } from '../../common/decimal/decimal.utils.js';
import type { DocumentPrint } from '../printing/document-pdf.js';

type Lang = 'ar' | 'en';
type Dec = { toString(): string };
const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);
const ymd = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

interface PurchaseInvoiceLike {
  invoiceNo: string | null;
  supplierInvoiceNo: string | null;
  invoiceDate: Date;
  dueDate: Date | null;
  paymentType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  description: string | null;
  netTotal: Dec;
  taxTotal: Dec;
  grandTotal: Dec;
  supplier: { code: string; nameAr: string; nameEn: string | null; taxNumber: string | null } | null;
  warehouse: { nameAr: string } | null;
  lines: {
    lineNo: number;
    qty: Dec;
    unitCost: Dec;
    discountAmount: Dec;
    taxAmount: Dec;
    lineTotal: Dec;
    item: { code: string; nameAr: string } | null;
    itemUnit?: { unit: { nameAr: string } | null } | null;
  }[];
}

/** Purchase invoice → printed document (BUILD_PLAN §13.7). */
export function purchaseInvoicePrint(inv: PurchaseInvoiceLike, lang: Lang): DocumentPrint {
  const discount = inv.lines.reduce((s, l) => s.plus(l.discountAmount.toString()), new Decimal(0));
  const supplierName = inv.supplier ? (lang === 'en' && inv.supplier.nameEn ? inv.supplier.nameEn : inv.supplier.nameAr) : null;
  return {
    title: t(lang, 'فاتورة مشتريات', 'Purchase invoice'),
    docNo: inv.invoiceNo,
    status: inv.status,
    fields: [
      { label: t(lang, 'المورد', 'Supplier'), value: inv.supplier ? `${inv.supplier.code} — ${supplierName}` : null },
      { label: t(lang, 'تاريخ الفاتورة', 'Invoice date'), value: ymd(inv.invoiceDate) },
      { label: t(lang, 'رقم فاتورة المورد', 'Supplier invoice no.'), value: inv.supplierInvoiceNo ?? '—' },
      { label: t(lang, 'نوع الدفع', 'Payment'), value: inv.paymentType === 'CASH' ? t(lang, 'نقدي', 'Cash') : t(lang, 'آجل', 'Credit') },
      { label: t(lang, 'المستودع', 'Warehouse'), value: inv.warehouse?.nameAr ?? null },
      { label: t(lang, 'الرقم الضريبي للمورد', 'Supplier tax no.'), value: inv.supplier?.taxNumber ?? '—' },
    ],
    lines: {
      columns: [
        { key: 'no', label: '#', kind: 'int', width: 22 },
        { key: 'item', label: t(lang, 'الصنف', 'Item'), kind: 'text' },
        { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 48 },
        { key: 'qty', label: t(lang, 'الكمية', 'Qty'), kind: 'qty', width: 48 },
        { key: 'cost', label: t(lang, 'التكلفة', 'Cost'), kind: 'amount', width: 58 },
        { key: 'discount', label: t(lang, 'الخصم', 'Discount'), kind: 'amount', width: 52 },
        { key: 'tax', label: t(lang, 'الضريبة', 'Tax'), kind: 'amount', width: 52 },
        { key: 'total', label: t(lang, 'الإجمالي', 'Total'), kind: 'amount', width: 64 },
      ],
      rows: inv.lines.map((l) => ({
        no: l.lineNo,
        item: l.item ? `${l.item.code} — ${l.item.nameAr}` : '',
        unit: l.itemUnit?.unit?.nameAr ?? '',
        qty: l.qty.toString(),
        cost: l.unitCost.toString(),
        discount: l.discountAmount.toString(),
        tax: l.taxAmount.toString(),
        total: l.lineTotal.toString(),
      })),
    },
    totals: [
      { label: t(lang, 'الخصم', 'Discount'), value: discount.toFixed(3) },
      { label: t(lang, 'الصافي', 'Net'), value: inv.netTotal.toString() },
      { label: t(lang, 'الضريبة', 'Tax'), value: inv.taxTotal.toString() },
      { label: t(lang, 'الإجمالي', 'Total'), value: inv.grandTotal.toString(), strong: true },
    ],
    notes: inv.description ? [{ label: t(lang, 'ملاحظات', 'Notes'), value: inv.description }] : [],
    signatures: [t(lang, 'أمين المستودع', 'Storekeeper'), t(lang, 'المحاسب', 'Accountant')],
    fileName: inv.invoiceNo ?? 'purchase-invoice-draft',
  };
}
