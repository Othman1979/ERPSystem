import { ClsServiceManager } from 'nestjs-cls';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';
import { AuditService } from './audit.service.js';

/** A fake system client that records every audit_log create it receives. */
function setup() {
  const written: Array<{ data: { tenantId: unknown } }> = [];
  const prisma = {
    client: {
      auditLog: {
        create: async (args: { data: { tenantId: unknown } }) => {
          written.push(args);
          return args;
        },
      },
    },
  };
  const service = new AuditService(prisma as unknown as PrismaService);
  return { service, written };
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
    const { service, written } = setup();
    await inTenant(7n, () => service.log({ action: 'invoice.post' }));
    expect(storedTenantId(written)).toBe(7n);
  });

  it('stores null for a platform record when the entry names tenant null, even inside tenant 7', async () => {
    const { service, written } = setup();
    await inTenant(7n, () => service.log({ action: 'admin.tenant_status', tenantId: null }));
    expect(storedTenantId(written)).toBeNull();
  });

  it('stores the tenant the entry names instead of the CLS tenant', async () => {
    const { service, written } = setup();
    await inTenant(7n, () => service.log({ action: 'x', tenantId: 9n }));
    expect(storedTenantId(written)).toBe(9n);
  });

  it('stores null when there is no CLS tenant and the entry names none', async () => {
    const { service, written } = setup();
    await service.log({ action: 'auth.login_failed' });
    expect(storedTenantId(written)).toBeNull();
  });
});
