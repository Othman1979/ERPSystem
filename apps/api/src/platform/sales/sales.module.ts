import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { EInvoiceOutboxModule } from '../einvoice/einvoice-outbox.module.js';
import { SalesController } from './sales.controller.js';
import { SalesInvoicesService } from './sales-invoices.service.js';
import { SalesReturnsService } from './sales-returns.service.js';

@Module({
  imports: [SharedModule, JournalModule, InventoryModule, EInvoiceOutboxModule],
  controllers: [SalesController],
  providers: [SalesInvoicesService, SalesReturnsService],
  // Treasury reads open credit invoices for aging through this service (module boundary).
  // EInvoiceModule builds JoFotara documents from posted invoices and returns.
  exports: [SalesInvoicesService, SalesReturnsService],
})
export class SalesModule {}
