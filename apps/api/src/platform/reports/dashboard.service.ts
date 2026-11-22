import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { Decimal } from '../../common/decimal/decimal.utils.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { StockReportsService } from '../inventory/stock-reports.service.js';
import { JournalService } from '../journal/journal.service.js';
import { ReportsService } from '../journal/reports.service.js';
import { PurchaseInvoicesService } from '../purchases/purchase-invoices.service.js';
import { SalesInvoicesService } from '../sales/sales-invoices.service.js';
import { ChequesService } from '../treasury/cheques.service.js';
import { TreasuryReportsService } from '../treasury/treasury-reports.service.js';
import { VouchersService } from '../treasury/vouchers.service.js';
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
    private readonly ledger: ReportsService,
    private readonly cheques: ChequesService,
    private readonly journal: JournalService,
    private readonly salesInvoices: SalesInvoicesService,
    private readonly purchaseInvoices: PurchaseInvoicesService,
    private readonly vouchers: VouchersService,
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
    const months = this.lastMonths(date);
    const monthly = await Promise.all(
      months.map(async ({ month: key, from, to }) => {
        const totals = await this.ledger.accountTotals(
          { from, to },
          { branchScoped: true, excludeClosing: true },
        );
        const sales = totals
          .filter((row) => row.account.accountType === 'REVENUE')
          .reduce((amount, row) => amount.plus(row.credit).minus(row.debit), new Decimal(0));
        const expenses = totals
          .filter((row) => row.account.accountType === 'EXPENSE')
          .reduce((amount, row) => amount.plus(row.debit).minus(row.credit), new Decimal(0));
        return { month: key, sales: sales.toFixed(3), expenses: expenses.toFixed(3) };
      }),
    );
    const permissions = ClsServiceManager.getClsService<RequestContext>().get('permissions');
    const canReadModules = permissions?.has(PERMISSIONS.TENANT_READ) ?? false;
    const [cashData, chequesDue, journalDrafts, salesDrafts, purchaseDrafts, voucherDrafts] = canReadModules
      ? await Promise.all([
          this.cashBank(date),
          this.cheques.dueWithin(date, this.addDays(date, 7)),
          this.journal.draftCount(),
          this.salesInvoices.draftCount(),
          this.purchaseInvoices.draftCount(),
          this.vouchers.draftCounts(),
        ])
      : [null, null, null, null, null, null];
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
      monthly,
      cashBank: cashData?.rows ?? null,
      cashBankTotal: cashData?.total ?? null,
      receivablesAging: canReadModules
        ? {
            current: t.notDue,
            d1_30: t.d1_30,
            d31_60: t.d31_60,
            d61_90: t.d61_90,
            d90plus: t.d90plus,
          }
        : null,
      chequesDue,
      drafts:
        journalDrafts === null
          ? null
          : {
              journalEntries: journalDrafts,
              salesInvoices: salesDrafts!,
              purchaseInvoices: purchaseDrafts!,
              receipts: voucherDrafts!.receipts,
              payments: voucherDrafts!.payments,
            },
      belowMinimum,
    };
  }

  private async cashBank(date: string) {
    const [accounts, totals] = await Promise.all([
      this.ledger.chart(),
      this.ledger.accountTotals({ to: date }, { branchScoped: true, excludeClosing: true }),
    ]);
    const byId = new Map(totals.map((row) => [row.account.id, row]));
    const rows = accounts
      .filter((account) => account.isPostable && (account.controlType === 'CASH' || account.controlType === 'BANK'))
      .map((account) => {
        const total = byId.get(account.id);
        const balance = (total?.debit ?? new Decimal(0)).minus(total?.credit ?? new Decimal(0));
        return {
          accountId: account.id.toString(),
          code: account.code,
          nameAr: account.nameAr,
          nameEn: account.nameEn,
          balance: balance.toFixed(3),
        };
      });
    const total = rows.reduce((amount, row) => amount.plus(row.balance), new Decimal(0));
    return { rows, total: total.toFixed(3) };
  }

  private lastMonths(date: string): { month: string; from: string; to: string }[] {
    const [year, month] = date.slice(0, 7).split('-').map(Number);
    return Array.from({ length: 6 }, (_, index) => {
      const first = new Date(Date.UTC(year, month - 6 + index, 1));
      const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
      const monthKey = first.toISOString().slice(0, 7);
      const end = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
      return { month: monthKey, from: `${monthKey}-01`, to: monthKey === date.slice(0, 7) ? date : end };
    });
  }

  private addDays(date: string, days: number): string {
    const day = new Date(`${date}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() + days);
    return day.toISOString().slice(0, 10);
  }
}
