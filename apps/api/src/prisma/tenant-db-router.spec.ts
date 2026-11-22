import { jest } from '@jest/globals';
import { PrismaClient } from '../generated/prisma/client.js';
import { sealSecret } from '../common/crypto/secret-box.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { expectedSchemaVersion } from './schema-version.js';
import {
  TenantDbRouter,
  type TenantDbFactory,
  type TenantDbRouterOptions,
} from './tenant-db-router.js';
import type { Pool } from 'mariadb';

const TENANT_DB_SECRET_KEY = Buffer.alloc(32, 7).toString('base64');

const options: TenantDbRouterOptions = {
  mode: 'isolated',
  poolSize: 3,
  idleMs: 600_000,
  maxPools: 50,
  stateTtlMs: 30_000,
  secretKey: TENANT_DB_SECRET_KEY,
  acquireTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  collation: 'UTF8MB4_UNICODE_CI',
  initSql: ['SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci'],
};

const createDatabase = (tenantId: bigint, state = 'ACTIVE', schemaVersion = expectedSchemaVersion()) => ({
  tenantId,
  host: 'tenant-db.local',
  port: 3306,
  databaseName: `tenant_${tenantId}`,
  dbUser: 'tenant_user',
  passwordSealed: sealSecret('tenant-db-password', TENANT_DB_SECRET_KEY),
  schemaVersion,
  state,
  createdAt: new Date(),
  updatedAt: new Date(),
});

function setup(routerOptions: Partial<TenantDbRouterOptions> = {}) {
  const databases = new Map<bigint, ReturnType<typeof createDatabase>>();
  const findUnique = jest.fn(async ({ where }: { where: { tenantId: bigint } }) => databases.get(where.tenantId) ?? null);
  const control = { tenantDatabase: { findUnique } } as unknown as PrismaClient;
  const connections: Array<{
    client: PrismaClient;
    disconnect: jest.Mock;
    end: jest.Mock;
  }> = [];
  const factory: TenantDbFactory = jest.fn(() => {
    const disconnect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const end = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const client = { $disconnect: disconnect } as unknown as PrismaClient;
    connections.push({ client, disconnect, end });
    return { client, pool: { end } as unknown as Pick<Pool, 'end'> };
  });
  const router = new TenantDbRouter(control, { ...options, ...routerOptions }, factory);
  return { databases, findUnique, control, connections, factory, router };
}

const routers: TenantDbRouter[] = [];

function track<T extends ReturnType<typeof setup>>(fixture: T): T {
  routers.push(fixture.router);
  return fixture;
}

function expectClientError(router: TenantDbRouter, tenantId: bigint, code: ErrorCode): void {
  try {
    router.client(tenantId);
    throw new Error('Expected tenant client lookup to fail');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.close()));
  jest.useRealTimers();
});

describe('TenantDbRouter', () => {
  it('returns the control client without resolving in shared mode', async () => {
    const { control, findUnique, router } = track(setup({ mode: 'shared' }));
    await router.resolve(1n);
    expect(router.client(1n)).toBe(control);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('reports a missing tenant database', async () => {
    const { router } = track(setup());
    await expect(router.resolve(1n)).rejects.toMatchObject({ code: ErrorCode.TENANT_DB_NOT_FOUND });
  });

  it('gates a behind schema and allows a schema ahead of the current migrations', async () => {
    const { databases, router } = track(setup());
    databases.set(1n, createDatabase(1n, 'ACTIVE', `${expectedSchemaVersion().slice(0, -1)}0`));
    await expect(router.resolve(1n)).rejects.toMatchObject({ code: ErrorCode.TENANT_MAINTENANCE });

    databases.set(2n, createDatabase(2n, 'ACTIVE', `${expectedSchemaVersion()}z`));
    await expect(router.resolve(2n)).resolves.toBeUndefined();
  });

  it('rejects non-active databases and closes a cached pool', async () => {
    const { databases, connections, router } = track(setup({ stateTtlMs: 0 }));
    databases.set(1n, createDatabase(1n));
    await router.resolve(1n);
    databases.set(1n, createDatabase(1n, 'MIGRATING'));

    await expect(router.resolve(1n)).rejects.toMatchObject({ code: ErrorCode.TENANT_MAINTENANCE });
    expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
    expect(connections[0].end).toHaveBeenCalledTimes(1);
  });

  it('requires resolution before returning an isolated client', () => {
    const { router } = track(setup());
    expectClientError(router, 1n, ErrorCode.TENANT_DB_NOT_RESOLVED);
  });

  it('shares a pending resolve for concurrent calls', async () => {
    const { databases, findUnique, factory, router } = track(setup());
    databases.set(1n, createDatabase(1n));
    let finishLookup!: () => void;
    findUnique.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishLookup = resolve;
      });
      return databases.get(1n) ?? null;
    });

    const first = router.resolve(1n);
    const second = router.resolve(1n);
    finishLookup();
    await Promise.all([first, second]);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('evicts the least-recently-used pool idle for at least 30 seconds', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const { databases, connections, router } = track(setup({ maxPools: 1 }));
    databases.set(1n, createDatabase(1n));
    databases.set(2n, createDatabase(2n));
    await router.resolve(1n);
    jest.setSystemTime(30_000);
    await router.resolve(2n);

    expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
    expect(connections[0].end).toHaveBeenCalledTimes(1);
    expectClientError(router, 1n, ErrorCode.TENANT_DB_NOT_RESOLVED);
    expect(router.client(2n)).toBe(connections[1].client);
  });

  it('exceeds the pool cap when no entry has been idle for 30 seconds', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const { databases, connections, router } = track(setup({ maxPools: 1 }));
    databases.set(1n, createDatabase(1n));
    databases.set(2n, createDatabase(2n));
    await router.resolve(1n);
    jest.setSystemTime(29_999);
    await router.resolve(2n);

    expect(connections).toHaveLength(2);
    expect(router.client(1n)).toBe(connections[0].client);
    expect(router.client(2n)).toBe(connections[1].client);
  });

  it('closes pools after the idle timeout', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const { databases, connections, router } = track(setup({ idleMs: 100 }));
    databases.set(1n, createDatabase(1n));
    await router.resolve(1n);
    jest.setSystemTime(101);
    await router.sweepIdle();

    expect(connections[0].disconnect).toHaveBeenCalledTimes(1);
    expect(connections[0].end).toHaveBeenCalledTimes(1);
    expectClientError(router, 1n, ErrorCode.TENANT_DB_NOT_RESOLVED);
  });

  it('opens the sealed database password before calling the factory', async () => {
    const { databases, factory, router } = track(setup());
    databases.set(1n, createDatabase(1n));
    await router.resolve(1n);

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ password: 'tenant-db-password' }),
      expect.objectContaining({ poolSize: 3, collation: options.collation, initSql: options.initSql }),
    );
  });

  it('re-reads database state when the state cache TTL expires', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const { databases, findUnique, router } = track(setup({ stateTtlMs: 1_000 }));
    databases.set(1n, createDatabase(1n));
    await router.resolve(1n);
    jest.setSystemTime(500);
    await router.resolve(1n);
    expect(findUnique).toHaveBeenCalledTimes(1);

    jest.setSystemTime(1_001);
    await router.resolve(1n);
    expect(findUnique).toHaveBeenCalledTimes(2);
  });
});
