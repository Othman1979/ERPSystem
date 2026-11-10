import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
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

@Module({
  imports: [JournalModule, PrintingModule],
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
  ],
  // StockReportsService: the dashboard lists items below their minimum (module boundary).
  exports: [StockLedgerService, StockReportsService],
})
export class InventoryModule {}
