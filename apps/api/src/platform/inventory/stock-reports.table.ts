import { L, type ReportTable } from '../printing/report-table.js';
import { isoDate, localName, periodMeta } from '../printing/report-meta.js';
import type { StockReportsService } from './stock-reports.service.js';

type Lang = 'ar' | 'en';
type Balances = Awaited<ReturnType<StockReportsService['balances']>>;
type Valuation = Awaited<ReturnType<StockReportsService['valuation']>>;
type ItemLedger = Awaited<ReturnType<StockReportsService['itemLedger']>>;
type ItemBalances = Awaited<ReturnType<StockReportsService['itemBalances']>>;
type WarehouseLabel = { code: string; nameAr: string; nameEn: string | null } | null;

function warehouseMeta(lang: Lang, wh: WarehouseLabel): string {
  const name = wh ? `${wh.code} ${localName(lang, wh.nameAr, wh.nameEn)}` : L({ lang }, 'كل المستودعات', 'all warehouses');
  return `${L({ lang }, 'المستودع', 'Warehouse')}: ${name}`;
}

/** Stock balances JSON → export table (one row per warehouse × item). */
export function stockBalancesTable(rows: Balances, lang: Lang, wh: WarehouseLabel, lowStock: boolean): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: lowStock ? t('أصناف تحت الحد الأدنى', 'Items below minimum stock') : t('أرصدة المخزون', 'Stock balances'),
    meta: [warehouseMeta(lang, wh)],
    fileName: 'stock-balances',
    columns: [
      { key: 'warehouse', label: t('المستودع', 'Warehouse'), width: 60 },
      { key: 'itemCode', label: t('رمز الصنف', 'Item code'), width: 70 },
      { key: 'itemName', label: t('الصنف', 'Item') },
      { key: 'unit', label: t('الوحدة', 'Unit'), width: 40 },
      { key: 'qty', label: t('الكمية', 'Quantity'), kind: 'qty', width: 70 },
      { key: 'minStock', label: t('الحد الأدنى', 'Minimum'), kind: 'qty', width: 70 },
      { key: 'lastMovement', label: t('آخر حركة', 'Last movement'), kind: 'date' },
    ],
    rows: rows.map((r) => ({
      warehouse: r.warehouseCode,
      itemCode: r.itemCode,
      itemName: r.itemName,
      unit: r.unit,
      qty: r.qtyOnHand,
      minStock: r.minStock,
      lastMovement: isoDate(r.lastMovementDate),
    })),
  };
}

/** Stock valuation JSON → export table; the total is the report's own total. */
export function stockValuationTable(data: Valuation, lang: Lang, wh: WarehouseLabel): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('تقييم المخزون', 'Stock valuation'),
    meta: [warehouseMeta(lang, wh), t('بالمتوسط المرجح', 'At weighted-average cost')],
    fileName: 'stock-valuation',
    columns: [
      { key: 'code', label: t('رمز الصنف', 'Item code'), width: 70 },
      { key: 'name', label: t('الصنف', 'Item') },
      { key: 'qty', label: t('الكمية', 'Quantity'), kind: 'qty', width: 70 },
      { key: 'avgCost', label: t('متوسط التكلفة', 'Average cost'), kind: 'qty', width: 74 },
      { key: 'value', label: t('القيمة', 'Value'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      code: r.code,
      name: localName(lang, r.nameAr, r.nameEn),
      qty: r.qty,
      avgCost: r.avgCost,
      value: r.value,
    })),
    totals: [{ name: t('المجموع', 'Total'), value: data.totalValue }],
  };
}

