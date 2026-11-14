import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/auth.decorators.js';
import { ApiFileResponse, ApiOneOfResponse, ApiPagedResponse, DeletedDto } from '../../common/openapi/responses.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { RequiresIdempotencyKey } from '../../common/idempotency/requires-idempotency-key.decorator.js';
import { ExportQueryDto } from '../printing/dto/export.dto.js';
import { PrintingService } from '../printing/printing.service.js';
import { voucherPrint } from './treasury.print.js';
import { agingTable } from './aging.table.js';
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
  ListCashTransfersQueryDto,
  ListPaymentsQueryDto,
  ListReceiptsQueryDto,
  ReverseVoucherDto,
} from './dto/treasury.dto.js';
import {
  AgingReportDto,
  BankAccountDto,
  BankAccountListItemDto,
  CashBalancesDto,
  CashBoxDto,
  CashBoxListItemDto,
  CashTransferDetailDto,
  CashTransferListItemDto,
  PaymentDetailDto,
  PaymentListItemDto,
  ReceiptDetailDto,
  ReceiptListItemDto,
  REPORT_FILE_TYPES,
  TreasuryAccountDeactivatedDto,
} from './dto/treasury-response.dto.js';

@ApiTags('treasury')
@Controller()
export class TreasuryController {
  constructor(
    private readonly cashAccounts: CashAccountsService,
    private readonly vouchers: VouchersService,
    private readonly transfers: CashTransfersService,
    private readonly reports: TreasuryReportsService,
    private readonly printing: PrintingService,
  ) {}

  // ------------------------------------------------------------- cash boxes

