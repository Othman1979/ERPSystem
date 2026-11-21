import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { EInvoiceOutboxModule } from '../einvoice/einvoice-outbox.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SalesController } from './sales.controller.js';
import { SalesInvoicesService } from './sales-invoices.service.js';
import { SalesReturnsService } from './sales-returns.service.js';
import { SalesCycleController } from './sales-cycle.controller.js';
import { SalesOrdersService } from './sales-orders.service.js';
import { SalesQuotesService } from './sales-quotes.service.js';
import { PartiesModule } from '../parties/parties.module.js';
import { ManufacturingModule } from '../manufacturing/manufacturing.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { DocumentLocksModule } from '../document-locks/document-locks.module.js';

@Module({
  imports: [AccountingModule, PartiesModule, SharedModule, JournalModule, InventoryModule, EInvoiceOutboxModule, PrintingModule, CostCentersModule, ManufacturingModule, DocumentLocksModule],
  // Phase 14 (ADR-027): sales quotations and orders; no posting, no stock movement here.
  controllers: [SalesController, SalesCycleController],
  providers: [SalesInvoicesService, SalesReturnsService, SalesQuotesService, SalesOrdersService],
  // Treasury reads open credit invoices for aging through this service (module boundary).
  // EInvoiceModule builds JoFotara documents from posted invoices and returns.
  exports: [SalesInvoicesService, SalesReturnsService],
})
export class SalesModule {}