/** Items balance JSON → export table: opening, ins, outs and closing (quantity and value). */
export function itemBalancesTable(
  data: ItemBalances,
  lang: Lang,
  q: { from?: string; to?: string },
  wh: WarehouseLabel,
): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  return {
    title: t('ميزان المواد', 'Items balance'),
    meta: [warehouseMeta(lang, wh), periodMeta(lang, q.from || null, q.to || null)],
    fileName: 'items-balance',
    orientation: 'landscape',
    columns: [
      { key: 'code', label: t('الرمز', 'Code'), width: 56 },
      { key: 'name', label: t('الصنف', 'Item') },
      { key: 'openingQty', label: t('أول المدة كمية', 'Opening qty'), kind: 'qty' },
      { key: 'openingValue', label: t('أول المدة قيمة', 'Opening value'), kind: 'amount' },
      { key: 'inQty', label: t('وارد كمية', 'In qty'), kind: 'qty' },
      { key: 'inValue', label: t('وارد قيمة', 'In value'), kind: 'amount' },
      { key: 'outQty', label: t('صادر كمية', 'Out qty'), kind: 'qty' },
      { key: 'outValue', label: t('صادر قيمة', 'Out value'), kind: 'amount' },
      { key: 'closingQty', label: t('آخر المدة كمية', 'Closing qty'), kind: 'qty' },
      { key: 'closingValue', label: t('آخر المدة قيمة', 'Closing value'), kind: 'amount' },
    ],
    rows: data.rows.map((r) => ({
      code: r.code,
      name: localName(lang, r.nameAr, r.nameEn),
      openingQty: r.openingQty,
      openingValue: r.openingValue,
      inQty: r.inQty,
      inValue: r.inValue,
      outQty: r.outQty,
      outValue: r.outValue,
      closingQty: r.closingQty,
      closingValue: r.closingValue,
    })),
    totals: [
      {
        name: t('المجموع', 'Total'),
        openingValue: data.totals.openingValue,
        inValue: data.totals.inValue,
        outValue: data.totals.outValue,
        closingValue: data.totals.closingValue,
      },
    ],
  };
}

/** Item ledger JSON → export table: opening position, movements, totals, closing position. */
export function itemLedgerTable(
  data: ItemLedger,
  lang: Lang,
  q: { from?: string; to?: string },
  wh: WarehouseLabel,
): ReportTable {
  const t = (ar: string, en: string) => L({ lang }, ar, en);
  const opening = [
    { source: t('رصيد أول المدة', 'Opening balance'), totalCost: data.opening.value, balance: data.opening.qty, _bold: true },
  ];
  return {
    title: `${t('بطاقة صنف', 'Item card')}: ${data.item.code} ${localName(lang, data.item.nameAr, data.item.nameEn)}`,
    meta: [warehouseMeta(lang, wh), periodMeta(lang, q.from || null, q.to || null)],
    fileName: `item-ledger-${data.item.code}`,
    orientation: 'landscape',
    columns: [
      { key: 'date', label: t('التاريخ', 'Date'), kind: 'date' },
      { key: 'warehouse', label: t('المستودع', 'Warehouse'), width: 60 },
      { key: 'source', label: t('المصدر', 'Source') },
      { key: 'qtyIn', label: t('وارد', 'In'), kind: 'qty', width: 64 },
      { key: 'qtyOut', label: t('صادر', 'Out'), kind: 'qty', width: 64 },
      { key: 'unitCost', label: t('تكلفة الوحدة', 'Unit cost'), kind: 'amount' },
      { key: 'totalCost', label: t('إجمالي التكلفة', 'Total cost'), kind: 'amount' },
      { key: 'balance', label: t('الرصيد بعد الحركة', 'Balance after'), kind: 'qty', width: 70 },
    ],
    rows: [
      ...opening,
      ...data.rows.map((r) => ({
        date: isoDate(r.movementDate),
        warehouse: r.warehouse.code,
        source: r.sourceId ? `${r.sourceType} #${r.sourceId}` : r.sourceType,
        qtyIn: r.qtyIn,
        qtyOut: r.qtyOut,
        unitCost: r.unitCost,
        totalCost: r.totalCost,
        balance: r.balanceQtyAfter,
      })),
    ],
    totals: [
      { source: t('المجموع', 'Total'), qtyIn: data.totals.qtyIn, qtyOut: data.totals.qtyOut },
      { source: t('رصيد آخر المدة', 'Closing balance'), totalCost: data.closing.value, balance: data.closing.qty },
    ],
  };
}
