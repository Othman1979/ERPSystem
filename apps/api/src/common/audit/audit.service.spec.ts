import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { AuditService } from './audit.service.js';

/** Fake control and tenant clients that record audit_log writes separately. */
function setup(resolveError?: unknown) {
  type Write = { data: { tenantId: unknown; [key: string]: unknown } };
  const tenantWritten: Write[] = [];
  const controlWritten: Write[] = [];
  const create = (written: Write[]) => async (args: Write) => {
    written.push(args);
    return args;
  };
  const prisma = {
    router: {
      resolve: async () => {
        if (resolveError !== undefined) throw resolveError;
      },
    },
    forTenant: () => ({ auditLog: { create: create(tenantWritten) } }),
    control: () => ({ auditLog: { create: create(controlWritten) } }),
  };
  const service = new AuditService(prisma as unknown as PrismaService);
  return { service, tenantWritten, controlWritten };
}

/** Runs the callback with the given tenant in the CLS context, as the tenant guard leaves it. */
function inTenant<T>(tenantId: bigint, fn: () => T): T {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  return cls.runWith({ tenantId, userId: 1n } as RequestContext, fn);
}

function storedTenantId(written: Array<{ data: { tenantId: unknown } }>): unknown {
  return written[0].data.tenantId;
}

describe('AuditService: tenant of an audit row (PLAT-12)', () => {
  it('takes the tenant from the CLS context when the entry does not name one', async () => {
    const { service, tenantWritten } = setup();
    await inTenant(7n, () => service.log({ action: 'invoice.post' }));
    expect(storedTenantId(tenantWritten)).toBe(7n);
  });

  it('stores null for a platform record when the entry names tenant null, even inside tenant 7', async () => {
    const { service, controlWritten } = setup();
    await inTenant(7n, () => service.log({ action: 'admin.tenant_status', tenantId: null }));
    expect(storedTenantId(controlWritten)).toBeNull();
  });

  it('stores the tenant the entry names instead of the CLS tenant', async () => {
    const { service, tenantWritten } = setup();
    await inTenant(7n, () => service.log({ action: 'x', tenantId: 9n }));
    expect(storedTenantId(tenantWritten)).toBe(9n);
  });

  it('stores null when there is no CLS tenant and the entry names none', async () => {
    const { service, controlWritten } = setup();
    await service.log({ action: 'auth.login_failed' });
    expect(storedTenantId(controlWritten)).toBeNull();
  });

  it.each([ErrorCode.TENANT_MAINTENANCE, ErrorCode.TENANT_DB_NOT_FOUND])(
    'stores the same tenant audit row in control when resolve fails with %s',
    async (code) => {
      const { service, tenantWritten, controlWritten } = setup(new DomainError(code, 'unavailable'));
      const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      await inTenant(7n, () => service.log({ action: 'invoice.post', entityId: 12n }));
      expect(tenantWritten).toHaveLength(0);
      expect(controlWritten).toHaveLength(1);
      expect(controlWritten[0].data).toEqual(
        expect.objectContaining({ tenantId: 7n, action: 'invoice.post', entityId: '12' }),
      );
      expect(warning).toHaveBeenCalledWith('Tenant database unavailable; storing audit row in control database');
      warning.mockRestore();
    },
  );

  it('rethrows other tenant database resolution errors without writing an audit row', async () => {
    const error = new Error('resolve failed');
    const { service, tenantWritten, controlWritten } = setup(error);
    await expect(inTenant(7n, () => service.log({ action: 'invoice.post' }))).rejects.toBe(error);
    expect(tenantWritten).toHaveLength(0);
    expect(controlWritten).toHaveLength(0);
  });
});
