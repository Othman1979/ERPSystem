import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CashAccountsService } from './cash-accounts.service.js';
import { CashTransfersService } from './cash-transfers.service.js';
import { TreasuryReportsService } from './treasury-reports.service.js';
import { VouchersService } from './vouchers.service.js';
import {
  AgingQueryDto,
  AllocateVoucherDto,
  CreateBankAccountDto,
  CreateCashBoxDto,
  CreateCashTransferDto,
  CreatePaymentDto,
  CreateReceiptDto,
  ReverseVoucherDto,
} from './dto/treasury.dto.js';

@ApiTags('treasury')
@Controller()
export class TreasuryController {
  constructor(
    private readonly cashAccounts: CashAccountsService,
    private readonly vouchers: VouchersService,
    private readonly transfers: CashTransfersService,
    private readonly reports: TreasuryReportsService,
  ) {}

  // ------------------------------------------------------------- cash boxes

  @Get('cash-boxes')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listCashBoxes() {
    return this.cashAccounts.listCashBoxes();
  }

  @Post('cash-boxes')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  createCashBox(@Body() dto: CreateCashBoxDto) {
    return this.cashAccounts.createCashBox(dto);
  }

  @Put('cash-boxes/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  updateCashBox(@Param('id') id: string, @Body() dto: Partial<CreateCashBoxDto>) {
    return this.cashAccounts.updateCashBox(BigInt(id), dto);
  }

  @Delete('cash-boxes/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  deleteCashBox(@Param('id') id: string) {
    return this.cashAccounts.deleteCashBox(BigInt(id));
  }

  // ---------------------------------------------------------- bank accounts

  @Get('bank-accounts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listBankAccounts() {
    return this.cashAccounts.listBankAccounts();
  }

  @Post('bank-accounts')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  createBankAccount(@Body() dto: CreateBankAccountDto) {
    return this.cashAccounts.createBankAccount(dto);
  }

  @Put('bank-accounts/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  updateBankAccount(@Param('id') id: string, @Body() dto: Partial<CreateBankAccountDto>) {
    return this.cashAccounts.updateBankAccount(BigInt(id), dto);
  }

  @Delete('bank-accounts/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  deleteBankAccount(@Param('id') id: string) {
    return this.cashAccounts.deleteBankAccount(BigInt(id));
  }

  // -------------------------------------------------------------- receipts

  @Get('receipts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listReceipts() {
    return this.vouchers.listReceipts();
  }

  @Get('receipts/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getReceipt(@Param('id') id: string) {
    return this.vouchers.getReceipt(BigInt(id));
  }

  @Post('receipts')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  createReceipt(@Body() dto: CreateReceiptDto) {
    return this.vouchers.createReceipt(dto);
  }

  // -------------------------------------------------------------- payments

  @Get('payments')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listPayments() {
    return this.vouchers.listPayments();
  }

  @Get('payments/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getPayment(@Param('id') id: string) {
    return this.vouchers.getPayment(BigInt(id));
  }

  @Post('payments')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  createPayment(@Body() dto: CreatePaymentDto) {
    return this.vouchers.createPayment(dto);
  }

  // ------------------------------------- Phase 6: reverse, allocate, cancel

  @Post('receipts/:id/reverse')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  reverseReceipt(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.vouchers.reverseVoucher('receipt', BigInt(id), dto);
  }

  @Post('payments/:id/reverse')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  reversePayment(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.vouchers.reverseVoucher('payment', BigInt(id), dto);
  }

  @Post('receipts/:id/allocations')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  allocateReceipt(@Param('id') id: string, @Body() dto: AllocateVoucherDto) {
    return this.vouchers.allocateVoucher('receipt', BigInt(id), dto);
  }

  @Post('payments/:id/allocations')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  allocatePayment(@Param('id') id: string, @Body() dto: AllocateVoucherDto) {
    return this.vouchers.allocateVoucher('payment', BigInt(id), dto);
  }

  @Post('allocations/:id/cancel')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  cancelAllocation(@Param('id') id: string) {
    return this.vouchers.cancelAllocation(BigInt(id));
  }

  // --------------------------------------------------------- cash transfers

  @Get('cash-transfers')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  listCashTransfers() {
    return this.transfers.list();
  }

  @Get('cash-transfers/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  getCashTransfer(@Param('id') id: string) {
    return this.transfers.get(BigInt(id));
  }

  @Post('cash-transfers')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  createCashTransfer(@Body() dto: CreateCashTransferDto) {
    return this.transfers.create(dto);
  }

  @Post('cash-transfers/:id/reverse')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  reverseCashTransfer(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.transfers.reverse(BigInt(id), dto);
  }

  // ---------------------------------------------------------------- reports

  @Get('reports/aging')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  aging(@Query() q: AgingQueryDto) {
    return this.reports.aging(q.partyType);
  }

  @Get('treasury/balances')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  cashBalances() {
    return this.reports.cashBalances();
  }
}
