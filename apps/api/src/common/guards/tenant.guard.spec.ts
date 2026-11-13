import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TenantGuard } from './tenant.guard.js';

const DAY = 24 * 60 * 60 * 1000;

interface FakeTenant {
  status: string;
  trialEndsAt: Date | null;
}

/** A guard wired to a fake system client that holds one active membership and one tenant. */
function setup(tenant: FakeTenant) {
  const tenantQueries: unknown[] = [];
  const prisma = {
    client: {
      tenantMembership: {
        findFirst: async () => ({
          id: 5n,
          role: { code: 'OWNER', permissions: [{ permissionCode: 'TENANT_READ' }] },
        }),
      },
      tenant: {
        findUnique: async (args: unknown) => {
          tenantQueries.push(args);
          return tenant;
        },
      },
    },
  };
  const reflector = { getAllAndOverride: () => false };
  const guard = new TenantGuard(reflector as unknown as Reflector, prisma as unknown as PrismaService);
  return { guard, tenantQueries };
}

function context(method: string): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ method }) }),
  } as unknown as ExecutionContext;
}

/** Runs the guard inside a CLS context for tenant 7, user 1, as the auth guard would leave it. */
function runAs(guard: TenantGuard, method: string): Promise<boolean> {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  return cls.runWith({ tenantId: 7n, userId: 1n } as RequestContext, () =>
    guard.canActivate(context(method)),
  );
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (err) {
    return err as DomainError;
  }
  throw new Error('expected the guard to refuse the request');
}

describe('TenantGuard: read-only tenants (PLAT-25)', () => {
  it('refuses a write on a TRIAL whose trial ended yesterday, with TENANT_READ_ONLY', async () => {
    const { guard } = setup({ status: 'TRIAL', trialEndsAt: new Date(Date.now() - DAY) });
    const err = await refusal(runAs(guard, 'POST'));
    expect(err).toBeInstanceOf(DomainError);
    expect(err.code).toBe(ErrorCode.TENANT_READ_ONLY);
    expect(err.message).toBe('Trial ended; write operations are disabled');
  });

  it('allows a read on a TRIAL whose trial ended yesterday', async () => {
    const { guard } = setup({ status: 'TRIAL', trialEndsAt: new Date(Date.now() - DAY) });
    await expect(runAs(guard, 'GET')).resolves.toBe(true);
  });

  it('allows a write on a TRIAL whose trial ends in the future', async () => {
    const { guard } = setup({ status: 'TRIAL', trialEndsAt: new Date(Date.now() + DAY) });
    await expect(runAs(guard, 'POST')).resolves.toBe(true);
  });

  it('allows a write on a TRIAL with no end date', async () => {
    const { guard } = setup({ status: 'TRIAL', trialEndsAt: null });
    await expect(runAs(guard, 'POST')).resolves.toBe(true);
  });

  it('refuses a write on a SUSPENDED tenant with the status message', async () => {
    const { guard } = setup({ status: 'SUSPENDED', trialEndsAt: null });
    const err = await refusal(runAs(guard, 'POST'));
    expect(err.code).toBe(ErrorCode.TENANT_READ_ONLY);
    expect(err.message).toBe('Tenant is SUSPENDED; write operations are disabled');
  });

  it('selects status and trialEndsAt of the tenant', async () => {
    const { guard, tenantQueries } = setup({ status: 'ACTIVE', trialEndsAt: null });
    await runAs(guard, 'GET');
    expect(tenantQueries).toEqual([{ where: { id: 7n }, select: { status: true, trialEndsAt: true } }]);
  });
});
