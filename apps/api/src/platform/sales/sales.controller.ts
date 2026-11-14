import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { SalesInvoicesService } from './sales-invoices.service.js';
import { SalesReturnsService } from './sales-returns.service.js';
import {
  CreateSalesInvoiceDto,
  CreateSalesReturnDto,
  ListSalesInvoicesQueryDto,
  ListSalesReturnsQueryDto,
} from './dto/sales.dto.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { salesInvoicePrint, salesReturnPrint } from './sales.print.js';
import {
  SalesInvoiceDetailDto,
  SalesInvoiceListItemDto,
  SalesReturnDetailDto,
  SalesReturnListItemDto,
} from './dto/sales-response.dto.js';

@ApiTags('sales')
@Controller()
export class SalesController {
  constructor(
    private readonly invoices: SalesInvoicesService,
    private readonly returns: SalesReturnsService,
    private readonly printing: PrintingService,
  ) {}

  // ------------------------------------------------------- sales invoices

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('sales-invoices')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(SalesInvoiceListItemDto)
  listInvoices(@Query() q: ListSalesInvoicesQueryDto) {
    return this.invoices.list(q);
  }

  @Get('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: SalesInvoiceDetailDto })
  getInvoice(@Param('id') id: string) {
    return this.invoices.get(BigInt(id));
  }

  /** Printed invoice (BUILD_PLAN §13.7, §15): A4 PDF with the JoFotara QR; another branch's answers 404 (ADR-003 §11). */
  @Get('sales-invoices/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async invoicePdf(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(salesInvoicePrint(await this.invoices.get(BigInt(id)), lang), lang);
  }

  @Post('sales-invoices')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiCreatedResponse({ type: SalesInvoiceDetailDto })
  createInvoice(@Body() dto: CreateSalesInvoiceDto) {
    return this.invoices.create(dto);
  }

  @Put('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ type: SalesInvoiceDetailDto })
  updateInvoice(@Param('id') id: string, @Body() dto: CreateSalesInvoiceDto) {
    return this.invoices.update(BigInt(id), dto);
  }

  @Delete('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  @ApiOkResponse({ type: DeletedDto })
  deleteInvoice(@Param('id') id: string) {
    return this.invoices.deleteDraft(BigInt(id));
  }

  @Post('sales-invoices/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_POST)
  @ApiCreatedResponse({ type: SalesInvoiceDetailDto })
  postInvoice(@Param('id') id: string) {
    return this.invoices.post(BigInt(id));
  }

  // --------------------------------------------------------- sales returns

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('sales-returns')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(SalesReturnListItemDto)
  listReturns(@Query() q: ListSalesReturnsQueryDto) {
    return this.returns.list(q);
  }

  @Get('sales-returns/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: SalesReturnDetailDto })
  getReturn(@Param('id') id: string) {
    return this.returns.get(BigInt(id));
  }

  @Get('sales-returns/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async returnPdf(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(salesReturnPrint(await this.returns.get(BigInt(id)), lang), lang);
  }

  @Post('sales-returns')
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  @ApiCreatedResponse({ type: SalesReturnDetailDto })
  createReturn(@Body() dto: CreateSalesReturnDto) {
    return this.returns.create(dto);
  }

  @Delete('sales-returns/:id')
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  @ApiOkResponse({ type: DeletedDto })
  deleteReturn(@Param('id') id: string) {
    return this.returns.deleteDraft(BigInt(id));
  }

  @Post('sales-returns/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  @ApiCreatedResponse({ type: SalesReturnDetailDto })
  postReturn(@Param('id') id: string) {
    return this.returns.post(BigInt(id));
  }
}
