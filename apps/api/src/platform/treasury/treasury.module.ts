import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { PartiesModule } from '../parties/parties.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PurchasesModule } from '../purchases/purchases.module.js';
import { SalesModule } from '../sales/sales.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { BankReconciliationController } from './bank-reconciliation.controller.js';
import { BankReconciliationService } from './bank-reconciliation.service.js';
import { CashAccountsService } from './cash-accounts.service.js';
import { CashTransfersService } from './cash-transfers.service.js';
import { ChequesController } from './cheques.controller.js';
import { ChequesService } from './cheques.service.js';
import { TreasuryReportsService } from './treasury-reports.service.js';
import { TreasuryController } from './treasury.controller.js';
import { VouchersService } from './vouchers.service.js';

@Module({
  imports: [AccountingModule, SharedModule, JournalModule, PartiesModule, SalesModule, PurchasesModule, PrintingModule, CostCentersModule],
  controllers: [TreasuryController, BankReconciliationController, ChequesController],
  providers: [ChequesService, BankReconciliationService, CashAccountsService, VouchersService, CashTransfersService, TreasuryReportsService],
  // The dashboard reads receivables from the aging totals (module boundary).
  exports: [TreasuryReportsService],
})
export class TreasuryModule {}
