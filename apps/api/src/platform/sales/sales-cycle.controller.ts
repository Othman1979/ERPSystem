import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ApiFileResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { ParseIdPipe } from '../../common/pipes/parse-id.pipe.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import {
  ConvertSalesQuoteDto,
  CreateSalesOrderDto,
  CreateSalesQuoteDto,
  ListSalesOrdersQueryDto,
  ListSalesQuotesQueryDto,
  ReasonDto,
  SalesReservationQueryDto,
  UpdateSalesOrderDto,
  UpdateSalesQuoteDto,
} from './dto/sales-cycle.dto.js';
import { salesOrderPrint, salesQuotePrint } from './sales-cycle.print.js';
import { SalesOrdersService } from './sales-orders.service.js';
import { SalesQuotesService } from './sales-quotes.service.js';

/**
 * Sales quotations and sales orders (ADR-027). Reads need tenant.read and stay
 * open at any level; writes need sales.manage, approvals sales.approve (or an
 * owner). Every state change takes an Idempotency-Key (§8).
 */
@ApiTags('sales-cycle')
@Controller()
export class SalesCycleController {
  constructor(
    private readonly quotes: SalesQuotesService,
    private readonly orders: SalesOrdersService,
    private readonly printing: PrintingService,
  ) {}

  // ------------------------------------------------------------ quotations

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('sales-quotes')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'Numbered page of sales quotes (ADR-022)' })
  listQuotes(@Query() q: ListSalesQuotesQueryDto) {
    return this.quotes.list(q);
  }

  @Get('sales-quotes/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'One sales quote, with its lines and the computed expired flag' })
  getQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.get(BigInt(id));
  }

  /** The quotation to send to the customer (ADR-027 §2). */
  @Get('sales-quotes/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async quotePdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(salesQuotePrint(await this.quotes.get(BigInt(id)), lang), lang);
  }

  @Post('sales-quotes')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The new draft sales quote' })
  createQuote(@Body() dto: CreateSalesQuoteDto) {
    return this.quotes.create(dto);
  }

  @Put('sales-quotes/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The draft sales quote after the update' })
  updateQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateSalesQuoteDto) {
    return this.quotes.update(BigInt(id), dto);
  }

  @Delete('sales-quotes/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.deleteDraft(BigInt(id));
  }

  @Post('sales-quotes/:id/send')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The quote, sent and numbered SQ' })
  sendQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.send(BigInt(id));
  }

  @Post('sales-quotes/:id/accept')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The quote, accepted' })
  acceptQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.accept(BigInt(id));
  }

  @Post('sales-quotes/:id/reject')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The quote, rejected by the customer' })
  rejectQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.quotes.reject(BigInt(id), dto.reason);
  }

  @Post('sales-quotes/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The quote, cancelled with a reason' })
  cancelQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.quotes.cancel(BigInt(id), dto.reason);
  }

  /** A new draft from any quote (ADR-027 §2: a sent quote is cancelled and copied). */
  @Post('sales-quotes/:id/copy')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The new draft copy' })
  copyQuote(@Param('id', ParseIdPipe) id: string) {
    return this.quotes.copy(BigInt(id));
  }

  /** An accepted quote becomes one draft sales order (ADR-027 §2). */
  @Post('sales-quotes/:id/convert')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The draft sales order made from the quote' })
  convertQuote(@Param('id', ParseIdPipe) id: string, @Body() dto: ConvertSalesQuoteDto) {
    return this.orders.fromQuote(BigInt(id), dto);
  }

  // ----------------------------------------------------------------- orders

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('sales-orders')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'Numbered page of sales orders (ADR-022)' })
  listOrders(@Query() q: ListSalesOrdersQueryDto) {
    return this.orders.list(q);
  }

  /** Reserved and available quantities per item in one warehouse (ADR-027 §5); declared before `:id`. */
  @Get('sales-orders/reservation')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'Reserved and available quantities of stock items in a warehouse' })
  reservation(@Query() q: SalesReservationQueryDto) {
    return this.orders.reservation(q);
  }

  @Get('sales-orders/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'One sales order, with its lines' })
  getOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.get(BigInt(id));
  }

  /** The order to print for the customer (ADR-027 §3). */
  @Get('sales-orders/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async orderPdf(@Param('id', ParseIdPipe) id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(salesOrderPrint(await this.orders.get(BigInt(id)), lang), lang);
  }

  @Post('sales-orders')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The new draft sales order' })
  createOrder(@Body() dto: CreateSalesOrderDto) {
    return this.orders.create(dto);
  }

  @Put('sales-orders/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ schema: { type: 'object' }, description: 'The draft sales order after the update' })
  updateOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: UpdateSalesOrderDto) {
    return this.orders.update(BigInt(id), dto);
  }

  @Delete('sales-orders/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.deleteDraft(BigInt(id));
  }

  @Post('sales-orders/:id/confirm')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The order, confirmed (numbered SO) or pending approval' })
  confirmOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.confirm(BigInt(id));
  }

  @Post('sales-orders/:id/approve')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_APPROVE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The pending order, approved and confirmed' })
  approveOrder(@Param('id', ParseIdPipe) id: string) {
    return this.orders.approve(BigInt(id));
  }

  @Post('sales-orders/:id/reject-approval')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_APPROVE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The pending order, back to draft with the reason' })
  rejectOrderApproval(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.rejectApproval(BigInt(id), dto.reason);
  }

  @Post('sales-orders/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The order, cancelled with a reason' })
  cancelOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.cancel(BigInt(id), dto.reason);
  }

  @Post('sales-orders/:id/close')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ schema: { type: 'object' }, description: 'The partly invoiced order, closed with a reason' })
  closeOrder(@Param('id', ParseIdPipe) id: string, @Body() dto: ReasonDto) {
    return this.orders.close(BigInt(id), dto.reason);
  }
}
