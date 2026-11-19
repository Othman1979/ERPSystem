import { forwardRef, Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { PartiesModule } from '../parties/parties.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { PostingService } from './posting.service.js';
import { ReportsService } from './reports.service.js';

@Module({
  // Report exports (PDF / XLSX), the party's name on a statement, and the
  // fiscal year holding a report's start (ADR-008 §7).
  // Posting checks and locks the lines' cost centres (ADR-024 §1).
  imports: [PrintingModule, PartiesModule, forwardRef(() => AccountingModule), CostCentersModule],
  controllers: [JournalController],
  providers: [JournalService, PostingService, ReportsService],
  // ReportsService: treasury aging reads party control balances, and the
  // Phase 8 statements read account totals (module boundary).
  exports: [PostingService, ReportsService],
})
export class JournalModule {}
