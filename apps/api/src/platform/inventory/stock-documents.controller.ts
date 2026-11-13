import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { TransfersService } from './transfers.service.js';
import {
  CreateStockAdjustmentDto,
  CreateStockCountDto,
  CreateStockTransferDto,
  ReverseStockDocumentDto,
  UpdateCountLineDto,
} from './dto/inventory.dto.js';

@ApiTags('stock')
@Controller()
export class StockDocumentsController {
  constructor(
    private readonly adjustments: AdjustmentsService,
    private readonly transfers: TransfersService,
    private readonly counts: CountsService,
  ) {}

  // ---------------------------------------------------------- adjustments

  @Get('stock-adjustments')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listAdjustments(@Query('status') status?: string) {
    return this.adjustments.list(status);
  }

  @Post('stock-adjustments')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  createAdjustment(@Body() dto: CreateStockAdjustmentDto) {
    return this.adjustments.create(dto);
  }

  @Get('stock-adjustments/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getAdjustment(@Param('id') id: string) {
    return this.adjustments.get(BigInt(id));
  }

  @Delete('stock-adjustments/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  deleteAdjustment(@Param('id') id: string) {
    return this.adjustments.deleteDraft(BigInt(id));
  }

  @Post('stock-adjustments/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  postAdjustment(@Param('id') id: string) {
    return this.adjustments.post(BigInt(id));
  }

  @Post('stock-adjustments/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  reverseAdjustment(@Param('id') id: string, @Body() dto: ReverseStockDocumentDto) {
    return this.adjustments.reverse(BigInt(id), new Date(dto.reversalDate));
  }

  // ------------------------------------------------------------ transfers

  @Get('stock-transfers')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listTransfers(@Query('status') status?: string) {
    return this.transfers.list(status);
  }

  @Post('stock-transfers')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  createTransfer(@Body() dto: CreateStockTransferDto) {
    return this.transfers.create(dto);
  }

  @Get('stock-transfers/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getTransfer(@Param('id') id: string) {
    return this.transfers.get(BigInt(id));
  }

  @Delete('stock-transfers/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  deleteTransfer(@Param('id') id: string) {
    return this.transfers.deleteDraft(BigInt(id));
  }

  @Post('stock-transfers/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  postTransfer(@Param('id') id: string) {
    return this.transfers.post(BigInt(id));
  }

  @Post('stock-transfers/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  reverseTransfer(@Param('id') id: string, @Body() dto: ReverseStockDocumentDto) {
    return this.transfers.reverse(BigInt(id), new Date(dto.reversalDate));
  }

  // --------------------------------------------------------------- counts

  @Get('stock-counts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listCounts(@Query('status') status?: string) {
    return this.counts.list(status);
  }

  @Post('stock-counts')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  createCount(@Body() dto: CreateStockCountDto) {
    return this.counts.create(dto);
  }

  @Get('stock-counts/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getCount(@Param('id') id: string) {
    return this.counts.get(BigInt(id));
  }

  @Delete('stock-counts/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  deleteCount(@Param('id') id: string) {
    return this.counts.deleteDraft(BigInt(id));
  }

  @Put('stock-counts/:id/lines/:lineId')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  updateCountLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateCountLineDto,
  ) {
    return this.counts.updateLine(BigInt(id), BigInt(lineId), dto);
  }

  /** Re-takes the book-balance snapshot of a draft count (after STOCK_COUNT_STALE). */
  @Post('stock-counts/:id/refresh')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  refreshCount(@Param('id') id: string) {
    return this.counts.refresh(BigInt(id));
  }

  // Posts the count's adjustment (TRADE-07): keyed like every posting route.
  @Post('stock-counts/:id/approve')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  approveCount(@Param('id') id: string) {
    return this.counts.approve(BigInt(id));
  }
}
