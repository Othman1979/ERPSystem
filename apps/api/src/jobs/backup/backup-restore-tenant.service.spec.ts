import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../common/config/env.validation.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantDatabaseProvisioner } from '../../platform/tenancy/database-provisioner.service.js';
import { runAbortCleanups } from '../abort-cleanup.js';

const tenantId = 17n;
const tenantName = 'Restore race test';
const tenantFile = `tenant-${tenantId}.sql.gz`;
const checksum = 'restore-race-test-checksum';
const tenantManifest = {
  format: 3,
  name: 'backup-20261122-000000',
  createdAt: '2026-11-22T00:00:00.000Z',
  database: { name: 'control', server: 'MariaDB' },
  migrations: { count: 1, last: 'migration-1' },
  storage: { files: 0 },
  files: [{ name: tenantFile, bytes: 9, sha256: checksum }],
  encryption: null,
  tenantDatabases: [
    {
      tenantId: tenantId.toString(),
      database: 'tenant_db',
      file: tenantFile,
      schemaVersion: 'migration-1',
    },
  ],
};

let state: 'ACTIVE' | 'RESTORING' = 'ACTIVE';
let root = '';
let folder = '';
let BackupRestoreTenantService: typeof import('./backup-restore-tenant.service.js').BackupRestoreTenantService;

const dropTenantDatabaseTables = jest.fn(async (_url: string): Promise<void> => undefined);
const lockConnection = {
  query: jest.fn(async (): Promise<{ acquired: number }[]> => [{ acquired: 1 }]),
  end: jest.fn(async (): Promise<void> => undefined),
};
const createConnection = jest.fn(async () => lockConnection);
const withOptionFile = jest.fn(
  async (_target: unknown, callback: (file: string) => Promise<unknown>): Promise<unknown> => {
    await runAbortCleanups();
    return callback('/tmp/restore-race-options.cnf');
  },
);

beforeAll(async () => {
  await jest.unstable_mockModule('mariadb', () => ({
    default: { createConnection },
  }));
  await jest.unstable_mockModule('./mysql-tools.js', () => ({
    dbTarget: (value: string) => {
      const url = new URL(value);
      return {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)),
      };
    },
    runTool: jest.fn(),
    toolVersion: jest.fn(async () => 'mysql 8.0'),
    withOptionFile,
  }));
  await jest.unstable_mockModule('../tenant-purge.service.js', () => ({
    dropTenantDatabaseTables,
  }));
  await jest.unstable_mockModule('./manifest.js', () => ({
    MANIFEST_FILE: 'manifest.json',
    encryptionOf: jest.fn(() => null),
    parseBackupManifest: jest.fn(() => tenantManifest),
    resolveBackupFolder: jest.fn(async (which: string) => which),
    sha256File: jest.fn(async () => checksum),
  }));
  await jest.unstable_mockModule('./backup-crypto.js', () => ({
    backupKey: jest.fn(() => null),
    createDecryptStream: jest.fn(),
    keyProblem: jest.fn(() => null),
  }));
  ({ BackupRestoreTenantService } = await import('./backup-restore-tenant.service.js'));

  root = await mkdtemp(path.join(os.tmpdir(), 'restore-abort-race-'));
  folder = path.join(root, 'backup');
  await mkdir(folder);
  await writeFile(path.join(folder, 'manifest.json'), '{}');
  await writeFile(path.join(folder, tenantFile), '123456789');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  state = 'ACTIVE';
  jest.clearAllMocks();
});

describe('BackupRestoreTenantService abort race', () => {
  it('keeps the prior state and skips table drops when aborted before the option-file callback', async () => {
    const tenantDatabase = {
      findUnique: jest.fn(async () => ({
        tenantId,
        state: 'ACTIVE' as const,
        databaseName: 'tenant_db',
        host: 'localhost',
        port: 3306,
        dbUser: 'tenant_db_user',
        sealedPassword: 'sealed-password',
        schemaVersion: 'migration-1',
      })),
      update: jest.fn(async ({ data }: { data: { state: 'RESTORING' } }) => {
        state = data.state;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { tenantId: bigint; state: 'RESTORING' };
          data: { state: 'ACTIVE' };
        }) => {
          if (state === where.state) {
            state = data.state;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    };
    const control = {
      tenant: { findUnique: jest.fn(async () => ({ id: tenantId, name: tenantName })) },
      tenantDatabase,
      auditLog: { create: jest.fn() },
    };
    const invalidate = jest.fn(async () => undefined);
    const prisma = {
      tenancyMode: 'isolated',
      control: () => control,
      router: { invalidate },
    } as unknown as PrismaService;
    const values: Record<string, string | number | undefined> = {
      BACKUP_DIR: root,
      BACKUP_ENCRYPTION_KEY: undefined,
      DATABASE_URL: 'mysql://control:pass@localhost:3306/control_db',
      MYSQL_PATH: 'mysql',
      TENANT_DB_STATE_TTL_MS: 1,
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
    const databases = {
      databaseUrl: jest.fn(() => 'mysql://tenant:pass@localhost:3306/tenant_db'),
    } as unknown as TenantDatabaseProvisioner;
    const service = new BackupRestoreTenantService(prisma, config, databases);
    const waitForDrain = jest.fn(async () => undefined);
    Object.defineProperty(service, 'waitForDrain', { value: waitForDrain });

    await expect(service.run(folder, tenantId, tenantName)).rejects.toThrow('Tenant restore interrupted');

    expect(waitForDrain).toHaveBeenCalledTimes(1);
    expect(waitForDrain.mock.invocationCallOrder[0]).toBeLessThan(withOptionFile.mock.invocationCallOrder[0]);
    expect(dropTenantDatabaseTables).not.toHaveBeenCalled();
    expect(state).toBe('ACTIVE');
    expect(tenantDatabase.updateMany).toHaveBeenCalledWith({
      where: { tenantId, state: 'RESTORING' },
      data: { state: 'ACTIVE' },
    });
    expect(invalidate).toHaveBeenCalled();
    expect(lockConnection.end).toHaveBeenCalledTimes(1);
  });
});
