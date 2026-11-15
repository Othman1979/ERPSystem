import { Module } from '@nestjs/common';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { PartiesModule } from '../parties/parties.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { ProcurementController } from './procurement.controller.js';
import { ProcurementRegistrations } from './procurement.registrations.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import { PurchaseQuotesService } from './purchase-quotes.service.js';
import { PurchaseRequestsService } from './purchase-requests.service.js';

/**
 * Phase 12 (ADR-025): purchase requests, requests for quotation and purchase
 * orders. It posts nothing: no PostingService, no StockLedgerService here.
 * Catalog, warehouses, parties and cost centres come through their exported
 * services (module boundary).
 */
@Module({
  imports: [SharedModule, InventoryModule, PartiesModule, CostCentersModule, PrintingModule],
  controllers: [ProcurementController],
  providers: [PurchaseRequestsService, PurchaseQuotesService, PurchaseOrdersService, ProcurementRegistrations],
})
export class ProcurementModule {}
