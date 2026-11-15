import { Module } from '@nestjs/common';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PartiesModule } from '../parties/parties.module.js';
import { ProcurementModule } from '../procurement/procurement.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { GoodsNotesController } from './goods-notes.controller.js';
import { GoodsNotesService } from './goods-notes.service.js';
import { ReceivingController } from './receiving.controller.js';

@Module({
  // Procurement: receiving against orders and issuing from requests (ADR-026), through its exported services.
  imports: [SharedModule, JournalModule, InventoryModule, CostCentersModule, PartiesModule, ProcurementModule],
  controllers: [GoodsNotesController, ReceivingController],
  providers: [GoodsNotesService],
  // Purchase invoices bill a posted GRN through it (TRADE-02, ADR-026 §7, module boundary).
  exports: [GoodsNotesService],
})
export class GoodsNotesModule {}
