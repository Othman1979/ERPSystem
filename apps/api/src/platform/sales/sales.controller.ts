import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { SalesInvoicesService } from './sales-invoices.service.js';
import { SalesReturnsService } from './sales-returns.service.js';
import { CreateSalesInvoiceDto, CreateSalesReturnDto } from './dto/sales.dto.js';

@ApiTags('sales')
@Controller()
export class SalesController {
  constructor(
    private readonly invoices: SalesInvoicesService,
    private readonly returns: SalesReturnsService,
  ) {}

  // ------------------------------------------------------- sales invoices

  @Get('sales-invoices')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listInvoices(
    @Query('status') status?: string,
    @Query('paymentType') paymentType?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.invoices.list(status, paymentType, customerId);
  }

  @Get('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getInvoice(@Param('id') id: string) {
    return this.invoices.get(BigInt(id));
  }

  @Post('sales-invoices')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  createInvoice(@Body() dto: CreateSalesInvoiceDto) {
    return this.invoices.create(dto);
  }

  @Put('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  updateInvoice(@Param('id') id: string, @Body() dto: CreateSalesInvoiceDto) {
    return this.invoices.update(BigInt(id), dto);
  }

  @Delete('sales-invoices/:id')
  @RequirePermission(PERMISSIONS.SALES_MANAGE)
  deleteInvoice(@Param('id') id: string) {
    return this.invoices.deleteDraft(BigInt(id));
  }

  @Post('sales-invoices/:id/post')
  @RequirePermission(PERMISSIONS.SALES_POST)
  postInvoice(@Param('id') id: string) {
    return this.invoices.post(BigInt(id));
  }

  // --------------------------------------------------------- sales returns

  @Get('sales-returns')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listReturns(@Query('status') status?: string) {
    return this.returns.list(status);
  }

  @Get('sales-returns/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getReturn(@Param('id') id: string) {
    return this.returns.get(BigInt(id));
  }

  @Post('sales-returns')
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  createReturn(@Body() dto: CreateSalesReturnDto) {
    return this.returns.create(dto);
  }

  @Delete('sales-returns/:id')
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  deleteReturn(@Param('id') id: string) {
    return this.returns.deleteDraft(BigInt(id));
  }

  @Post('sales-returns/:id/post')
  @RequirePermission(PERMISSIONS.SALES_RETURN)
  postReturn(@Param('id') id: string) {
    return this.returns.post(BigInt(id));
  }
}
