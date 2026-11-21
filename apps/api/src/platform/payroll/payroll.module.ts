import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { CostCentersModule } from '../cost-centers/cost-centers.module.js';
import { JournalModule } from '../journal/journal.module.js';
import { PrintingModule } from '../printing/printing.module.js';
import { PayrollController } from './payroll.controller.js';
import { LeaveController } from './leave.controller.js';
import { LeaveService } from './leave.service.js';
import { PayrollService } from './payroll.service.js';
import { PayrollSettlementController } from './payroll-settlement.controller.js';
import { PayrollSettlementService } from './payroll-settlement.service.js';

@Module({
  imports: [AccountingModule, CostCentersModule, JournalModule, PrintingModule],
  controllers: [PayrollController, LeaveController, PayrollSettlementController],
  providers: [PayrollService, LeaveService, PayrollSettlementService],
})
export class PayrollModule {}
