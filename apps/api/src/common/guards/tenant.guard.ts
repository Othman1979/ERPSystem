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
 * Uses the system client for lookups because tenantId is not yet trusted —
 * the membership row itself is the authorization proof.
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

    // systemPrisma: resolving the membership IS the tenant check.
    const membership = await this.prisma.client.tenantMembership.findFirst({
      where: { tenantId, userId, status: 'ACTIVE' },
      include: { role: { include: { permissions: true } } },
    });
    if (!membership) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'No active membership for this tenant');
    }

    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, trialEndsAt: true },
    });
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
    cls.set('roleCode', membership.role.code);
    cls.set(
      'permissions',
      new Set(membership.role.permissions.map((p) => p.permissionCode)),
    );
    return true;
  }
}
