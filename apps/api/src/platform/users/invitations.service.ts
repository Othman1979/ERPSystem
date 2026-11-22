import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { invitationCodeMatches, MAX_ATTEMPTS } from './invitation-code.js';

/** The signed-in user's invitations, indexed by UserTenant and read from each tenant database. */
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
    // systemPrisma: UserTenant and display records are control-plane data.
    const control = this.prisma.control();
    const links = await control.userTenant.findMany({
      where: { userId },
      select: { tenantId: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { tenantId: 'asc' }],
    });
    const groups = await Promise.all(
      links.map(async ({ tenantId }) => {
        await this.prisma.router.resolve(tenantId);
        return this.prisma.forTenant(tenantId).tenantMembership.findMany({
          where: { userId, status: 'INVITED' },
          select: { id: true, tenantId: true, userId: true, invitedBy: true, roleId: true, inviteCodeExpiresAt: true, createdAt: true },
          orderBy: { id: 'asc' },
        });
      }),
    );
    const rows = groups.flat();
    if (this.prisma.tenancyMode !== 'isolated') rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const inviterIds = [...new Set(rows.map((r) => r.invitedBy).filter((id) => id !== null))];
    const [tenants, roles, inviters] = await Promise.all([
      control.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
        select: { id: true, name: true },
      }),
      control.role.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.roleId))] } },
        select: { id: true, code: true, nameAr: true, nameEn: true },
      }),
      inviterIds.length
        ? control.user.findMany({
          where: { id: { in: inviterIds } },
          select: { id: true, fullName: true, email: true },
        })
        : Promise.resolve([]),
    ]);
    const inviterById = new Map(inviters.map((u) => [u.id, u]));
    const tenantById = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    const roleById = new Map(roles.map((role) => [role.id, role]));

    return rows.map((r) => {
      const inviter = r.invitedBy !== null ? inviterById.get(r.invitedBy) : undefined;
      const tenant = tenantById.get(r.tenantId);
      const role = roleById.get(r.roleId);
      if (!tenant || !role) throw new DomainError(ErrorCode.INTERNAL, 'Invitation references missing control data');
      return {
        membershipId: this.externalMembershipId(r.tenantId, r.id),
        tenantId: r.tenantId.toString(),
        tenantName: tenant.name,
        role: { code: role.code, nameAr: role.nameAr, nameEn: role.nameEn },
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
  async accept(id: bigint | string, code: string | undefined) {
    const userId = this.caller();
    const found = await this.findInvitation(userId, id);
    const { membershipId, tenantId } = found;
    if (!code || code.trim() === '') {
      // Not counted as an attempt: nothing was guessed.
      throw new DomainError(ErrorCode.INVITATION_CODE_INVALID, 'The invitation code is required', {
        reason: 'CODE_REQUIRED',
        attemptsLeft: null,
      });
    }
    const tenant = await this.prisma.control().tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
    if (!tenant) throw DomainError.notFound('Invitation', String(id));
    const db = this.prisma.forTenant(tenantId);

    const outcome = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenant_memberships WHERE tenant_id = ${tenantId} AND id = ${membershipId} FOR UPDATE`;
      const m = await tx.tenantMembership.findFirst({
        where: { id: membershipId, tenantId, userId, status: 'INVITED' },
        select: {
          inviteCodeHash: true,
          inviteCodeExpiresAt: true,
          inviteCodeAttempts: true,
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
      return { kind: 'accepted' as const };
    });

    if (outcome.kind === 'gone') throw DomainError.notFound('Invitation', String(id));
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
      membershipId: this.externalMembershipId(tenantId, membershipId),
      tenantId: tenantId.toString(),
      tenantName: tenant.name,
    };
  }

  async decline(id: bigint | string): Promise<void> {
    const userId = this.caller();
    const { tenantId, membershipId } = await this.findInvitation(userId, id);
    await this.prisma.forTenant(tenantId).$transaction(async (tx) => {
      const invitation = await tx.tenantMembership.findFirst({
        where: { id: membershipId, userId, status: 'INVITED' },
        select: { tenantId: true },
      });
      if (!invitation) throw DomainError.notFound('Invitation', String(id));

      // Conditional again: an accept racing this decline may have won since the read.
      const removed = await tx.tenantMembership.deleteMany({
        where: { id: membershipId, userId, status: 'INVITED' },
      });
      if (removed.count === 0) throw DomainError.notFound('Invitation', String(id));

      await tx.auditLog.create({
        data: {
          tenantId: invitation.tenantId,
          userId,
          action: 'user.invite_decline',
          entityType: 'tenant_membership',
          entityId: membershipId.toString(),
        },
      });
      if (this.prisma.tenancyMode !== 'isolated') {
        await tx.userTenant.deleteMany({ where: { userId, tenantId } });
      }
    });
    if (this.prisma.tenancyMode === 'isolated') {
      await this.prisma.control().userTenant.deleteMany({ where: { userId, tenantId } });
    }
  }

  private parseMembershipId(value: bigint | string): { membershipId: bigint; tenantId?: bigint } {
    const text = value.toString();
    const separator = text.indexOf(':');
    if (separator < 0) return { membershipId: BigInt(text) };
    return {
      tenantId: BigInt(text.slice(0, separator)),
      membershipId: BigInt(text.slice(separator + 1)),
    };
  }

  private externalMembershipId(tenantId: bigint, membershipId: bigint): string {
    return this.prisma.tenancyMode === 'isolated' ? `${tenantId}:${membershipId}` : membershipId.toString();
  }

  private async findInvitation(userId: bigint, value: bigint | string): Promise<{ tenantId: bigint; membershipId: bigint }> {
    const requested = this.parseMembershipId(value);
    const links = await this.prisma.control().userTenant.findMany({
      where: { userId, ...(requested.tenantId !== undefined ? { tenantId: requested.tenantId } : {}) },
      select: { tenantId: true },
      orderBy: { tenantId: 'asc' },
    });
    const matches: bigint[] = [];
    for (const { tenantId } of links) {
      await this.prisma.router.resolve(tenantId);
      const membership = await this.prisma.forTenant(tenantId).tenantMembership.findFirst({
        where: { id: requested.membershipId, userId, status: 'INVITED' },
        select: { id: true },
      });
      if (membership) matches.push(tenantId);
    }
    if (matches.length !== 1) throw DomainError.notFound('Invitation', String(value));
    return { tenantId: matches[0]!, membershipId: requested.membershipId };
  }
}
