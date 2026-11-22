import { TenantProvisioningService } from './tenant-provisioning.service.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

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
});
