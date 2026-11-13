import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { GoodsNotesController } from './goods-notes.controller.js';
import { GoodsNotesService } from './goods-notes.service.js';

@Module({
  imports: [SharedModule, JournalModule, InventoryModule],
  controllers: [GoodsNotesController],
  providers: [GoodsNotesService],
  // Purchase invoices bill a posted GRN through it (TRADE-02, module boundary).
  exports: [GoodsNotesService],
})
export class GoodsNotesModule {}
