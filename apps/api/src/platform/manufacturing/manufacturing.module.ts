import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { BomService } from './bom.service.js';
import { BomsController } from './boms.controller.js';
import { ProductionVouchersController } from './production-vouchers.controller.js';
import { ProductionVouchersService } from './production-vouchers.service.js';

/** Phase 16 (ADR-031): bills of materials and production vouchers. */
@Module({
  imports: [InventoryModule, JournalModule, PrintingModule, SharedModule],
  controllers: [BomsController, ProductionVouchersController],
  providers: [BomService, ProductionVouchersService],
  exports: [BomService],
})
export class ManufacturingModule {}
