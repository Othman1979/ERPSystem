import { Module } from '@nestjs/common';
import { GoodsNotesModule } from '../goods-notes/goods-notes.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PurchaseInvoicesService } from './purchase-invoices.service.js';
import { PurchaseReturnsService } from './purchase-returns.service.js';
import { PurchasesController } from './purchases.controller.js';

@Module({
  imports: [SharedModule, JournalModule, InventoryModule, GoodsNotesModule, PrintingModule],
  controllers: [PurchasesController],
  providers: [PurchaseInvoicesService, PurchaseReturnsService],
  // Treasury reads open credit invoices for aging through this service (module boundary);
  // the Phase 8 reports add up invoices and returns through their summary().
  exports: [PurchaseInvoicesService, PurchaseReturnsService],
})
export class PurchasesModule {}
