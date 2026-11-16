import { Body, Controller, Delete, Get, Param, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { SHEET_IMPORT_MAX_BYTES, type UploadedSheet } from './count-sheet-import.js';
import { sheetTable, varianceTable } from './stock-counts-table.js';
import { TransfersService } from './transfers.service.js';
import {
  AddCountLineDto,
  CreateStockAdjustmentDto,
  CreateStockCountDto,
  ScanCountDto,
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
  StockCountLineDto,
  StockCountListItemDto,
  StockCountSheetDto,
  StockCountVarianceDto,
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
    private readonly printing: PrintingService,
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

  /** Adds an item found on the shelf to a DRAFT count (ADR-030 §7). */
  @Post('stock-counts/:id/lines')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockCountLineDto })
  addCountLine(@Param('id') id: string, @Body() dto: AddCountLineDto) {
    return this.counts.addLine(BigInt(id), dto);
  }

  /** The counted quantity of one line, in the unit given (ADR-030 §8). */
  @Put('stock-counts/:id/lines/:lineId')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiOkResponse({ type: StockCountLineDto })
  updateCountLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateCountLineDto,
  ) {
    return this.counts.updateLine(BigInt(id), BigInt(lineId), dto);
  }

  /** One barcode scan: adds one of its unit to the line (ADR-030 §9). Keyed: a replay adds once. */
  @Post('stock-counts/:id/scan')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: StockCountLineDto })
  scanCount(@Param('id') id: string, @Body() dto: ScanCountDto) {
    return this.counts.scan(BigInt(id), dto);
  }

  /** Re-takes the book qty at the count date of every line (informational while counting). */
  @Post('stock-counts/:id/refresh')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @ApiCreatedResponse({ type: StockCountDetailDto })
  refreshCount(@Param('id') id: string) {
    return this.counts.refresh(BigInt(id));
  }

  /** Closes the counting: DRAFT to SUBMITTED (ADR-030 §5). Keyed. */
  @Post('stock-counts/:id/submit')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: StockCountDetailDto })
  submitCount(@Param('id') id: string) {
    return this.counts.submit(BigInt(id));
  }

  /** Brings a submitted count back to counting: SUBMITTED to DRAFT (ADR-030 §5). Keyed. */
  @Post('stock-counts/:id/reopen')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: StockCountDetailDto })
  reopenCount(@Param('id') id: string) {
    return this.counts.reopen(BigInt(id));
  }

  // Posts the count's adjustment (ADR-030 §1, §3): keyed like every posting route.
  @Post('stock-counts/:id/approve')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @RequiresIdempotencyKey()
  @ApiCreatedResponse({ type: StockCountDetailDto })
  approveCount(@Param('id') id: string) {
    return this.counts.approve(BigInt(id));
  }

  /** The count sheet: JSON, or a PDF or xlsx file (ADR-030 §11). The book column is withheld while blind. */
  @Get('stock-counts/:id/sheet')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    StockCountSheetDto,
    'The sheet as JSON, or a PDF or xlsx file with format=pdf|xlsx.',
  )
  async countSheet(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const data = await this.counts.sheet(BigInt(id));
    return this.printing.respond(data, q, (d, lang) => sheetTable(d, lang));
  }

  /** Fills the counted quantities from an xlsx sheet, all or nothing (ADR-030 §11). */
  @Post('stock-counts/:id/import')
  @RequirePermission(PERMISSIONS.STOCK_MOVEMENT)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: SHEET_IMPORT_MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } })
  @ApiCreatedResponse({ type: StockCountDetailDto })
  async importCount(@Param('id') id: string, @UploadedFile() file: UploadedSheet | undefined) {
    return this.counts.importSheet(BigInt(id), file);
  }

  /** The difference report: JSON, or a PDF or xlsx file (ADR-030 §12). Not while a blind count is a draft. */
  @Get('stock-counts/:id/variance')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(
    ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    StockCountVarianceDto,
    'The difference report as JSON, or a PDF or xlsx file with format=pdf|xlsx.',
  )
  async countVariance(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const data = await this.counts.variance(BigInt(id));
    return this.printing.respond(data, q, (d, lang) => varianceTable(d, lang));
  }
}
