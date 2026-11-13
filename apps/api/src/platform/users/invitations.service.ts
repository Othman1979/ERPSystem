import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/**
 * The signed-in user's own invitations (an INVITED membership they accept or
 * decline). The caller has no tenant context here: every query is system-wide
 * and filtered by the caller's userId, so nobody sees another user's invitations.
 */
@Injectable()
export class InvitationsService {
  constructor(private readonly prisma: PrismaService) {}

  private caller(): bigint {
    const userId = ClsServiceManager.getClsService<RequestContext>().get('userId');
    if (!userId) throw new DomainError(ErrorCode.UNAUTHORIZED, 'Not authenticated');
    return userId;
  }

  async list() {
    const userId = this.caller();
    // systemPrisma: invitations span tenants; the caller's own userId is the only filter.
    const rows = await this.prisma.client.tenantMembership.findMany({
      where: { userId, status: 'INVITED' },
      select: {
        id: true,
        tenantId: true,
        invitedBy: true,
        createdAt: true,
        tenant: { select: { name: true } },
        role: { select: { code: true, nameAr: true, nameEn: true } },
      },
      orderBy: { id: 'asc' },
    });

    const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((id) => id !== null))];
    // systemPrisma: one lookup for the inviters' display names (users are platform-global).
    const inviters = inviterIds.length
      ? await this.prisma.client.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, fullName: true, email: true },
        })
      : [];
    const inviterById = new Map(inviters.map((u) => [u.id, u]));

    return rows.map((r) => {
      const inviter = r.invitedBy !== null ? inviterById.get(r.invitedBy) : undefined;
      return {
        membershipId: r.id.toString(),
        tenantId: r.tenantId.toString(),
        tenantName: r.tenant.name,
        role: r.role,
        invitedBy: inviter ? { fullName: inviter.fullName, email: inviter.email } : null,
        invitedAt: r.createdAt,
      };
    });
  }

  async accept(membershipId: bigint) {
    const userId = this.caller();
    // systemPrisma: the invitation belongs to the caller's userId, not to a tenant context.
    return this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.tenantMembership.updateMany({
        where: { id: membershipId, userId, status: 'INVITED' },
        data: { status: 'ACTIVE' },
      });
      if (updated.count === 0) throw DomainError.notFound('Invitation', membershipId.toString());

      const membership = await tx.tenantMembership.findFirstOrThrow({
        where: { id: membershipId },
        select: { tenantId: true, tenant: { select: { name: true } } },
      });
      // Written with the invitation's own tenant: AuditService would use the current tenant of the caller.
      await tx.auditLog.create({
        data: {
          tenantId: membership.tenantId,
          userId,
          action: 'user.invite_accept',
          entityType: 'tenant_membership',
          entityId: membershipId.toString(),
        },
      });
      return {
        membershipId: membershipId.toString(),
        tenantId: membership.tenantId.toString(),
        tenantName: membership.tenant.name,
      };
    });
  }

  async decline(membershipId: bigint): Promise<void> {
    const userId = this.caller();
    // systemPrisma: the invitation belongs to the caller's userId, not to a tenant context.
    await this.prisma.client.$transaction(async (tx) => {
      const invitation = await tx.tenantMembership.findFirst({
        where: { id: membershipId, userId, status: 'INVITED' },
        select: { tenantId: true },
      });
      if (!invitation) throw DomainError.notFound('Invitation', membershipId.toString());

      // Conditional again: an accept racing this decline may have won since the read.
      const removed = await tx.tenantMembership.deleteMany({
        where: { id: membershipId, userId, status: 'INVITED' },
      });
      if (removed.count === 0) throw DomainError.notFound('Invitation', membershipId.toString());

      await tx.auditLog.create({
        data: {
          tenantId: invitation.tenantId,
          userId,
          action: 'user.invite_decline',
          entityType: 'tenant_membership',
          entityId: membershipId.toString(),
        },
      });
    });
  }
}
