import { Injectable } from '@nestjs/common';
import { Decimal, round3 } from '../../common/decimal/decimal.utils.js';
import { StockReportsService } from '../inventory/stock-reports.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';

/**
 * ADR-032 §6: the consumption of a warehouse between two counts. The counts and the movements are
 * read by the inventory service; the recipe split by the sales service (the module that owns the
 * component projection). This service only combines them.
 */
@Injectable()
export class ConsumptionReportService {
  constructor(
    private readonly stock: StockReportsService,
    private readonly sales: SalesInvoicesService,
  ) {}

  async consumption(warehouseId: string, fromCountId: string, toCountId: string) {
    const wh = BigInt(warehouseId);
    const base = await this.stock.countConsumption(wh, BigInt(fromCountId), BigInt(toCountId));
    const recipeOut = await this.sales.recipeOutByItem(wh, base.fromCount.countDate, base.toCount.countDate);
    const rows = base.rows.map((r) => {
      const recipe = recipeOut.get(r.itemId) ?? new Decimal(0);
      const direct = r.outSales.minus(recipe);
      const other = r.outAll.minus(r.outSales);
      const actual = r.openingCounted.plus(r.receipts).minus(r.closingCounted);
      const recorded = r.outAll;
      const variance = actual.minus(recorded);
      return {
        itemId: r.itemId.toString(),
        code: r.code,
        nameAr: r.nameAr,
        nameEn: r.nameEn,
        avgCost: r.avgCost.toFixed(6),
        openingCounted: r.openingCounted.toFixed(6),
        receipts: r.receipts.toFixed(6),
        closingCounted: r.closingCounted.toFixed(6),
        actual: actual.toFixed(6),
        recorded: recorded.toFixed(6),
        recipeOut: recipe.toFixed(6),
        directSales: direct.toFixed(6),
        otherOut: other.toFixed(6),
        variance: variance.toFixed(6),
        actualValue: round3(actual.times(r.avgCost)).toFixed(3),
        recordedValue: round3(recorded.times(r.avgCost)).toFixed(3),
        varianceValue: round3(variance.times(r.avgCost)).toFixed(3),
      };
    });
    const sumOf = (key: 'actualValue' | 'recordedValue' | 'varianceValue') =>
      rows.reduce((acc, r) => acc.plus(r[key]), new Decimal(0)).toFixed(3);
    return {
      warehouseId: wh.toString(),
      fromCount: { id: base.fromCount.id.toString(), countDate: isoDay(base.fromCount.countDate) },
      toCount: { id: base.toCount.id.toString(), countDate: isoDay(base.toCount.countDate) },
      rows,
      totals: { actualValue: sumOf('actualValue'), recordedValue: sumOf('recordedValue'), varianceValue: sumOf('varianceValue') },
    };
  }

  async recipeSalesWithoutBom(from: string, to: string) {
    const rows = await this.sales.recipeSalesWithoutBom(new Date(from), new Date(to));
    return rows.map((r) => ({
      invoiceId: r.invoiceId.toString(),
      invoiceNo: r.invoiceNo,
      invoiceDate: isoDay(r.invoiceDate),
      lineId: r.lineId.toString(),
      lineNo: r.lineNo,
      itemId: r.itemId.toString(),
      itemCode: r.itemCode,
      itemNameAr: r.itemNameAr,
      itemNameEn: r.itemNameEn,
      qtyBase: r.qtyBase.toFixed(6),
      netAmount: r.netAmount.toFixed(3),
    }));
  }
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
