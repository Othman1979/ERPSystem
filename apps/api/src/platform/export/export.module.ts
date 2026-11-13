import { Module } from '@nestjs/common';
import { TenantExportController } from './tenant-export.controller.js';
import { TenantExportService } from './tenant-export.service.js';

/** Company data export (§13.6). */
@Module({
  controllers: [TenantExportController],
  providers: [TenantExportService],
})
export class ExportModule {}
