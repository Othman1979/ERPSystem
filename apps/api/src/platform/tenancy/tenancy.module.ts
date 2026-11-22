import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { TenantDatabaseProvisioner } from './database-provisioner.service.js';
import { TenantMirrorService } from './tenant-mirror.service.js';
import { TenantProvisioningService } from './tenant-provisioning.service.js';
import { TenantDbPoolService } from './tenant-db-pool.service.js';
import { TenantMigrationService } from './tenant-migration.service.js';

@Module({
  imports: [PrismaModule, AccountingModule],
  providers: [
    TenantDatabaseProvisioner,
    TenantMirrorService,
    TenantProvisioningService,
    TenantDbPoolService,
    TenantMigrationService,
  ],
  exports: [TenantDatabaseProvisioner, TenantMirrorService, TenantProvisioningService, TenantDbPoolService, TenantMigrationService],
})
export class TenancyModule {}
