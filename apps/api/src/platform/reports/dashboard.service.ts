import { Injectable } from '@nestjs/common';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { StockReportsService } from '../inventory/stock-reports.service.js';
import { TreasuryReportsService } from '../treasury/treasury-reports.service.js';
import { ReportPeriods, utcDate } from './report-periods.service.js';
import { TradeSummaryService } from './trade-summary.service.js';

/**
 * Short dashboard (BUILD_PLAN §17 phase 8): sales of the day and of the
 * month to date (the sales summary's totals: invoices − returns),
 * receivables (the aging totals as of the day) and items below their
 * minimum stock (now — stock levels have no history here).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly trade: TradeSummaryService,
    private readonly treasury: TreasuryReportsService,
    private readonly stock: StockReportsService,
    private readonly periods: ReportPeriods,
  ) {}

  async summary(q: { date?: string }) {
    const date = q.date ?? (await this.periods.today());
    const monthStart = `${date.slice(0, 7)}-01`;
    const [today, month, aging, belowMinimum] = await Promise.all([
      this.trade.sales({ from: date, to: date, groupBy: 'day' }),
      this.trade.sales({ from: monthStart, to: date, groupBy: 'day' }),
      this.treasury.aging('CUSTOMER', utcDate(date)),
      this.stock.belowMinimum(10),
    ]);
    const sales = (s: typeof today) => ({
      from: s.from,
      to: s.to,
      count: s.totals.invoiceCount ?? 0,
      returnCount: s.totals.returnCount ?? 0,
      net: s.totals.net,
      tax: s.totals.tax,
      grand: s.totals.grand,
    });
    const t = aging.totals;
    return {
      date,
      salesToday: sales(today),
      salesMonth: sales(month),
      receivables: {
        total: t.balance,
        overdue: new Decimal(t.d1_30).plus(t.d31_60).plus(t.d61_90).plus(t.d90plus).toFixed(3),
      },
      belowMinimum,
    };
  }
}
