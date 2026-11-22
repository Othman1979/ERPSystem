import { TenantProvisioningService } from './tenant-provisioning.service.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { jest } from '@jest/globals';

describe('TenantProvisioningService', () => {
  it('rejects an empty pool before registration writes', async () => {
    let transactionCalls = 0;
    const control = {
      tenantDbPool: { findFirst: async () => null },
      $transaction: async () => { transactionCalls += 1; },
    };
    const service = new TenantProvisioningService(
      { control: () => control } as never,
      { get: (name: string) => (name === 'DB_PROVISIONER' ? 'pool' : undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const dto = {
      tenantName: 'Tenant',
      ownerName: 'Owner',
      email: 'owner@example.test',
      password: 'long-password',
    };

    await expect(service.registerIsolated(dto as never, {}, 'hash')).rejects.toMatchObject({
      code: ErrorCode.REGISTRATION_UNAVAILABLE,
    });
    expect(transactionCalls).toBe(0);
  });

  it('alerts that the pool is exhausted and throttles repeated empty-pool sign-ups', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const control = {
      tenantDbPool: { findFirst: async () => null },
      $transaction: async () => {
        throw new Error('registration writes must not run');
      },
    };
    const service = new TenantProvisioningService(
      { control: () => control } as never,
      {
        get: (name: string) => {
          if (name === 'DB_PROVISIONER') return 'pool';
          if (name === 'ALERT_WEBHOOK_URL') return 'https://alerts.example.test/webhook';
          return undefined;
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const dto = {
      tenantName: 'Tenant',
      ownerName: 'Owner',
      email: 'owner@example.test',
      password: 'long-password',
    };

    try {
      await expect(service.registerIsolated(dto as never, {}, 'hash')).rejects.toMatchObject({
        code: ErrorCode.REGISTRATION_UNAVAILABLE,
      });
      await expect(service.registerIsolated(dto as never, {}, 'hash')).rejects.toMatchObject({
        code: ErrorCode.REGISTRATION_UNAVAILABLE,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { text: string };
      expect(body.text).toContain('pool exhausted (0 free)');
    } finally {
      fetch.mockRestore();
    }
  });

  it('alerts when the last pool row is claimed before the registration transaction', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    const user = { id: 3n, email: 'owner@example.test' };
    const tenant = { id: 4n, name: 'Tenant' };
    const tx = {
      plan: { findFirst: async () => ({ id: 1n }) },
      user: { findUnique: async () => null, create: async () => user },
      tenant: { create: async () => tenant },
      subscription: { create: async () => undefined },
    };
    const control = {
      tenantDbPool: { findFirst: async () => ({ id: 2n }) },
      $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
    };
    const service = new TenantProvisioningService(
      { control: () => control } as never,
      {
        get: (name: string) => {
          if (name === 'DB_PROVISIONER') return 'pool';
          if (name === 'ALERT_WEBHOOK_URL') return 'https://alerts.example.test/webhook';
          if (name === 'TRIAL_DAYS') return 14;
          return undefined;
        },
      } as never,
      { claimPoolDatabase: async () => null } as never,
      {} as never,
      {} as never,
    );
    const dto = {
      tenantName: 'Tenant',
      ownerName: 'Owner',
      email: 'owner@example.test',
      password: 'long-password',
    };

    try {
      await expect(service.registerIsolated(dto as never, {}, 'hash')).rejects.toMatchObject({
        code: ErrorCode.REGISTRATION_UNAVAILABLE,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as { text: string };
      expect(body.text).toContain('pool exhausted (0 free)');
    } finally {
      fetch.mockRestore();
    }
  });
});
