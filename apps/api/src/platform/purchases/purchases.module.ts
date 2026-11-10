import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { PurchaseInvoicesService } from './purchase-invoices.service.js';
import { PurchaseReturnsService } from './purchase-returns.service.js';
import { PurchasesController } from './purchases.controller.js';

@Module({
  imports: [SharedModule, JournalModule, InventoryModule],
  controllers: [PurchasesController],
  providers: [PurchaseInvoicesService, PurchaseReturnsService],
  // Treasury reads open credit invoices for aging through this service (module boundary).
  exports: [PurchaseInvoicesService],
})
export class PurchasesModule {}
