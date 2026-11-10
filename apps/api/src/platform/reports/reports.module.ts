import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PurchasesModule } from '../purchases/purchases.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { TreasuryModule } from '../treasury/treasury.module.js';
import { DashboardService } from './dashboard.service.js';
import { FinancialStatementsService } from './financial-statements.service.js';
import { ReportPeriods } from './report-periods.service.js';
import { ReportsController } from './reports.controller.js';
import { TaxSummaryService } from './tax-summary.service.js';
import { TradeSummaryService } from './trade-summary.service.js';

/**
 * Phase 8 reports: income statement, balance sheet, tax / sales / purchases
 * summaries and the dashboard. Owns no table: every figure is read through
 * the exported services of the modules that own the data (module boundary).
 */
@Module({
  imports: [
    SharedModule,
    PrintingModule,
    AccountingModule,
    JournalModule,
    SalesModule,
    PurchasesModule,
    TreasuryModule,
    InventoryModule,
  ],
  controllers: [ReportsController],
  providers: [ReportPeriods, FinancialStatementsService, TaxSummaryService, TradeSummaryService, DashboardService],
})
export class ReportsModule {}
