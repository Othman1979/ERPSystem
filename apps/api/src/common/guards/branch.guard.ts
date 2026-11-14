import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { IS_PUBLIC_KEY, REQUIRE_ALL_BRANCHES_KEY, TENANT_OPTIONAL_KEY } from '../decorators/auth.decorators.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * BranchGuard (BUILD_PLAN §5.2 step 3, ADR-003). Runs after TenantGuard and
 * resolves the branch of the request into CLS:
 *  - allowed branches = the member's membership_branches; none assigned means
 *    every active branch of the company;
 *  - `X-Branch-Id` header picks the branch and must be allowed, otherwise
 *    403 BRANCH_NOT_ALLOWED;
 *  - without the header: the member's default branch if allowed, else the
 *    first allowed branch (MAIN first when all are allowed).
 * The branch is never taken from the request body.
 * Routes marked @RequireAllBranches() refuse a member with assigned branches
 * (403 ALL_BRANCHES_REQUIRED, ADR-003 §13).
 */
@Injectable()
export class BranchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ||
      this.reflector.getAllAndOverride<boolean>(TENANT_OPTIONAL_KEY, targets)
    ) {
      return true;
    }

    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    const membershipId = cls.get('membershipId');
    // TenantGuard has already rejected requests without a tenant membership.
    if (tenantId === undefined || membershipId === undefined) return true;

    // Tenant-scoped client: the tenant is trusted once TenantGuard has passed.
    const db = this.prisma.forTenant(tenantId);
    const [membership, assigned, active] = await Promise.all([
      db.tenantMembership.findFirst({ where: { id: membershipId }, select: { defaultBranchId: true } }),
      db.membershipBranch.findMany({ where: { membershipId }, select: { branchId: true } }),
      db.branch.findMany({ where: { isActive: true }, select: { id: true, code: true } }),
    ]);
    const activeIds = new Set(active.map((b) => b.id));
    const allowed: ReadonlySet<bigint> | null =
      assigned.length > 0
        ? new Set(assigned.map((a) => a.branchId).filter((id) => activeIds.has(id)))
        : null;
    const isAllowed = (id: bigint) => activeIds.has(id) && (allowed === null || allowed.has(id));

    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | string[] | undefined> }>();
    const raw = request.headers['x-branch-id'];
    const header = Array.isArray(raw) ? raw[0] : raw;

    let branchId: bigint | undefined;
    if (header) {
      if (!/^\d+$/.test(header)) {
        throw new DomainError(ErrorCode.VALIDATION, 'X-Branch-Id must be a numeric id');
      }
      const requested = BigInt(header);
      if (!isAllowed(requested)) {
        throw new DomainError(ErrorCode.BRANCH_NOT_ALLOWED, `Branch ${header} is not allowed for this user`);
      }
      branchId = requested;
    } else if (membership?.defaultBranchId != null && isAllowed(membership.defaultBranchId)) {
      branchId = membership.defaultBranchId;
    } else if (allowed !== null) {
      branchId = [...allowed].sort(byId)[0];
    } else {
      const main = active.find((b) => b.code === 'MAIN');
      branchId = main?.id ?? [...activeIds].sort(byId)[0];
    }

    if (branchId !== undefined) cls.set('branchId', branchId);
    cls.set('allowedBranchIds', allowed);
    if (allowed !== null && this.reflector.getAllAndOverride<boolean>(REQUIRE_ALL_BRANCHES_KEY, targets)) {
      throw new DomainError(
        ErrorCode.ALL_BRANCHES_REQUIRED,
        'This company-wide report is available only to users with access to every branch',
      );
    }
    return true;
  }
}
