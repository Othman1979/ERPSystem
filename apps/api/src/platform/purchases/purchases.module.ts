import { Module } from '@nestjs/common';
import { GoodsNotesModule } from '../goods-notes/goods-notes.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PurchaseInvoicesService } from './purchase-invoices.service.js';
import { PurchaseReturnsService } from './purchase-returns.service.js';
import { PurchasesController } from './purchases.controller.js';
import { PartiesModule } from '../parties/parties.module.js';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';

@Module({
  // Procurement: invoices billing an order's receipts (ADR-026 §7), through its exported service.
  imports: [AccountingModule, PartiesModule, SharedModule, JournalModule, InventoryModule, GoodsNotesModule, PrintingModule, CostCentersModule, ProcurementModule],
  controllers: [PurchasesController],
  providers: [PurchaseInvoicesService, PurchaseReturnsService],
  // Treasury reads open credit invoices for aging through this service (module boundary);
  // the Phase 8 reports add up invoices and returns through their summary().
  exports: [PurchaseInvoicesService, PurchaseReturnsService],
})
export class PurchasesModule {}
