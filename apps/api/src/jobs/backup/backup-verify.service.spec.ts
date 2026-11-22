import type { PrismaService } from '../../prisma/prisma.service.js';
import { jest } from '@jest/globals';
import {
  isRegisteredTenantTarget,
  tenantMigrationVersionMatches,
} from './backup-verify.service.js';
import type { DbTarget } from './mysql-tools.js';

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

    await expect(isRegisteredTenantTarget(prisma, 'shared', target, jest.fn())).resolves.toBe(false);
    expect(prisma.control).not.toHaveBeenCalled();
    expect(tenantFindMany).not.toHaveBeenCalled();
    expect(poolFindMany).not.toHaveBeenCalled();
  });

  it('warns and continues when isolated-mode lookups fail', async () => {
    const prisma = {
      control: () => ({
        tenantDatabase: {
          findMany: jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => {
            throw new Error('unavailable');
          }),
        },
        tenantDbPool: { findMany: jest.fn(async (_args: LookupArgs): Promise<DatabaseRow[]> => []) },
      }),
    } as unknown as PrismaService;
    const warn = jest.fn();

    await expect(isRegisteredTenantTarget(prisma, 'isolated', target, warn)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('Could not check tenant and pool database targets before backup verification');
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

    await expect(isRegisteredTenantTarget(prisma, 'isolated', target, jest.fn())).resolves.toBe(true);
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
