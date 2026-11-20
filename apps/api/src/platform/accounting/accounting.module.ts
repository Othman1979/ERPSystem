import { CompaniesController } from './companies.controller.js';
import { CompaniesService } from './companies.service.js';
import { forwardRef, Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module.js';
import { AccountingController } from './accounting.controller.js';
import { AccountsService } from './accounts.service.js';
import { ChartProvisioningService } from './chart-provisioning.service.js';
import { CompanyController } from './company.controller.js';
import { CompanyService } from './company.service.js';
import { FiscalController } from './fiscal.controller.js';
import { FiscalService } from './fiscal.service.js';
import { MappingsService } from './mappings.service.js';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { YearClosingService } from './year-closing.service.js';
import { YearClosingDraftRegistry } from './year-closing-draft.registry.js';

@Module({
  imports: [forwardRef(() => JournalModule)],
  controllers: [AccountingController, FiscalController, SettingsController, CompanyController, CompaniesController],
  providers: [
    CompaniesService,
    AccountsService,
    MappingsService,
    FiscalService,
    SettingsService,
    ChartProvisioningService,
    CompanyService,
    YearClosingService,
    YearClosingDraftRegistry,
  ],
  // FiscalService: reports find the fiscal year containing a date (module boundary).
  exports: [ChartProvisioningService, FiscalService, YearClosingDraftRegistry],
})
export class AccountingModule {}
