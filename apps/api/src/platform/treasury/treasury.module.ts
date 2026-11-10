import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { PartiesModule } from '../parties/parties.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PurchasesModule } from '../purchases/purchases.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { CashAccountsService } from './cash-accounts.service.js';
import { CashTransfersService } from './cash-transfers.service.js';
import { TreasuryReportsService } from './treasury-reports.service.js';
import { TreasuryController } from './treasury.controller.js';
import { VouchersService } from './vouchers.service.js';

@Module({
  imports: [SharedModule, JournalModule, PartiesModule, SalesModule, PurchasesModule, PrintingModule],
  controllers: [TreasuryController],
  providers: [CashAccountsService, VouchersService, CashTransfersService, TreasuryReportsService],
})
export class TreasuryModule {}
