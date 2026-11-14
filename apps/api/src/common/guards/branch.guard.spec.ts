import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { REQUIRE_ALL_BRANCHES_KEY } from '../decorators/auth.decorators.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { BranchGuard } from './branch.guard.js';

const MAIN = { id: 1n, code: 'MAIN' };
const B2 = { id: 2n, code: 'B2' };

/**
 * A guard over one company; `assigned` = the member's membership_branches,
 * `active` = the company's active branches (MAIN and B2 unless a test says otherwise).
 */
function setup(assigned: bigint[], requireAllBranches: boolean, active: { id: bigint; code: string }[] = [MAIN, B2]) {
  const db = {
    tenantMembership: { findFirst: async () => ({ defaultBranchId: null }) },
    membershipBranch: { findMany: async () => assigned.map((branchId) => ({ branchId })) },
    branch: { findMany: async () => active },
  };
  const prisma = { forTenant: () => db } as unknown as PrismaService;
  const reflector = {
    getAllAndOverride: (key: string) => key === REQUIRE_ALL_BRANCHES_KEY && requireAllBranches,
  } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
  return { guard: new BranchGuard(reflector, prisma), context };
}

function run<T>(fn: () => Promise<T>): Promise<{ result: T; cls: RequestContext }> {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  return cls.runWith({ tenantId: 7n, membershipId: 5n } as RequestContext, async () => {
    const result = await fn();
    return { result, cls: { branchScope: cls.get('branchScope'), branchId: cls.get('branchId') } as RequestContext };
  });
}

describe('BranchGuard: @RequireAllBranches() (ADR-003 §13)', () => {
  it('lets a member with no assigned branch through, with every branch allowed', async () => {
    const { guard, context } = setup([], true);
    const { result, cls } = await run(() => guard.canActivate(context));
    expect(result).toBe(true);
    expect(cls.branchScope).toBe('ALL');
    expect(cls.branchId).toBe(MAIN.id);
  });

  it('refuses a member with assigned branches, even all of them, with 403 ALL_BRANCHES_REQUIRED', async () => {
    for (const assigned of [[MAIN.id], [MAIN.id, B2.id]]) {
      const { guard, context } = setup(assigned, true);
      const err = await run(() => guard.canActivate(context)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.ALL_BRANCHES_REQUIRED);
      expect((err as DomainError).getStatus()).toBe(403);
    }
  });

  it('refuses every request of a member whose assigned branches are all inactive (BRANCH_NOT_ALLOWED, S4)', async () => {
    // B2 is assigned but no longer active; MAIN is active but not assigned to the member.
    for (const requireAll of [false, true]) {
      const { guard, context } = setup([B2.id], requireAll, [MAIN]);
      const err = await run(() => guard.canActivate(context)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainError);
      expect((err as DomainError).code).toBe(ErrorCode.BRANCH_NOT_ALLOWED);
      expect((err as DomainError).getStatus()).toBe(403);
    }
  });

  it('does not restrict routes without the decorator', async () => {
    const { guard, context } = setup([MAIN.id], false);
    const { result, cls } = await run(() => guard.canActivate(context));
    expect(result).toBe(true);
    expect([...(cls.branchScope as ReadonlySet<bigint>)]).toEqual([MAIN.id]);
  });
});
