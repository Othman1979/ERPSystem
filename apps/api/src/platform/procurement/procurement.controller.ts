import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import {
  ConvertPurchaseRequestDto,
  CreatePurchaseOrderDto,
  CreatePurchaseQuoteDto,
  CreatePurchaseRequestDto,
  ListPurchaseOrdersQueryDto,
  ListPurchaseQuotesQueryDto,
  ListPurchaseRequestsQueryDto,
  ReasonDto,
  ReceivePurchaseQuoteDto,
  UpdatePurchaseOrderDto,
  UpdatePurchaseQuoteDto,
} from './dto/procurement.dto.js';
import {
  ConvertedOrdersDto,
  PurchaseComparisonDto,
  PurchaseOrderDetailDto,
  PurchaseOrderListItemDto,
  PurchaseQuoteDetailDto,
  PurchaseQuoteListItemDto,
  PurchaseRequestDetailDto,
  PurchaseRequestListItemDto,
} from './dto/procurement-response.dto.js';
import { purchaseOrderPrint, purchaseQuotePrint } from './procurement.print.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchaseQuotesService } from './purchase-quotes.service.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

/**
 * Phase 12 (ADR-025): purchase requests and requests for quotation (FULL
 * level), purchase orders (MEDIUM and FULL). Reads need tenant.read and stay
 * open at any level (history); every write checks the level on the server.
 * Every state change takes an Idempotency-Key (§15).
 */
@ApiTags('procurement')
@Controller()
export class ProcurementController {
  constructor(
    private readonly requests: PurchaseRequestsService,
    private readonly quotes: PurchaseQuotesService,
    private readonly orders: PurchaseOrdersService,
    private readonly printing: PrintingService,
  ) {}

  // ---------------------------------------------------- purchase requests

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('purchase-requests')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(PurchaseRequestListItemDto)
  listRequests(@Query() q: ListPurchaseRequestsQueryDto) {
    return this.requests.list(q);
  }

  @Get('purchase-requests/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PurchaseRequestDetailDto })
  getRequest(@Param('id', ParseIdPipe) id: string) {
    return this.requests.get(BigInt(id));
  }

  @Post('purchase-requests')
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  createRequest(@Body() dto: CreatePurchaseRequestDto) {
    return this.requests.create(dto);
  }

  @Put('purchase-requests/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiOkResponse({ type: PurchaseRequestDetailDto })
  updateRequest(@Param('id', ParseIdPipe) id: string, @Body() dto: CreatePurchaseRequestDto) {
    return this.requests.update(BigInt(id), dto);
  }

  @Delete('purchase-requests/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteRequest(@Param('id', ParseIdPipe) id: string) {
    return this.requests.deleteDraft(BigInt(id));
  }

  @Post('purchase-requests/:id/submit')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_REQUEST_MANAGE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  submitRequest(@Param('id', ParseIdPipe) id: string) {
    return this.requests.submit(BigInt(id));
  }

  @Post('purchase-requests/:id/approve')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  approveRequest(@Param('id', ParseIdPipe) id: string) {
    return this.requests.approve(BigInt(id));
  }

  @Post('purchase-requests/:id/reject')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  rejectRequest(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.requests.reject(BigInt(id), dto.reason);
  }

  @Post('purchase-requests/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  cancelRequest(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.requests.cancel(BigInt(id), dto.reason);
  }

  @Post('purchase-requests/:id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseRequestDetailDto })
  closeRequest(@Param('id', ParseIdPipe) id: string) {
    return this.requests.close(BigInt(id));
  }

  /** The received quotes' prices per request line (ADR-025 §10). */
  @Get('purchase-requests/:id/comparison')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PurchaseComparisonDto })
  comparison(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.comparison(BigInt(id));
  }

  /** «Create orders»: the chosen quote lines, one draft order per supplier (ADR-025 §10). */
  @Post('purchase-requests/:id/convert')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: ConvertedOrdersDto })
  convertRequest(@Param('id', ParseIdPipe) id: string, @Body() dto: ConvertPurchaseRequestDto) {
    return this.orders.convert(BigInt(id), dto);
  }

  // ----------------------------------------------- requests for quotation

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('purchase-quotes')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(PurchaseQuoteListItemDto)
  listQuotes(@Query() q: ListPurchaseQuotesQueryDto) {
    return this.quotes.list(q);
  }

  @Get('purchase-quotes/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PurchaseQuoteDetailDto })
  getQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.get(BigInt(id));
  }

  /** The request for quotation, to send to the supplier (ADR-025 §14). */
  @Get('purchase-quotes/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async quotePdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(purchaseQuotePrint(await this.quotes.get(BigInt(id)), lang), lang);
  }

  @Post('purchase-quotes')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseQuoteDetailDto })
  createQuote(@Body() dto: CreatePurchaseQuoteDto) {
    return this.quotes.create(dto);
  }

  @Put('purchase-quotes/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiOkResponse({ type: PurchaseQuoteDetailDto })
  updateQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdatePurchaseQuoteDto) {
    return this.quotes.update(BigInt(id), dto);
  }

  @Delete('purchase-quotes/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.deleteDraft(BigInt(id));
  }

  @Post('purchase-quotes/:id/send')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseQuoteDetailDto })
  sendQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.send(BigInt(id));
  }

  @Post('purchase-quotes/:id/receive')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseQuoteDetailDto })
  receiveQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: ReceivePurchaseQuoteDto) {
    return this.quotes.receive(BigInt(id), dto);
  }

  @Post('purchase-quotes/:id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseQuoteDetailDto })
  closeQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.close(BigInt(id));
  }

  @Post('purchase-quotes/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseQuoteDetailDto })
  cancelQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.quotes.cancel(BigInt(id), dto.reason);
  }

  // ------------------------------------------------------ purchase orders

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('purchase-orders')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(PurchaseOrderListItemDto)
  listOrders(@Query() q: ListPurchaseOrdersQueryDto) {
    return this.orders.list(q);
  }

  @Get('purchase-orders/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PurchaseOrderDetailDto })
  getOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.get(BigInt(id));
  }

  /** The order, to send to the supplier (ADR-025 §14). */
  @Get('purchase-orders/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async orderPdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(purchaseOrderPrint(await this.orders.get(BigInt(id)), lang), lang);
  }

  @Post('purchase-orders')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  createOrder(@Body() dto: CreatePurchaseOrderDto) {
    return this.orders.create(dto);
  }

  @Put('purchase-orders/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiOkResponse({ type: PurchaseOrderDetailDto })
  updateOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdatePurchaseOrderDto) {
    return this.orders.update(BigInt(id), dto);
  }

  @Delete('purchase-orders/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.deleteDraft(BigInt(id));
  }

  @Post('purchase-orders/:id/submit')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  submitOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.submit(BigInt(id));
  }

  @Post('purchase-orders/:id/approve')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  approveOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.approve(BigInt(id));
  }

  @Post('purchase-orders/:id/reject')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_APPROVE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  rejectOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.reject(BigInt(id), dto.reason);
  }

  @Post('purchase-orders/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  cancelOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(BigInt(id), dto.reason);
  }

  /** ADR-026 §6: closes an approved or partly received order by hand, with a reason; nothing is received after. */
  @Post('purchase-orders/:id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  @ApiCreatedResponse({ type: PurchaseOrderDetailDto })
  closeOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.close(BigInt(id), dto.reason);
  }
}
