import type { DocumentPrint } from '../printing/document-pdf.js';
import type { BomDetail } from './bom.service.js';

type Lang = 'ar' | 'en';

const t = (lang: Lang, ar: string, en: string) => (lang === 'ar' ? ar : en);

const STATUS_LABEL: Record<BomDetail['status'], { ar: string; en: string }> = {
  DRAFT: { ar: 'مسودة', en: 'Draft' },
  ACTIVE: { ar: 'نشطة', en: 'Active' },
  INACTIVE: { ar: 'غير نشطة', en: 'Inactive' },
};

/** The bill of materials as a printed sheet (ADR-031 §11): output, applied cost and components. */
export function bomPrint(bom: BomDetail, lang: Lang): DocumentPrint {
  const itemName = (i: { code: string; nameAr: string; nameEn: string | null }) =>
    lang === 'en' && i.nameEn ? `${i.code} - ${i.nameEn}` : `${i.code} - ${i.nameAr}`;
  const unitName = (u: { code: string; nameAr: string; nameEn: string | null }) => (lang === 'en' ? u.nameEn || u.code : u.nameAr);
  const status = STATUS_LABEL[bom.status][lang];
  return {
    title: t(lang, 'معادلة إنتاج', 'Bill of materials'),
    docNo: `${bom.item.code} / v${bom.versionNo}`,
    // A draft and an inactive version are not in force: printed as drafts, with a banner.
    status: bom.status === 'ACTIVE' ? 'POSTED' : 'DRAFT',
    banner:
      bom.status === 'DRAFT'
        ? t(lang, 'مسودة: لم تُفعَّل بعد', 'Draft: not active yet')
        : bom.status === 'INACTIVE'
          ? t(lang, 'نسخة غير نشطة', 'Inactive version')
          : null,
    fields: [
      { label: t(lang, 'الصنف المُصنَّع', 'Manufactured item'), value: itemName(bom.item) },
      { label: t(lang, 'الحالة', 'Status'), value: status },
      {
        label: t(lang, 'كمية الناتج', 'Output quantity'),
        value: `${bom.outputQty.toString()} ${unitName(bom.outputItemUnit?.unit ?? bom.item.baseUnit)}`,
      },
      { label: t(lang, 'كمية الناتج بالأساسية', 'Output in base unit'), value: bom.outputQtyBase.toString() },
      { label: t(lang, 'التكلفة المحمّلة لكل دفعة', 'Applied cost per batch'), value: bom.appliedCostPerUnit.toString() },
      { label: t(lang, 'رقم النسخة', 'Version'), value: String(bom.versionNo) },
    ],
    lines: {
      columns: [
        { key: 'no', label: '#', kind: 'int', width: 22 },
        { key: 'item', label: t(lang, 'المكوّن', 'Component'), kind: 'text' },
        { key: 'unit', label: t(lang, 'الوحدة', 'Unit'), kind: 'text', width: 52 },
        { key: 'qty', label: t(lang, 'الكمية لكل دفعة', 'Qty per batch'), kind: 'qty', width: 64 },
        { key: 'waste', label: t(lang, 'الهدر %', 'Waste %'), kind: 'qty', width: 52 },
        { key: 'base', label: t(lang, 'بالأساسية', 'Base qty'), kind: 'qty', width: 64 },
      ],
      rows: bom.lines.map((l) => ({
        no: l.lineNo,
        item: itemName(l.componentItem),
        unit: unitName(l.itemUnit?.unit ?? l.componentItem.baseUnit),
        qty: l.qty.toString(),
        waste: l.wastePct.toString(),
        base: l.qtyBase.toString(),
      })),
    },
    notes: bom.note ? [{ label: t(lang, 'ملاحظة', 'Note'), value: bom.note }] : [],
    fileName: `bom-${bom.item.code}-v${bom.versionNo}.pdf`,
  };
}
