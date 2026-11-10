import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { PrintingService } from '../printing/printing.service.js';
import { ItemLedgerQueryDto, StockBalancesQueryDto, StockValuationQueryDto } from './dto/stock-reports.dto.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockReportsService } from './stock-reports.service.js';
import { itemLedgerTable, stockBalancesTable, stockValuationTable } from './stock-reports.table.js';

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
  async balances(@Query() q: StockBalancesQueryDto) {
    const data = await this.reports.balances(q);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => stockBalancesTable(d, lang, wh, q.lowStock === 'true'));
  }

  @Get('movements')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  movements(
    @Query('warehouseId') warehouseId?: string,
    @Query('itemId') itemId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.reports.movements({
      warehouseId,
      itemId,
      sourceType,
      from,
      to,
      page,
      pageSize,
    });
  }

  /** Per-item movement ledger with running balance and WAC. */
  @Get('items/:itemId/ledger')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  async itemLedger(@Param('itemId') itemId: string, @Query() q: ItemLedgerQueryDto) {
    const data = await this.reports.itemLedger(itemId, q);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => itemLedgerTable(d, lang, q, wh));
  }

  @Get('valuation')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  async valuation(@Query() q: StockValuationQueryDto) {
    const data = await this.reports.valuation(q.warehouseId || undefined);
    const wh = await this.warehouseLabel(q);
    return this.printing.respond(data, q, (d, lang) => stockValuationTable(d, lang, wh));
  }

  /** Recomputes stock_balances from stock_movements — integrity check. */
  @Get('verify')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  verify() {
    return this.ledger.verify();
  }
}
