import { Global, Module } from '@nestjs/common';
import { ErrorEventsService } from './error-events.service.js';
import { AdminErrorsController, ClientErrorsController } from './monitoring.controller.js';
import { MonitoringService } from './monitoring.service.js';

/**
 * Error monitoring (ADR-010 §10.3). Global: the exception filter records
 * through ErrorEventsService, which lives here because it uses systemPrisma
 * (allowed in `platform` and `jobs` only).
 */
@Global()
@Module({
  controllers: [ClientErrorsController, AdminErrorsController],
  providers: [MonitoringService, ErrorEventsService],
  exports: [ErrorEventsService],
})
export class MonitoringModule {}
