import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { PurchaseInvoicesService } from '../purchases/purchase-invoices.service.js';
import { PurchaseReturnsService } from '../purchases/purchase-returns.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { SalesReturnsService } from '../sales/sales-returns.service.js';
import type { DocumentSummaryRow, SummaryGroupBy } from '../shared/document-summary.js';
import { ReportPeriods, utcDate } from './report-periods.service.js';

type Kind = 'sales' | 'purchases';
type GroupBy = 'day' | 'month' | 'customer' | 'supplier' | 'item';

interface Acc {
  invoiceCount: number;
  returnCount: number;
  qty: Decimal;
  net: Decimal;
  tax: Decimal;
  grand: Decimal;
  cost: Decimal;
}
const zero = (): Acc => ({
  invoiceCount: 0,
  returnCount: 0,
  qty: new Decimal(0),
  net: new Decimal(0),
  tax: new Decimal(0),
  grand: new Decimal(0),
  cost: new Decimal(0),
});

/**
 * Sales and purchases summaries (Phase 8): posted invoices − posted returns
 * (each by its own date) through the documents' `summary()`, grouped by
 * day, month, party or item. Sales rows also carry cost and margin
 * (net − cost). Counts are documents; when grouped by item they are null
 * and `qty` is the base quantity instead.
 */
@Injectable()
export class TradeSummaryService {
  constructor(
    private readonly salesInvoices: SalesInvoicesService,
    private readonly salesReturns: SalesReturnsService,
    private readonly purchaseInvoices: PurchaseInvoicesService,
    private readonly purchaseReturns: PurchaseReturnsService,
    private readonly periods: ReportPeriods,
  ) {}

  sales(q: { from?: string; to?: string; groupBy?: GroupBy }) {
    return this.summary('sales', q);
  }

  purchases(q: { from?: string; to?: string; groupBy?: GroupBy }) {
    return this.summary('purchases', q);
  }

  private async summary(kind: Kind, q: { from?: string; to?: string; groupBy?: GroupBy }) {
    const period = await this.periods.period(q);
    const range = { from: utcDate(period.from), to: utcDate(period.to) };
    const groupBy: GroupBy = q.groupBy ?? 'month';
    const by: SummaryGroupBy = groupBy === 'customer' || groupBy === 'supplier' ? 'party' : groupBy;
    const [invoices, returns] =
      kind === 'sales'
        ? await Promise.all([this.salesInvoices.summary(range, by), this.salesReturns.summary(range, by)])
        : await Promise.all([this.purchaseInvoices.summary(range, by), this.purchaseReturns.summary(range, by)]);

    const rows = new Map<string, { head: DocumentSummaryRow; acc: Acc }>();
    const add = (list: DocumentSummaryRow[], sign: 1 | -1) => {
      for (const r of list) {
        const row = rows.get(r.key) ?? { head: r, acc: zero() };
        rows.set(r.key, row);
        const a = row.acc;
        if (sign === 1) a.invoiceCount += r.count;
        else a.returnCount += r.count;
        a.qty = a.qty.plus(r.qty.times(sign));
        a.net = a.net.plus(r.net.times(sign));
        a.tax = a.tax.plus(r.tax.times(sign));
        a.grand = a.grand.plus(r.grand.times(sign));
        a.cost = a.cost.plus(r.cost.times(sign));
      }
    };
    add(invoices, 1);
    add(returns, -1);

    const byItem = by === 'item';
    const format = (a: Acc) => ({
      invoiceCount: byItem ? null : a.invoiceCount,
      returnCount: byItem ? null : a.returnCount,
      ...(byItem ? { qty: a.qty.toString() } : {}),
      net: a.net.toFixed(3),
      tax: a.tax.toFixed(3),
      grand: a.grand.toFixed(3),
      ...(kind === 'sales' ? { cost: a.cost.toFixed(3), margin: a.net.minus(a.cost).toFixed(3) } : {}),
    });

    const total = zero();
    const list = [...rows.values()];
    for (const { acc } of list) {
      total.invoiceCount += acc.invoiceCount;
      total.returnCount += acc.returnCount;
      total.qty = total.qty.plus(acc.qty);
      total.net = total.net.plus(acc.net);
      total.tax = total.tax.plus(acc.tax);
      total.grand = total.grand.plus(acc.grand);
      total.cost = total.cost.plus(acc.cost);
    }
    const sortKey = (r: { head: DocumentSummaryRow }) => (by === 'day' || by === 'month' ? r.head.key : (r.head.ref?.code ?? r.head.key));
    list.sort((x, y) => sortKey(x).localeCompare(sortKey(y)));

    return {
      from: period.from,
      to: period.to,
      groupBy,
      rows: list.map(({ head, acc }) => ({
        key: head.key,
        code: head.ref?.code ?? null,
        nameAr: head.ref?.nameAr ?? null,
        nameEn: head.ref?.nameEn ?? null,
        ...format(acc),
      })),
      totals: format(total),
    };
  }
}
