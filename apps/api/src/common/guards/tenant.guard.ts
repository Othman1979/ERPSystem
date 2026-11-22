import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import {
  IS_PUBLIC_KEY,
  TENANT_OPTIONAL_KEY,
} from '../decorators/auth.decorators.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { effectiveMemberPermissions } from '../permissions/member-permissions.js';

const READ_ONLY_STATUSES = new Set(['SUSPENDED', 'CANCELLED']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** A TRIAL tenant whose trial end is in the past; a TRIAL with no end date stays writable. */
function isExpiredTrial(tenant: { status: string; trialEndsAt: Date | null }): boolean {
  return (
    tenant.status === 'TRIAL' &&
    tenant.trialEndsAt !== null &&
    tenant.trialEndsAt.getTime() < Date.now()
  );
}

/**
 * Resolves tenant context: verifies membership is ACTIVE, loads role
 * permissions into CLS, and enforces read-only mode for SUSPENDED/CANCELLED
 * tenants (docs/BUILD_PLAN.md §13.2).
 *
 * Resolves the tenant database before reading membership; systemPrisma reads
 * the role and tenant status from control-plane records.
 */
@Injectable()
export class TenantGuard implements CanActivate {
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
    const userId = cls.get('userId');
    if (tenantId === undefined || userId === undefined) {
      throw new DomainError(ErrorCode.UNAUTHORIZED, 'No tenant selected');
    }

    await this.prisma.router.resolve(tenantId);
    const tenantDb = this.prisma.forTenant(tenantId);
    const membership = await tenantDb.tenantMembership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      select: {
        id: true,
        roleId: true,
        customRoleId: true,
        extraPermissions: { select: { permissionCode: true, amountLimit: true } },
      },
    });
    if (!membership) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'No active membership for this tenant');
    }

    const [role, customRole, tenant] = await Promise.all([
      this.prisma.control().role.findUnique({
        where: { id: membership.roleId },
        include: { permissions: true },
      }),
      membership.customRoleId
        ? tenantDb.tenantRole.findUnique({
            where: { id: membership.customRoleId },
            select: { permissions: { select: { permissionCode: true } } },
          })
        : Promise.resolve(null),
      this.prisma.control().tenant.findUnique({
        where: { id: tenantId },
        select: { status: true, trialEndsAt: true },
      }),
    ]);
    if (!role) throw new DomainError(ErrorCode.INTERNAL, 'Tenant membership role is missing');
    if (!tenant) {
      throw new DomainError(ErrorCode.NOT_FOUND, 'Tenant not found');
    }

    const request = context.switchToHttp().getRequest<{ method: string }>();
    if (!SAFE_METHODS.has(request.method)) {
      if (READ_ONLY_STATUSES.has(tenant.status)) {
        throw new DomainError(
          ErrorCode.TENANT_READ_ONLY,
          `Tenant is ${tenant.status}; write operations are disabled`,
        );
      }
      // An expired trial is read-only at once, not after the daily status job (PLAT-25).
      if (isExpiredTrial(tenant)) {
        throw new DomainError(ErrorCode.TENANT_READ_ONLY, 'Trial ended; write operations are disabled');
      }
    }

    cls.set('membershipId', membership.id);
    // The role's permissions, plus the member's purchase permissions (ADR-024 §3.4).
    const extra = effectiveMemberPermissions(role.code, membership.extraPermissions);
    cls.set(
      'permissions',
      // A tenant role (ADR-038) replaces the system role's permissions; never an owner's.
      new Set([...((role.code !== 'OWNER' && customRole) || role).permissions.map((p) => p.permissionCode), ...extra.codes]),
    );
    cls.set('roleCode', role.code);
    return true;
  }
}
