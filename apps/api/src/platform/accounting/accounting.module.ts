import { Module } from '@nestjs/common';
import { AccountingController } from './accounting.controller.js';
import { AccountsService } from './accounts.service.js';
import { ChartProvisioningService } from './chart-provisioning.service.js';
import { FiscalController } from './fiscal.controller.js';
import { FiscalService } from './fiscal.service.js';
import { MappingsService } from './mappings.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';

@Module({
  controllers: [AccountingController, FiscalController, SettingsController],
  providers: [
    AccountsService,
    MappingsService,
    FiscalService,
    SettingsService,
    ChartProvisioningService,
  ],
  // FiscalService: reports find the fiscal year containing a date (module boundary).
  exports: [ChartProvisioningService, FiscalService],
})
export class AccountingModule {}
