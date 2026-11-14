import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { PlanLimitsService } from './plan-limits/plan-limits.service.js';
import { StorageService } from './storage/storage.service.js';
import { CursorCodec } from './paging/cursor.js';
import { ProcurementCycleRegistry } from './procurement/procurement-level.js';

@Global()
@Module({
  providers: [AuditService, PlanLimitsService, StorageService, CursorCodec, ProcurementCycleRegistry],
  exports: [AuditService, PlanLimitsService, StorageService, CursorCodec, ProcurementCycleRegistry],
})
export class CommonModule {}
