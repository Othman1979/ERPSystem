import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PayrollController } from './payroll.controller.js';
import { PayrollService } from './payroll.service.js';

@Module({
  imports: [AccountingModule, CostCentersModule, JournalModule, PrintingModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
