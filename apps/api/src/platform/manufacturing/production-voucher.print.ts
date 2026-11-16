import type { DocumentPrint } from '../printing/document-pdf.js';
import type { ProductionVoucherDetail } from './production-vouchers.service.js';

type Lang = 'ar' | 'en';

const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);

/**
 * The production voucher as a printed sheet (ADR-031 §11): the output, the
 * materials with their standard and actual quantities, and the cost build-up.
 */
export function productionVoucherPrint(voucher: ProductionVoucherDetail, lang: Lang): DocumentPrint {
  const itemName = (i: { code: string; nameAr: string; nameEn: string | null }) =>
    lang === 'en' && i.nameEn ? `${i.code} - ${i.nameEn}` : `${i.code} - ${i.nameAr}`;
  const unitName = (u: { code: string; nameAr: string; nameEn: string | null }) => (lang === 'en' ? u.nameEn || u.code : u.nameAr);
  const posted = voucher.status === 'POSTED';
  const reversed = voucher.reversals.length > 0;
  return {
    title: t(lang, 'سند إنتاج', 'Production voucher'),
    docNo: voucher.docNo,
    status: posted ? 'POSTED' : 'DRAFT',
    banner: reversed
      ? t(lang, 'معكوس: لا يُعمل به', 'Reversed')
      : voucher.reversalOfId
        ? t(lang, 'سند عكسي', 'Reversal voucher')
        : posted
          ? null
          : t(lang, 'مسودة: لم تُرحَّل بعد', 'Draft: not posted yet'),
    fields: [
      { label: t(lang, 'الصنف المُنتَج', 'Produced item'), value: itemName(voucher.item) },
      { label: t(lang, 'التاريخ', 'Date'), value: voucher.voucherDate.toISOString().slice(0, 10) },
      {
        label: t(lang, 'كمية الإنتاج', 'Produced quantity'),
        value: `${voucher.qty.toString()} ${unitName(voucher.itemUnit?.unit ?? voucher.item.baseUnit)}`,
      },
      { label: t(lang, 'كمية الإنتاج بالأساسية', 'Produced in base unit'), value: voucher.qtyBase.toString() },
      { label: t(lang, 'نسخة المعادلة', 'Bill of materials version'), value: String(voucher.bom.versionNo) },
      { label: t(lang, 'مستودع المواد', 'Materials warehouse'), value: voucher.materialsWarehouse.nameAr },
      { label: t(lang, 'مستودع الناتج', 'Output warehouse'), value: voucher.outputWarehouse.nameAr },
      { label: t(lang, 'التكلفة المحمّلة لكل وحدة', 'Applied cost per unit'), value: voucher.appliedCostPerUnit.toString() },
      { label: t(lang, 'الوصف', 'Description'), value: voucher.description },
    ],
    lines: {
      columns: [
        { key: 'no', label: '#', kind: 'int', width: 22 },
        { key: 'item', label: t(lang, 'المكوّن', 'Component'), kind: 'text' },
        { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 52 },
        { key: 'standard', label: t(lang, 'المعياري بالأساسية', 'Standard base'), kind: 'qty', width: 64 },
        { key: 'actual', label: t(lang, 'الفعلي بالأساسية', 'Actual base'), kind: 'qty', width: 64 },
        { key: 'unitCost', label: t(lang, 'تكلفة الوحدة', 'Unit cost'), kind: 'qty', width: 60 },
        { key: 'total', label: t(lang, 'القيمة', 'Value'), kind: 'amount', width: 66 },
      ],
      rows: voucher.lines.map((l) => ({
        no: l.lineNo,
        item: itemName(l.item),
        unit: unitName(l.itemUnit?.unit ?? l.item.baseUnit),
        standard: l.standardQtyBase.toString(),
        actual: l.qtyBase.toString(),
        unitCost: l.unitCost?.toString() ?? '',
        total: l.totalCost?.toString() ?? '',
      })),
    },
    totals: [
      { label: t(lang, 'قيمة المواد', 'Materials'), value: voucher.materialsTotal.toString() },
      { label: t(lang, 'التكلفة المحمّلة', 'Applied cost'), value: voucher.appliedTotal.toString() },
      { label: t(lang, 'تكلفة الناتج', 'Output cost'), value: voucher.outputTotal.toString(), strong: true },
    ],
    notes: voucher.description ? [{ label: t(lang, 'الوصف', 'Description'), value: voucher.description }] : [],
    fileName: `production-${voucher.docNo ?? voucher.id.toString()}.pdf`,
  };
}
