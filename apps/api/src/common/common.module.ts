import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit/audit.service.js';
import { PlanLimitsService } from './plan-limits/plan-limits.service.js';
import { StorageService } from './storage/storage.service.js';
import { CursorCodec } from './paging/cursor.js';

@Global()
@Module({
  providers: [AuditService, PlanLimitsService, StorageService, CursorCodec],
  exports: [AuditService, PlanLimitsService, StorageService, CursorCodec],
})
export class CommonModule {}
