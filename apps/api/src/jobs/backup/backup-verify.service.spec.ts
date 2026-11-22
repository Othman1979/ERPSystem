import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { Env } from '../../common/config/env.validation.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  BackupVerifyService,
  isRegisteredTenantTarget,
  tenantMigrationVersionMatches,
} from './backup-verify.service.js';
import type { DbTarget } from './mysql-tools.js';
import { MANIFEST_FILE } from './manifest.js';

type DatabaseRow = { host: string; port: number; databaseName: string };
type LookupArgs = { select: { host: true; port: true; databaseName: true } };

describe('backup verify tenant target checks', () => {
  const target: DbTarget = {
    host: 'localhost',
    port: 3306,
    user: 'verify',
    password: 'test',
    database: 'erp_verify',
  };

  it('does not look up tenant databases in shared mode', async () => {
    const tenantFindMany = jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => []);
    const poolFindMany = jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => []);
    const prisma = {
      control: jest.fn(() => ({
        tenantDatabase: { findMany: tenantFindMany },
        tenantDbPool: { findMany: poolFindMany },
      })),
    } as unknown as PrismaService;

    await expect(isRegisteredTenantTarget(prisma, 'shared', target)).resolves.toBe(false);
    expect(prisma.control).not.toHaveBeenCalled();
    expect(tenantFindMany).not.toHaveBeenCalled();
    expect(poolFindMany).not.toHaveBeenCalled();
  });

  it('fails closed when isolated-mode lookups fail', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'backup-verify-registry-'));
    const folder = path.join(root, 'backup');
    await mkdir(folder);
    await writeFile(
      path.join(folder, MANIFEST_FILE),
      JSON.stringify({
        format: 2,
        name: 'backup-test',
        createdAt: new Date().toISOString(),
        database: { name: 'source', server: 'localhost' },
        migrations: { count: 0, last: null },
        storage: { files: 0 },
        files: [],
        encryption: null,
      }),
    );
    const prisma = {
      tenancyMode: 'isolated',
      control: () => ({
        tenantDatabase: {
          findMany: jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => {
            throw new Error('unavailable');
          }),
        },
        tenantDbPool: { findMany: jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => []) },
      }),
    } as unknown as PrismaService;
    const values: Record<string, string | undefined> = {
      BACKUP_DIR: root,
      DATABASE_URL: 'mysql://live:test@localhost:3306/erp_live',
      BACKUP_VERIFY_DATABASE_URL: 'mysql://verify:test@localhost:3306/erp_verify',
      BACKUP_ENCRYPTION_KEY: undefined,
    };
    const config = {
      get: (key: string) => values[key],
    } as unknown as ConfigService<Env, true>;

    try {
      const result = await new BackupVerifyService(config, prisma).run(folder);
      expect(result.ok).toBe(false);
      expect(result.restoredInto).toBeNull();
      expect(result.checks.find((check) => check.name === 'restore')).toEqual({
        name: 'restore',
        ok: false,
        detail: 'cannot confirm the scratch database is not a tenant or pool database',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recognizes tenant and pool targets in isolated mode', async () => {
    const prisma = {
      control: () => ({
        tenantDatabase: {
          findMany: jest.fn(
            async (_args: LookupArgs): Promise<DatabaseRow[]> => [
              { host: target.host, port: target.port, databaseName: target.database },
            ],
          ),
        },
        tenantDbPool: { findMany: jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => []) },
      }),
    } as unknown as PrismaService;

    await expect(isRegisteredTenantTarget(prisma, 'isolated', target)).resolves.toBe(true);
  });
});

describe('tenant backup migration versions', () => {
  const expected = '20261123130000_tenant_db_restoring_state';

  it('accepts the version recorded in the tenant manifest even when the running build is newer', () => {
    const backupVersion = '20261123120000_phase29b_tenant_db_pool';
    expect(tenantMigrationVersionMatches(backupVersion, backupVersion, expected)).toBe(true);
    expect(tenantMigrationVersionMatches(expected, backupVersion, expected)).toBe(false);
  });

  it('allows a null manifest version only when the dump is no newer than the running build', () => {
    expect(tenantMigrationVersionMatches('20261123120000_phase29b_tenant_db_pool', null, expected)).toBe(true);
    expect(tenantMigrationVersionMatches(expected, null, expected)).toBe(true);
    expect(tenantMigrationVersionMatches('20261123140000_future', null, expected)).toBe(false);
  });
});
