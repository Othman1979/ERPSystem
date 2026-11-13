import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { PlanLimitsService } from './plan-limits/plan-limits.service.js';
import { StorageService } from './storage/storage.service.js';

@Global()
@Module({
  providers: [AuditService, PlanLimitsService, StorageService],
  exports: [AuditService, PlanLimitsService, StorageService],
})
export class CommonModule {}
