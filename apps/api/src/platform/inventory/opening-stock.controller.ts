import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { SetOpeningStockDto } from './dto/opening-stock.dto.js';
import { OpeningStockService } from './opening-stock.service.js';

/** Opening stock on the item form (ADR-007). */
@ApiTags('stock')
@Controller('items/:id/opening-stock')
export class OpeningStockController {
  constructor(private readonly openingStock: OpeningStockService) {}

  @Get()
  @RequirePermission(PERMISSIONS.TENANT_READ)
  get(@Param('id') id: string) {
    return this.openingStock.get(BigInt(id));
  }

  /** Replaces the item's opening stock (one line per warehouse). */
  @Put()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  set(@Param('id') id: string, @Body() dto: SetOpeningStockDto) {
    return this.openingStock.set(BigInt(id), dto);
  }
}
