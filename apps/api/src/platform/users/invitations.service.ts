import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { invitationCodeMatches, MAX_ATTEMPTS } from './invitation-code.js';

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
        inviteCodeExpiresAt: true,
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
        // After this the person needs a new code from the company.
        codeExpiresAt: r.inviteCodeExpiresAt,
      };
    });
  }

  /**
   * Joins the company with the acceptance code its admin handed over (owner
   * decision, ADR-012 §PLAT-10). Holding the invited account is not enough: a
   * company that created this account (and knows its first password) cannot
   * accept another company's invitation without that company's code.
   *
   * The row is locked while the code is checked, so parallel guesses are
   * counted one by one; a wrong code's count is committed before the refusal.
   */
  async accept(membershipId: bigint, code: string | undefined) {
    const userId = this.caller();
    // systemPrisma: the invitation belongs to the caller's userId, not to a tenant context.
    const db = this.prisma.client;
    const found = await db.tenantMembership.findFirst({
      where: { id: membershipId, userId, status: 'INVITED' },
      select: { tenantId: true },
    });
    // Ownership first: another user's invitation is 404 whatever the body holds.
    if (!found) throw DomainError.notFound('Invitation', membershipId.toString());
    if (!code || code.trim() === '') {
      // Not counted as an attempt: nothing was guessed.
      throw new DomainError(ErrorCode.INVITATION_CODE_INVALID, 'The invitation code is required', {
        reason: 'CODE_REQUIRED',
        attemptsLeft: null,
      });
    }
    const tenantId = found.tenantId;

    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenant_memberships WHERE tenant_id = ${tenantId} AND id = ${membershipId} FOR UPDATE`;
      const m = await tx.tenantMembership.findFirst({
        where: { id: membershipId, tenantId, userId, status: 'INVITED' },
        select: {
          inviteCodeHash: true,
          inviteCodeExpiresAt: true,
          inviteCodeAttempts: true,
          tenant: { select: { name: true } },
        },
      });
      if (!m) return { kind: 'gone' as const };
      const audit = (action: string, after?: object) =>
        // Written with the invitation's own tenant: AuditService would use the caller's current tenant.
        tx.auditLog.create({
          data: { tenantId, userId, action, entityType: 'tenant_membership', entityId: membershipId.toString(), afterJson: after },
        });

      if (!m.inviteCodeHash || !m.inviteCodeExpiresAt) return { kind: 'refused' as const, reason: 'NO_CODE', attemptsLeft: 0 };
      if (m.inviteCodeExpiresAt.getTime() <= Date.now()) return { kind: 'refused' as const, reason: 'EXPIRED', attemptsLeft: 0 };
      if (m.inviteCodeAttempts >= MAX_ATTEMPTS) return { kind: 'refused' as const, reason: 'TOO_MANY_ATTEMPTS', attemptsLeft: 0 };
      if (!invitationCodeMatches(code, m.inviteCodeHash)) {
        const attempts = m.inviteCodeAttempts + 1;
        await tx.tenantMembership.update({ where: { id: membershipId }, data: { inviteCodeAttempts: attempts } });
        await audit('user.invite_code_wrong', { attempts });
        return { kind: 'refused' as const, reason: 'WRONG_CODE', attemptsLeft: MAX_ATTEMPTS - attempts };
      }

      await tx.tenantMembership.update({
        where: { id: membershipId },
        data: { status: 'ACTIVE', inviteCodeHash: null, inviteCodeExpiresAt: null, inviteCodeAttempts: 0 },
      });
      await audit('user.invite_accept');
      return { kind: 'accepted' as const, tenantName: m.tenant.name };
    });

    if (outcome.kind === 'gone') throw DomainError.notFound('Invitation', membershipId.toString());
    if (outcome.kind === 'refused') {
      throw new DomainError(
        ErrorCode.INVITATION_CODE_INVALID,
        outcome.reason === 'WRONG_CODE'
          ? 'The invitation code is wrong'
          : 'The invitation code can no longer be used; ask the company for a new one',
        { reason: outcome.reason, attemptsLeft: outcome.attemptsLeft },
      );
    }
    return {
      membershipId: membershipId.toString(),
      tenantId: tenantId.toString(),
      tenantName: outcome.tenantName,
    };
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
