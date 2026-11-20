import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';

@Module({
  imports: [JournalModule, PrintingModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
