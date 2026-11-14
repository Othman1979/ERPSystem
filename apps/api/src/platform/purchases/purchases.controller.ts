import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { purchaseInvoicePrint } from './purchases.print.js';
import { PurchaseInvoicesService } from './purchase-invoices.service.js';
import { PurchaseReturnsService } from './purchase-returns.service.js';
import {
  CreatePurchaseInvoiceDto,
  CreatePurchaseReturnDto,
  ListPurchaseInvoicesQueryDto,
  ListPurchaseReturnsQueryDto,
} from './dto/purchases.dto.js';

@ApiTags('purchases')
@Controller()
export class PurchasesController {
  constructor(
    private readonly invoices: PurchaseInvoicesService,
    private readonly returns: PurchaseReturnsService,
    private readonly printing: PrintingService,
  ) {}

  // ---------------------------------------------------- purchase invoices

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('purchase-invoices')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listInvoices(@Query() q: ListPurchaseInvoicesQueryDto) {
    return this.invoices.list(q);
  }

  @Get('purchase-invoices/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getInvoice(@Param('id') id: string) {
    return this.invoices.get(BigInt(id));
  }

  @Get('purchase-invoices/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  async invoicePdf(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(purchaseInvoicePrint(await this.invoices.get(BigInt(id)), lang), lang);
  }

  @Post('purchase-invoices')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  createInvoice(@Body() dto: CreatePurchaseInvoiceDto) {
    return this.invoices.create(dto);
  }

  @Put('purchase-invoices/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  updateInvoice(@Param('id') id: string, @Body() dto: CreatePurchaseInvoiceDto) {
    return this.invoices.update(BigInt(id), dto);
  }

  @Delete('purchase-invoices/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_MANAGE)
  deleteInvoice(@Param('id') id: string) {
    return this.invoices.deleteDraft(BigInt(id));
  }

  @Post('purchase-invoices/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_POST)
  postInvoice(@Param('id') id: string) {
    return this.invoices.post(BigInt(id));
  }

  // ------------------------------------------------------ purchase returns

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('purchase-returns')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listReturns(@Query() q: ListPurchaseReturnsQueryDto) {
    return this.returns.list(q);
  }

  @Get('purchase-returns/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getReturn(@Param('id') id: string) {
    return this.returns.get(BigInt(id));
  }

  @Post('purchase-returns')
  @RequirePermission(PERMISSIONS.PURCHASE_RETURN)
  createReturn(@Body() dto: CreatePurchaseReturnDto) {
    return this.returns.create(dto);
  }

  @Delete('purchase-returns/:id')
  @RequirePermission(PERMISSIONS.PURCHASE_RETURN)
  deleteReturn(@Param('id') id: string) {
    return this.returns.deleteDraft(BigInt(id));
  }

  @Post('purchase-returns/:id/post')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.PURCHASE_RETURN)
  postReturn(@Param('id') id: string) {
    return this.returns.post(BigInt(id));
  }
}
