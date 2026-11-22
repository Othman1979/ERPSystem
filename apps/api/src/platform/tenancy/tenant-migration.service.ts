import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.validation.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { expectedSchemaVersion, isSchemaBehind } from '../../prisma/schema-version.js';
import { migrateDatabase, migrationErrorMessage } from './migrate-runner.js';
import { TenantDatabaseProvisioner } from './database-provisioner.service.js';

@Injectable()
export class TenantMigrationService {
  // systemPrisma: migration state is control-plane metadata.
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly databases: TenantDatabaseProvisioner,
  ) {}

  async run(tenantId?: bigint): Promise<{ ok: boolean; tenants: number; pool: number; failures: number }> {
    await migrateDatabase(this.config.get('DATABASE_URL', { infer: true }));
    const control = this.prisma.control();
    const expected = expectedSchemaVersion();
    const rows = await control.tenantDatabase.findMany({
      where: {
        state: { in: ['ACTIVE', 'MIGRATING'] },
        ...(tenantId !== undefined ? { tenantId } : {}),
      },
      orderBy: { tenantId: 'asc' },
    });
    if (tenantId !== undefined && rows.length === 0) throw new Error(`Tenant database ${tenantId} was not found`);
    let tenants = 0;
    let failures = 0;
    for (const row of rows) {
      if (row.state !== 'MIGRATING' && !isSchemaBehind(row.schemaVersion, expected)) continue;
      tenants += 1;
      await control.tenantDatabase.update({ where: { tenantId: row.tenantId }, data: { state: 'MIGRATING' } });
      try {
        const schemaVersion = isSchemaBehind(row.schemaVersion, expected)
          ? await migrateDatabase(this.databases.databaseUrl(row))
          : row.schemaVersion!;
        await control.tenantDatabase.update({
          where: { tenantId: row.tenantId },
          data: { schemaVersion, state: 'ACTIVE' },
        });
        await this.prisma.router.invalidate(row.tenantId);
      } catch (error) {
        failures += 1;
        console.error(`Tenant ${row.tenantId} migration failed: ${migrationErrorMessage(error)}`);
      }
    }

    const poolRows = await control.tenantDbPool.findMany({
      where: { claimedByTenantId: null, OR: [{ schemaVersion: null }, { schemaVersion: { lt: expected } }] },
      orderBy: { id: 'asc' },
    });
    let pool = 0;
    for (const row of poolRows) {
      pool += 1;
      try {
        const schemaVersion = await migrateDatabase(this.databases.databaseUrl(row));
        await control.tenantDbPool.update({ where: { id: row.id }, data: { schemaVersion } });
      } catch (error) {
        failures += 1;
        console.error(`Tenant database pool row ${row.id} migration failed: ${migrationErrorMessage(error)}`);
      }
    }
    return { ok: failures === 0, tenants, pool, failures };
  }
}
