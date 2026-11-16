import type { ReportColumn, ReportRow, ReportTable } from '../printing/report-table.js';
import type { StockCountSheetDto, StockCountVarianceDto } from './dto/stock-documents-response.dto.js';

type Lang = 'ar' | 'en';

/**
 * Column headers of the count sheet. The import reads the same headers back
 * (counts.service.ts importSheet): `code`, `barcode`, `unit`, `counted`, in
 * either language.
 */
export const SHEET_HEADERS = {
  ar: { code: 'الرمز', barcode: 'الباركود', name: 'الاسم', unit: 'الوحدة', book: 'رصيد الدفتر', counted: 'المعدود' },
  en: { code: 'Code', barcode: 'Barcode', name: 'Name', unit: 'Unit', book: 'Book qty', counted: 'Counted' },
} as const;

const TEXT = {
  ar: {
    sheetTitle: 'ورقة الجرد',
    varianceTitle: 'تقرير فروقات الجرد',
    warehouse: 'المستودع',
    countDate: 'تاريخ الجرد',
    status: 'الحالة',
    docNo: 'رقم المستند',
    blind: 'جرد أعمى: رصيد الدفتر غير معروض',
    unitCost: 'تكلفة الوحدة',
    difference: 'الفرق',
    value: 'قيمة الفرق',
    flag: 'ملاحظة',
    zeroCost: 'زيادة بتكلفة صفر',
    notCounted: 'لم يُعدّ',
    counted: 'مُعدّ',
    shortage: 'مجموع العجز',
    surplus: 'مجموع الزيادة',
    net: 'الصافي',
  },
  en: {
    sheetTitle: 'Count sheet',
    varianceTitle: 'Count variance report',
    warehouse: 'Warehouse',
    countDate: 'Count date',
    status: 'Status',
    docNo: 'Document no.',
    blind: 'Blind count: book qty not shown',
    unitCost: 'Unit cost',
    difference: 'Difference',
    value: 'Difference value',
    flag: 'Note',
    zeroCost: 'Gain at zero cost',
    notCounted: 'Not counted',
    counted: 'Counted',
    shortage: 'Total shortage',
    surplus: 'Total surplus',
    net: 'Net',
  },
} as const;

/** The count sheet as a table (PDF or xlsx). The book column is left out while a blind count is a draft. */
export function sheetTable(sheet: StockCountSheetDto, lang: Lang): ReportTable {
  const h = SHEET_HEADERS[lang];
  const t = TEXT[lang];
  const columns: ReportColumn[] = [
    { key: 'code', label: h.code, kind: 'text', width: 70 },
    { key: 'barcode', label: h.barcode, kind: 'text', width: 90 },
    { key: 'name', label: h.name, kind: 'text' },
    { key: 'unit', label: h.unit, kind: 'text', width: 60 },
    ...(sheet.bookHidden ? [] : [{ key: 'bookQty', label: h.book, kind: 'qty' as const, width: 80 }]),
    { key: 'countedQty', label: h.counted, kind: 'qty', width: 80 },
  ];
  const rows: ReportRow[] = sheet.rows.map((r) => ({
    code: r.code,
    barcode: r.barcode,
    name: r.name,
    unit: r.unit,
    ...(sheet.bookHidden ? {} : { bookQty: r.bookQty ?? null }),
    countedQty: r.countedQty,
  }));
  return {
    title: `${t.sheetTitle} ${sheet.docNo ?? sheet.countId}`,
    meta: [
      `${t.warehouse}: ${sheet.warehouse.code} ${sheet.warehouse.nameAr}`,
      `${t.countDate}: ${sheet.countDate}`,
      ...(sheet.bookHidden ? [t.blind] : []),
    ],
    columns,
    rows,
    fileName: `count-${sheet.countId}-sheet`,
  };
}

/**
 * The difference report as a table: the counted lines with their book, count,
 * difference and its value at the current average cost, then the uncounted lines
 * (listed, not valued), then the totals.
 */
export function varianceTable(report: StockCountVarianceDto, lang: Lang): ReportTable {
  const t = TEXT[lang];
  const columns: ReportColumn[] = [
    { key: 'code', label: SHEET_HEADERS[lang].code, kind: 'text', width: 70 },
    { key: 'name', label: SHEET_HEADERS[lang].name, kind: 'text' },
    { key: 'unit', label: SHEET_HEADERS[lang].unit, kind: 'text', width: 55 },
    { key: 'book', label: SHEET_HEADERS[lang].book, kind: 'qty', width: 70 },
    { key: 'counted', label: SHEET_HEADERS[lang].counted, kind: 'qty', width: 70 },
    { key: 'difference', label: t.difference, kind: 'qty', width: 70 },
    { key: 'unitCost', label: t.unitCost, kind: 'amount', width: 70 },
    { key: 'value', label: t.value, kind: 'amount', width: 70 },
    { key: 'flag', label: t.flag, kind: 'text', width: 110 },
  ];
  const rows: ReportRow[] = [
    ...report.lines.map((l) => ({
      code: l.code,
      name: l.nameAr,
      unit: l.unit,
      book: l.bookQty,
      counted: l.countedQty,
      difference: l.differenceQty,
      unitCost: l.unitCost,
      value: l.differenceValue,
      flag: l.zeroCostGain ? t.zeroCost : '',
    })),
    ...report.uncounted.map((u) => ({ code: u.code, name: u.nameAr, flag: t.notCounted })),
  ];
  const totals: ReportRow[] = [
    { _bold: true, name: t.shortage, value: report.totals.shortageValue, difference: report.totals.shortageQty },
    { _bold: true, name: t.surplus, value: report.totals.surplusValue, difference: report.totals.surplusQty },
    { _bold: true, name: t.net, value: report.totals.netValue },
  ];
  return {
    title: `${t.varianceTitle} ${report.docNo ?? report.countId}`,
    meta: [
      `${t.warehouse}: ${report.warehouse.code} ${report.warehouse.nameAr}`,
      `${t.countDate}: ${report.countDate}`,
      `${t.status}: ${report.status}`,
      ...(report.docNo ? [`${t.docNo}: ${report.docNo}`] : []),
      `${t.counted}: ${report.totals.countedLines} / ${t.notCounted}: ${report.totals.uncountedLines}`,
    ],
    columns,
    rows,
    totals,
    fileName: `count-${report.countId}-variance`,
  };
}
