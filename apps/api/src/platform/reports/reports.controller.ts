import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import { DashboardService } from './dashboard.service.js';
import {
  AsOfQueryDto,
  DashboardQueryDto,
  PeriodQueryDto,
  PurchasesSummaryQueryDto,
  SalesSummaryQueryDto,
} from './dto/reports.dto.js';
import {
  BalanceSheetDto,
  DashboardSummaryDto,
  IncomeStatementDto,
  PurchasesSummaryDto,
  REPORT_FILE_TYPES,
  SalesSummaryDto,
  TaxSummaryDto,
} from './dto/reports-response.dto.js';
import { FinancialStatementsService } from './financial-statements.service.js';
import { balanceSheetTable, incomeStatementTable } from './financial-statements.table.js';
import { TaxSummaryService } from './tax-summary.service.js';
import { taxSummaryTable } from './tax-summary.table.js';
import { TradeSummaryService } from './trade-summary.service.js';
import { tradeSummaryTable } from './trade-summary.table.js';

/** Phase 8 reports; each takes `?format=json|pdf|xlsx&lang=ar|en` (BUILD_PLAN §15). */
@ApiTags('reports')
@Controller()
export class ReportsController {
  constructor(
    private readonly statements: FinancialStatementsService,
    private readonly tax: TaxSummaryService,
    private readonly trade: TradeSummaryService,
    private readonly dashboard: DashboardService,
    private readonly printing: PrintingService,
  ) {}

  /** Company-wide: only for members with every branch (ADR-003 §13). */
  @Get('reports/income-statement')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @RequireAllBranches()
  @ApiFileResponse(REPORT_FILE_TYPES, IncomeStatementDto)
  async incomeStatement(@Query() q: PeriodQueryDto) {
    return this.printing.respond(await this.statements.incomeStatement(q), q, incomeStatementTable);
  }

  /** Company-wide: only for members with every branch (ADR-003 §13). */
  @Get('reports/balance-sheet')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @RequireAllBranches()
  @ApiFileResponse(REPORT_FILE_TYPES, BalanceSheetDto)
  async balanceSheet(@Query() q: AsOfQueryDto) {
    return this.printing.respond(await this.statements.balanceSheet(q), q, balanceSheetTable);
  }

  @Get('reports/tax-summary')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(REPORT_FILE_TYPES, TaxSummaryDto)
  async taxSummary(@Query() q: PeriodQueryDto) {
    return this.printing.respond(await this.tax.taxSummary(q), q, taxSummaryTable);
  }

  @Get('reports/sales-summary')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(REPORT_FILE_TYPES, SalesSummaryDto)
  async salesSummary(@Query() q: SalesSummaryQueryDto) {
    return this.printing.respond(await this.trade.sales(q), q, (d, lang) => tradeSummaryTable(d, lang, 'sales'));
  }

  @Get('reports/purchases-summary')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(REPORT_FILE_TYPES, PurchasesSummaryDto)
  async purchasesSummary(@Query() q: PurchasesSummaryQueryDto) {
    return this.printing.respond(await this.trade.purchases(q), q, (d, lang) => tradeSummaryTable(d, lang, 'purchases'));
  }

  @Get('dashboard/summary')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: DashboardSummaryDto })
  dashboardSummary(@Query() q: DashboardQueryDto) {
    return this.dashboard.summary(q);
  }
}
