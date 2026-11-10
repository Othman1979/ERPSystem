import { Module } from '@nestjs/common';
import { JournalController } from './journal.controller.js';
import { JournalService } from './journal.service.js';
import { PostingService } from './posting.service.js';
import { ReportsService } from './reports.service.js';

@Module({
  controllers: [JournalController],
  providers: [JournalService, PostingService, ReportsService],
  // ReportsService: treasury aging reads party control balances (module boundary).
  exports: [PostingService, ReportsService],
})
export class JournalModule {}
