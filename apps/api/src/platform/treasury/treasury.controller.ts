import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { CashAccountsService } from './cash-accounts.service.js';
import { VouchersService } from './vouchers.service.js';
import {
  CreateBankAccountDto,
  CreateCashBoxDto,
  CreatePaymentDto,
  CreateReceiptDto,
} from './dto/treasury.dto.js';

@ApiTags('treasury')
@Controller()
export class TreasuryController {
  constructor(
    private readonly cashAccounts: CashAccountsService,
    private readonly vouchers: VouchersService,
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
}
