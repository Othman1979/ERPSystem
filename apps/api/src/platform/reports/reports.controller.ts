import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
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
  IncomeStatementByCostCenterDto,
  IncomeStatementDto,
  PurchasesSummaryDto,
  REPORT_FILE_TYPES,
  SalesSummaryDto,
  TaxSummaryDto,
} from './dto/reports-response.dto.js';
import { FinancialStatementsService } from './financial-statements.service.js';
import { balanceSheetTable, incomeByCostCenterTable, incomeStatementTable } from './financial-statements.table.js';
import { TaxSummaryService } from './tax-summary.service.js';
import { taxSummaryTable } from './tax-summary.table.js';
import { TradeSummaryService } from './trade-summary.service.js';
import { tradeSummaryTable } from './trade-summary.table.js';

/** Centre columns an income statement by cost centre PDF holds (ADR-024 §1.9); XLSX takes any number. */
export const PDF_MAX_COST_CENTER_COLUMNS = 12;

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

  /** By cost centre, with a "no centre" column (ADR-024 §1.9); company-wide (ADR-003 §13). */
  @Get('reports/income-statement-by-cost-center')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @RequireAllBranches()
  @ApiFileResponse(REPORT_FILE_TYPES, IncomeStatementByCostCenterDto)
  async incomeStatementByCostCenter(@Query() q: PeriodQueryDto) {
    const data = await this.statements.incomeStatementByCostCenter(q);
    // An A4 landscape page fits a dozen amount columns; wider goes to XLSX (no cap there).
    const centres = data.columns.filter((c) => c.costCenterId !== null).length;
    if (q.format === 'pdf' && centres > PDF_MAX_COST_CENTER_COLUMNS) {
      throw new DomainError(
        ErrorCode.REPORT_TOO_LARGE,
        `More than ${PDF_MAX_COST_CENTER_COLUMNS} cost centres have lines in the period: export to Excel or narrow the period.`,
        { limit: PDF_MAX_COST_CENTER_COLUMNS, columns: centres, format: 'xlsx' },
      );
    }
    return this.printing.respond(data, q, incomeByCostCenterTable);
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
