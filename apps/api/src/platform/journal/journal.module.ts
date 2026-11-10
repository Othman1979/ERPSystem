import { Module } from '@nestjs/common';
import { PartiesModule } from '../parties/parties.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { OpeningBalancesController } from './opening-balances.controller.js';
import { OpeningBalancesService } from './opening-balances.service.js';
import { PostingService } from './posting.service.js';
import { ReportsService } from './reports.service.js';

@Module({
  // Report exports (PDF / XLSX) and the party's name on a statement.
  imports: [PrintingModule, PartiesModule],
  controllers: [JournalController, OpeningBalancesController],
  providers: [JournalService, PostingService, ReportsService, OpeningBalancesService],
  // ReportsService: treasury aging reads party control balances, and the
  // Phase 8 statements read account totals (module boundary).
  // OpeningBalancesService: opening stock is dated like the opening entry.
  exports: [PostingService, ReportsService, OpeningBalancesService],
})
export class JournalModule {}
