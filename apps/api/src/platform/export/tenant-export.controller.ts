import { Controller, Get, StreamableFile } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { RequireAllBranches, RequirePermission } from '../../common/decorators/auth.decorators.js';
import { PERMISSIONS } from '../../common/permissions/permissions.js';
import { TenantExportService } from './tenant-export.service.js';

/**
 * Company data export (§13.6, ADR-009 §13). GET, not the POST of §15: a
 * read passes the read-only guard, so SUSPENDED and CANCELLED tenants can
 * still take their data. The service allows the owner only.
 */
@ApiTags('export')
@Controller('export')
export class TenantExportController {
  constructor(private readonly exporter: TenantExportService) {}

  @Get('tenant-data')
  @RequirePermission(PERMISSIONS.TENANT_READ)
  // The archive covers the whole company, so a branch-limited member is refused (ADR-003 §13).
  @RequireAllBranches()
  @ApiProduces('application/zip')
  async tenantData(): Promise<StreamableFile> {
    const { zip, fileName } = await this.exporter.export();
    return new StreamableFile(zip, {
      type: 'application/zip',
      disposition: `attachment; filename="${fileName}"`,
      length: zip.length,
    });
  }
}
