import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { StockCountLineRow } from '../../common/openapi/prisma-models.js';
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
import {
  ListStockAdjustmentsQueryDto,
  ListStockCountsQueryDto,
  ListStockTransfersQueryDto,
} from './dto/list-queries.dto.js';
import {
  StockAdjustmentDetailDto,
  StockAdjustmentListItemDto,
  StockCountDetailDto,
  StockCountListItemDto,
  StockTransferDetailDto,
  StockTransferListItemDto,
} from './dto/stock-documents-response.dto.js';

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
  @ApiPagedResponse(StockAdjustmentListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  listAdjustments(@Query() q: ListStockAdjustmentsQueryDto) {
    return this.adjustments.list(q);
  }

  @Post('stock-adjustments')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockAdjustmentDetailDto })
  createAdjustment(@Body() dto: CreateStockAdjustmentDto) {
    return this.adjustments.create(dto);
  }

  @Get('stock-adjustments/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: StockAdjustmentDetailDto })
  getAdjustment(@Param('id') id: string) {
    return this.adjustments.get(BigInt(id));
  }

  @Delete('stock-adjustments/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: DeletedDto })
  deleteAdjustment(@Param('id') id: string) {
    return this.adjustments.deleteDraft(BigInt(id));
  }

  @Post('stock-adjustments/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockAdjustmentDetailDto })
  postAdjustment(@Param('id') id: string) {
    return this.adjustments.post(BigInt(id));
  }

  @Post('stock-adjustments/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockAdjustmentDetailDto })
  reverseAdjustment(@Param('id') id: string, @Body() dto: ReverseStockDocumentDto) {
    return this.adjustments.reverse(BigInt(id), new Date(dto.reversalDate));
  }

  // ------------------------------------------------------------ transfers

  @Get('stock-transfers')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(StockTransferListItemDto)
  /** Numbered page (ADR-022); a transfer shows when its source or destination is in the caller's branches. */
  listTransfers(@Query() q: ListStockTransfersQueryDto) {
    return this.transfers.list(q);
  }

  @Post('stock-transfers')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockTransferDetailDto })
  createTransfer(@Body() dto: CreateStockTransferDto) {
    return this.transfers.create(dto);
  }

  @Get('stock-transfers/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: StockTransferDetailDto })
  getTransfer(@Param('id') id: string) {
    return this.transfers.get(BigInt(id));
  }

  @Delete('stock-transfers/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: DeletedDto })
  deleteTransfer(@Param('id') id: string) {
    return this.transfers.deleteDraft(BigInt(id));
  }

  @Post('stock-transfers/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockTransferDetailDto })
  postTransfer(@Param('id') id: string) {
    return this.transfers.post(BigInt(id));
  }

  @Post('stock-transfers/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockTransferDetailDto })
  reverseTransfer(@Param('id') id: string, @Body() dto: ReverseStockDocumentDto) {
    return this.transfers.reverse(BigInt(id), new Date(dto.reversalDate));
  }

  // --------------------------------------------------------------- counts

  @Get('stock-counts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(StockCountListItemDto)
  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  listCounts(@Query() q: ListStockCountsQueryDto) {
    return this.counts.list(q);
  }

  @Post('stock-counts')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockCountDetailDto })
  createCount(@Body() dto: CreateStockCountDto) {
    return this.counts.create(dto);
  }

  @Get('stock-counts/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: StockCountDetailDto })
  getCount(@Param('id') id: string) {
    return this.counts.get(BigInt(id));
  }

  @Delete('stock-counts/:id')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: DeletedDto })
  deleteCount(@Param('id') id: string) {
    return this.counts.deleteDraft(BigInt(id));
  }

  @Put('stock-counts/:id/lines/:lineId')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: StockCountLineRow })
  /** The bare updated line (no item relation), not the whole count. */
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
  @ApiCreatedResponse({ type: StockCountDetailDto })
  refreshCount(@Param('id') id: string) {
    return this.counts.refresh(BigInt(id));
  }

  // Posts the count's adjustment (TRADE-07): keyed like every posting route.
  @Post('stock-counts/:id/approve')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: StockCountDetailDto })
  approveCount(@Param('id') id: string) {
    return this.counts.approve(BigInt(id));
  }
}
