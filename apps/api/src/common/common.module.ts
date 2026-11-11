import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { PlanLimitsService } from './plan-limits/plan-limits.service.js';

@Global()
@Module({
  providers: [AuditService, PlanLimitsService],
  exports: [AuditService, PlanLimitsService],
})
export class CommonModule {}
