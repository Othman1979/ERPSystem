import { L, type ReportTable } from '../printing/report-table.js';
import { localName } from '../printing/report-meta.js';
import type { ConsumptionReportDto } from './dto/consumption.dto.js';

type Lang = 'ar' | 'en';

/** Consumption between two counts → export table (ADR-032 §6): quantities, then values at the average. */
export function consumptionTable(data: ConsumptionReportDto, lang: Lang): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('الاستهلاك بين جردين', 'Consumption between two counts'),
    meta: [
      `${t('الجرد الأول', 'First count')}: ${data.fromCount.countDate}`,
      `${t('الجرد الثاني', 'Second count')}: ${data.toCount.countDate}`,
      t('الفعلي = معدود أ + الوارد − معدود ب. المسجّل = الصادر، عدا تسويات الجرد.', 'Actual = counted A + receipts − counted B. Recorded = outgoing, excluding count adjustments.'),
    ],
    fileName: 'stock-consumption',
    orientation: 'landscape',
    columns: [
      { key: 'code', label: t('رمز الصنف', 'Item code'), width: 60 },
      { key: 'name', label: t('الصنف', 'Item') },
      { key: 'opening', label: t('معدود أ', 'Counted A'), kind: 'qty', width: 60 },
      { key: 'receipts', label: t('الوارد', 'Receipts'), kind: 'qty', width: 60 },
      { key: 'closing', label: t('معدود ب', 'Counted B'), kind: 'qty', width: 60 },
      { key: 'actual', label: t('الفعلي', 'Actual'), kind: 'qty', width: 60 },
      { key: 'recipe', label: t('بالوصفات', 'By recipes'), kind: 'qty', width: 60 },
      { key: 'direct', label: t('بيع مباشر', 'Direct sales'), kind: 'qty', width: 60 },
      { key: 'other', label: t('أخرى', 'Other'), kind: 'qty', width: 60 },
      { key: 'recorded', label: t('المسجّل', 'Recorded'), kind: 'qty', width: 60 },
      { key: 'variance', label: t('الفرق (كمية)', 'Variance (qty)'), kind: 'qty', width: 60 },
      { key: 'varianceValue', label: t('الفرق (قيمة)', 'Variance (value)'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      code: r.code,
      name: localName(lang, r.nameAr, r.nameEn),
      opening: r.openingCounted,
      receipts: r.receipts,
      closing: r.closingCounted,
      actual: r.actual,
      recipe: r.recipeOut,
      direct: r.directSales,
      other: r.otherOut,
      recorded: r.recorded,
      variance: r.variance,
      varianceValue: r.varianceValue,
    })),
    totals: [
      { name: t('المجموع (قيمة)', 'Total (value)'), recordedValue: data.totals.recordedValue, varianceValue: data.totals.varianceValue },
    ],
  };
}
