import { Injectable } from '@nestjs/common';
import { ReportsService } from '../journal/reports.service.js';
import { DocumentSupportService } from '../shared/document-support.service.js';
import { dayBefore, ReportPeriods } from './report-periods.service.js';
import { balanceSheet, incomeStatement } from './statements.js';

/**
 * Income statement and balance sheet (Phase 8). Both read the journal's
 * `accountTotals` — the trial balance's own query — so the three agree by
 * construction; formulas in statements.ts.
 */
@Injectable()
export class FinancialStatementsService {
  constructor(
    private readonly ledger: ReportsService,
    private readonly periods: ReportPeriods,
    private readonly support: DocumentSupportService,
  ) {}

  /** Mapped cost-of-sales accounts; a missing mapping just leaves its line out. */
  private async costAccounts() {
    const { tenantId, db } = this.support.tenant();
    const companyId = await this.support.companyId(db);
    const pick = async (key: string) =>
      (await this.support.mappingAccounts(db, tenantId, companyId, [key]).catch(() => ({}) as Record<string, bigint>))[key];
    const [cogs, inventoryAdjustment] = await Promise.all([pick('COGS'), pick('INVENTORY_ADJUSTMENT')]);
    return { cogs, inventoryAdjustment };
  }

  /** `?from&to`, default the fiscal year containing today. */
  async incomeStatement(q: { from?: string; to?: string }) {
    const period = await this.periods.period(q);
    const [chart, totals, mapped] = await Promise.all([
      this.ledger.chart(),
      this.ledger.accountTotals({ from: period.from, to: period.to }),
      this.costAccounts(),
    ]);
    return { from: period.from, to: period.to, fiscalYear: period.fiscalYear, ...incomeStatement(chart, totals, mapped) };
  }

  /** `?asOf`, default today; the year profit runs from the start of the fiscal year containing asOf. */
  async balanceSheet(q: { asOf?: string }) {
    const asOf = q.asOf ?? (await this.periods.today());
    const year = await this.periods.yearStart(asOf);
    const [chart, asOfTotals, priorTotals, yearTotals] = await Promise.all([
      this.ledger.chart(),
      this.ledger.accountTotals({ to: asOf }),
      this.ledger.accountTotals({ to: dayBefore(year.start) }),
      this.ledger.accountTotals({ from: year.start, to: asOf }),
    ]);
    return {
      asOf,
      yearStart: year.start,
      fiscalYear: year.fiscalYear,
      ...balanceSheet(chart, asOfTotals, priorTotals, yearTotals),
    };
  }
}
