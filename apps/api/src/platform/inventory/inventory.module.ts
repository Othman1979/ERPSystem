import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogService } from './catalog.service.js';
import { CountsService } from './counts.service.js';
import { StockDocumentsController } from './stock-documents.controller.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { StockReportsController } from './stock-reports.controller.js';
import { StockReportsService } from './stock-reports.service.js';
import { TransfersService } from './transfers.service.js';
import { WarehousesController } from './warehouses.controller.js';
import { WarehousesService } from './warehouses.service.js';
import { InventoryYearClosingDraftRegistrations } from './year-closing-draft-registrations.service.js';

@Module({
  imports: [AccountingModule, JournalModule, PrintingModule, SharedModule],
  controllers: [
    CatalogController,
    WarehousesController,
    StockDocumentsController,
    StockReportsController,
  ],
  providers: [
    CatalogService,
    WarehousesService,
    StockLedgerService,
    AdjustmentsService,
    TransfersService,
    CountsService,
    StockReportsService,
    InventoryYearClosingDraftRegistrations,
  ],
  // StockReportsService: the dashboard lists items below their minimum (module boundary).
  // CatalogService / WarehousesService: the procurement documents' lines and header (ADR-025).
  exports: [StockLedgerService, StockReportsService, CatalogService, WarehousesService],
})
export class InventoryModule {}
