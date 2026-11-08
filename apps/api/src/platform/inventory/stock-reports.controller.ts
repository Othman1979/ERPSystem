import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockReportsService } from './stock-reports.service.js';

@ApiTags('stock-reports')
@Controller('stock')
export class StockReportsController {
  constructor(
    private readonly reports: StockReportsService,
    private readonly ledger: StockLedgerService,
  ) {}

  @Get('balances')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  balances(
    @Query('warehouseId') warehouseId?: string,
    @Query('itemId') itemId?: string,
    @Query('lowStock') lowStock?: string,
  ) {
    return this.reports.balances({ warehouseId, itemId, lowStock });
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
  itemLedger(
    @Param('itemId') itemId: string,
    @Query('warehouseId') warehouseId?: string,
    @Query('sourceType') sourceType?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reports.itemLedger(itemId, { warehouseId, sourceType, from, to });
  }

  @Get('valuation')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  valuation(@Query('warehouseId') warehouseId?: string) {
    return this.reports.valuation(warehouseId);
  }

  /** Recomputes stock_balances from stock_movements — integrity check. */
  @Get('verify')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  verify() {
    return this.ledger.verify();
  }
}