  @Get('cash-boxes')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CashBoxListItemDto, isArray: true })
  listCashBoxes() {
    return this.cashAccounts.listCashBoxes();
  }

  @Post('cash-boxes')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: CashBoxDto })
  createCashBox(@Body() dto: CreateCashBoxDto) {
    return this.cashAccounts.createCashBox(dto);
  }

  @Put('cash-boxes/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: CashBoxDto })
  updateCashBox(@Param('id') id: string, @Body() dto: Partial<CreateCashBoxDto>) {
    return this.cashAccounts.updateCashBox(BigInt(id), dto);
  }

  @Delete('cash-boxes/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOneOfResponse(200, [TreasuryAccountDeactivatedDto, DeletedDto])
  deleteCashBox(@Param('id') id: string) {
    return this.cashAccounts.deleteCashBox(BigInt(id));
  }

  // ---------------------------------------------------------- bank accounts

  @Get('bank-accounts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: BankAccountListItemDto, isArray: true })
  listBankAccounts() {
    return this.cashAccounts.listBankAccounts();
  }

  @Post('bank-accounts')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: BankAccountDto })
  createBankAccount(@Body() dto: CreateBankAccountDto) {
    return this.cashAccounts.createBankAccount(dto);
  }

  @Put('bank-accounts/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOkResponse({ type: BankAccountDto })
  updateBankAccount(@Param('id') id: string, @Body() dto: Partial<CreateBankAccountDto>) {
    return this.cashAccounts.updateBankAccount(BigInt(id), dto);
  }

  @Delete('bank-accounts/:id')
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOneOfResponse(200, [TreasuryAccountDeactivatedDto, DeletedDto])
  deleteBankAccount(@Param('id') id: string) {
    return this.cashAccounts.deleteBankAccount(BigInt(id));
  }

  // -------------------------------------------------------------- receipts

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('receipts')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(ReceiptListItemDto)
  listReceipts(@Query() q: ListReceiptsQueryDto) {
    return this.vouchers.listReceipts(q);
  }

  @Get('receipts/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: ReceiptDetailDto })
  getReceipt(@Param('id') id: string) {
    return this.vouchers.getReceipt(BigInt(id));
  }

  @Get('receipts/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async receiptPdf(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(voucherPrint('receipt', await this.vouchers.printable('receipt', BigInt(id)), lang), lang);
  }

  @Post('receipts')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: ReceiptDetailDto })
  createReceipt(@Body() dto: CreateReceiptDto) {
    return this.vouchers.createReceipt(dto);
  }

  // -------------------------------------------------------------- payments

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('payments')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(PaymentListItemDto)
  listPayments(@Query() q: ListPaymentsQueryDto) {
    return this.vouchers.listPayments(q);
  }

  @Get('payments/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: PaymentDetailDto })
  getPayment(@Param('id') id: string) {
    return this.vouchers.getPayment(BigInt(id));
  }

  @Get('payments/:id/pdf')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiFileResponse(['application/pdf'])
  async paymentPdf(@Param('id') id: string, @Query() q: ExportQueryDto) {
    const lang = q.lang ?? 'ar';
    return this.printing.exportDocument(voucherPrint('payment', await this.vouchers.printable('payment', BigInt(id)), lang), lang);
  }

  @Post('payments')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: PaymentDetailDto })
  createPayment(@Body() dto: CreatePaymentDto) {
    return this.vouchers.createPayment(dto);
  }

  // ------------------------------------- Phase 6: reverse, allocate, cancel

  @Post('receipts/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: ReceiptDetailDto })
  reverseReceipt(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.vouchers.reverseVoucher('receipt', BigInt(id), dto);
  }

  @Post('payments/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: PaymentDetailDto })
  reversePayment(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.vouchers.reverseVoucher('payment', BigInt(id), dto);
  }

  @Post('receipts/:id/allocations')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: ReceiptDetailDto })
  allocateReceipt(@Param('id') id: string, @Body() dto: AllocateVoucherDto) {
    return this.vouchers.allocateVoucher('receipt', BigInt(id), dto);
  }

  @Post('payments/:id/allocations')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: PaymentDetailDto })
  allocatePayment(@Param('id') id: string, @Body() dto: AllocateVoucherDto) {
    return this.vouchers.allocateVoucher('payment', BigInt(id), dto);
  }

  @Post('allocations/:id/cancel')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiOneOfResponse(201, [ReceiptDetailDto, PaymentDetailDto])
  cancelAllocation(@Param('id') id: string) {
    return this.vouchers.cancelAllocation(BigInt(id));
  }

  // --------------------------------------------------------- cash transfers

  /** Numbered page `{ items, page, pageSize, total }` (ADR-022), the caller's branches only. */
  @Get('cash-transfers')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiPagedResponse(CashTransferListItemDto)
  listCashTransfers(@Query() q: ListCashTransfersQueryDto) {
    return this.transfers.list(q);
  }

  @Get('cash-transfers/:id')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  @ApiOkResponse({ type: CashTransferDetailDto })
  getCashTransfer(@Param('id') id: string) {
    return this.transfers.get(BigInt(id));
  }

  @Post('cash-transfers')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: CashTransferDetailDto })
  createCashTransfer(@Body() dto: CreateCashTransferDto) {
    return this.transfers.create(dto);
  }

  @Post('cash-transfers/:id/reverse')
  @RequiresIdempotencyKey()
  @RequirePermission(PERMISSIONS.TREASURY_MANAGE)
  @ApiCreatedResponse({ type: CashTransferDetailDto })
  reverseCashTransfer(@Param('id') id: string, @Body() dto: ReverseVoucherDto) {
    return this.transfers.reverse(BigInt(id), dto);
  }

  // ---------------------------------------------------------------- reports

  @Get('reports/aging')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiFileResponse(REPORT_FILE_TYPES, AgingReportDto)
  async aging(@Query() q: AgingQueryDto) {
    const data = await this.reports.aging(q.partyType, q.asOf ? new Date(q.asOf) : undefined);
    return this.printing.respond(data, q, agingTable);
  }

  @Get('treasury/balances')
  @RequirePermission(PERMISSIONS.REPORTS_VIEW)
  @ApiOkResponse({ type: CashBalancesDto })
  cashBalances() {
    return this.reports.cashBalances();
  }
}
