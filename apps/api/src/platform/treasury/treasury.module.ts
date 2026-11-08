import { Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { SharedModule } from '../shared/shared.module.js';
import { CashAccountsService } from './cash-accounts.service.js';
import { TreasuryController } from './treasury.controller.js';
import { VouchersService } from './vouchers.service.js';

@Module({
  imports: [SharedModule, JournalModule],
  controllers: [TreasuryController],
  providers: [CashAccountsService, VouchersService],
})
export class TreasuryModule {}
