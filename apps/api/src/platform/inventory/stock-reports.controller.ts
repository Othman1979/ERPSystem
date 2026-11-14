import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse, ApiKeysetResponse } from '../../common/openapi/responses.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import {
  ItemBalancesReportDto,
  ItemLedgerPageDto,
  StockReportBalanceDto,
  StockReportMovementDto,
  StockValuationReportDto,
  StockVerifyResultDto,
} from './dto/inventory-response.dto.js';
import {
  ItemBalancesQueryDto,
  ItemLedgerQueryDto,
  StockBalancesQueryDto,
  StockMovementsQueryDto,
  StockValuationQueryDto,
} from './dto/stock-reports.dto.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockReportsService } from './stock-reports.service.js';
import { itemBalancesTable, itemLedgerTable, stockBalancesTable, stockValuationTable } from './stock-reports.table.js';

@ApiTags('stock-reports')
@Controller('stock')
export class StockReportsController {
  constructor(
    private readonly reports: StockReportsService,
    private readonly ledger: StockLedgerService,
    private readonly printing: PrintingService,
  ) {}

  /** Warehouse code / name for an export header (none for JSON or without the filter). */
  private async warehouseLabel(q: { format?: string; warehouseId?: string }) {
    if (!q.format || q.format === 'json' || !q.warehouseId) return null;
    return this.reports.warehouseSummary(q.warehouseId);
  }

  @Get('balances')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    { type: StockReportBalanceDto, isArray: true },
    'JSON array of on-hand rows; a PDF or xlsx file with format=pdf|xlsx.',
  )
  async balances(@Query() q: StockBalancesQueryDto) {
    const data = await this.reports.balances(q);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => stockBalancesTable(d, lang, wh, q.lowStock === 'true'));
  }

  /** Movement ledger, newest first, read by keyset (ADR-022 §4): `{ items, nextCursor }`. */
  @Get('movements')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiKeysetResponse(StockReportMovementDto)
  movements(@Query() q: StockMovementsQueryDto) {
    return this.reports.movements(q);
  }

  /**
   * Item card (ADR-022 §4): ascending keyset pages, `{ item, summary, items, nextCursor }`,
   * `summary` on the first page only. format=pdf|xlsx reads the whole card instead.
   */
  @Get('items/:itemId/ledger')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ItemLedgerPageDto,
    'Item card page as JSON; a PDF or xlsx file with format=pdf|xlsx.',
  )
  async itemLedger(@Param('itemId', ParseIdPipe) itemId: string, @Query() q: ItemLedgerQueryDto) {
    if (!q.format || q.format === 'json') return this.reports.itemLedgerPage(itemId, q);
    const data = await this.reports.itemLedger(itemId, q);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => itemLedgerTable(d, lang, q, wh));
  }

  /** Items balance (ميزان المواد): opening, ins, outs, closing per item (ADR-008). */
  @Get('item-balances')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ItemBalancesReportDto,
    'Item balances as JSON; a PDF or xlsx file with format=pdf|xlsx.',
  )
  async itemBalances(@Query() q: ItemBalancesQueryDto) {
    const data = await this.reports.itemBalances({
      warehouseId: q.warehouseId || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
    });
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => itemBalancesTable(d, lang, q, wh));
  }

  @Get('valuation')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    StockValuationReportDto,
    'Valuation as JSON; a PDF or xlsx file with format=pdf|xlsx.',
  )
  async valuation(@Query() q: StockValuationQueryDto) {
    const data = await this.reports.valuation(q.warehouseId || undefined);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => stockValuationTable(d, lang, wh));
  }

  /** Recomputes stock_balances from stock_movements — integrity check. Company-wide: every branch only (ADR-003 §13). */
  @Get('verify')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @RequireAllBranches()
  @ApiOkResponse({ type: StockVerifyResultDto })
  verify() {
    return this.ledger.verify();
  }
}
