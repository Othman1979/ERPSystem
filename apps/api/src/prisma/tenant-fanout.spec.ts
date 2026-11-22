import { jest } from '@jest/globals';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';
import { TenantFanoutService } from './tenant-fanout.js';

describe('TenantFanoutService', () => {
  it('uses the control database in shared mode and runs each tenant in job context', async () => {
    const control = { tenant: { findMany: async () => [{ id: 1n }, { id: 2n }] } };
    const cls = {
      run: async (fn: () => Promise<unknown>) => fn(),
      set: jest.fn(),
    };
    const prisma = {
      tenancyMode: 'shared',
      control: () => control,
      forTenant: () => control,
      router: { resolve: jest.fn() },
    };
    const fanout = new TenantFanoutService(prisma as never, cls as never);

    const databases = await fanout.databases();
    expect(databases).toHaveLength(1);
    expect(databases[0]).toEqual({ tenantId: null, client: control });
    expect(databases.unavailable).toEqual([]);
    const run = await fanout.forEachTenant(async (client, tenantId) => ({ client, tenantId }));
    expect(run.results.map(({ tenantId }) => tenantId)).toEqual([1n, 2n]);
    expect(run.unavailable).toEqual([]);
    expect(cls.set).toHaveBeenCalledWith('jobContext', true);
  });

  it('resolves active tenant databases and reports unavailable databases without throwing', async () => {
    const control = {
      tenantDatabase: {
        findMany: async () => [{ tenantId: 1n }, { tenantId: 2n }, { tenantId: 3n }],
      },
    };
    const clients = new Map([[1n, { id: 'a' }], [3n, { id: 'c' }]]);
    const router = {
      resolve: async (tenantId: bigint) => {
        if (tenantId === 2n) throw new DomainError(ErrorCode.TENANT_MAINTENANCE, 'maintenance');
      },
    };
    const prisma = {
      tenancyMode: 'isolated',
      control: () => control,
      forTenant: (tenantId: bigint) => clients.get(tenantId),
      router,
    };
    const fanout = new TenantFanoutService(prisma as never, { run: async (fn: () => Promise<unknown>) => fn(), set: jest.fn() } as never);

    const databases = await fanout.databases();
    expect([...databases]).toEqual([
      { tenantId: 1n, client: { id: 'a' } },
      { tenantId: 3n, client: { id: 'c' } },
    ]);
    expect(databases.unavailable).toEqual([2n]);
  });

  it('reports missing databases from forEachTenant and keeps processing other tenants', async () => {
    const control = { tenant: { findMany: async () => [{ id: 1n }, { id: 2n }] } };
    const router = {
      resolve: async (tenantId: bigint) => {
        if (tenantId === 1n) throw new DomainError(ErrorCode.TENANT_DB_NOT_FOUND, 'missing');
      },
    };
    const prisma = {
      tenancyMode: 'isolated',
      control: () => control,
      forTenant: (tenantId: bigint) => ({ id: tenantId }),
      router,
    };
    const fanout = new TenantFanoutService(prisma as never, { run: async (fn: () => Promise<unknown>) => fn(), set: jest.fn() } as never);

    const result = await fanout.forEachTenant(async (client) => client);
    expect(result.unavailable).toEqual([1n]);
    expect(result.results).toEqual([{ tenantId: 2n, result: { id: 2n } }]);
  });
});
