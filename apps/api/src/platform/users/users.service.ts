import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PasswordService } from '../auth/password.service.js';
import { generateTemporaryPassword, temporaryPasswordWrites } from '../auth/temporary-password.js';
import { InviteUserDto, UpdateMembershipDto } from './dto/users.dto.js';
import { issueInvitationCode } from './invitation-code.js';

const membershipInclude = {
  user: { select: { id: true, email: true, fullName: true, isActive: true } },
  role: { select: { code: true, nameAr: true, nameEn: true } },
  defaultBranch: { select: { id: true, code: true, nameAr: true } },
  allowedBranches: { include: { branch: { select: { id: true, code: true, nameAr: true } } } },
} as const;

function serialize(m: {
  id: bigint;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  user: { id: bigint; email: string; fullName: string; isActive: boolean };
  role: { code: string; nameAr: string; nameEn: string | null };
  defaultBranch: { id: bigint; code: string; nameAr: string } | null;
  allowedBranches: { branch: { id: bigint; code: string; nameAr: string } }[];
}) {
  return {
    membershipId: m.id.toString(),
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    user: {
      ...m.user,
      id: m.user.id.toString(),
      // The invitee's name stays hidden from the inviting company until they accept.
      fullName: m.status === 'INVITED' ? null : m.user.fullName,
    },
    role: m.role,
    defaultBranch: m.defaultBranch
      ? { ...m.defaultBranch, id: m.defaultBranch.id.toString() }
      : null,
    branches: m.allowedBranches.map((b) => ({
      ...b.branch,
      id: b.branch.id.toString(),
    })),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly planLimits: PlanLimitsService,
    private readonly audit: AuditService,
  ) {}

  private tenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return this.prisma.forTenant(tenantId);
  }

  async list() {
    const rows = await this.tenant().tenantMembership.findMany({
      include: membershipInclude,
      orderBy: { id: 'asc' },
    });
    return rows.map(serialize);
  }

  async roles() {
    // Role/RolePermission are platform-global reference data.
    return this.prisma.client.role.findMany({
      where: { isSystem: true },
      include: { permissions: { select: { permissionCode: true } } },
      orderBy: { id: 'asc' },
    });
  }

  /** Role code of the calling member in the current tenant (PLAT-01). */
  private async callerRoleCode(): Promise<string | undefined> {
    const selfId = ClsServiceManager.getClsService<RequestContext>().get('membershipId');
    if (!selfId) return undefined;
    const self = await this.tenant().tenantMembership.findFirst({
      where: { id: selfId },
      select: { role: { select: { code: true } } },
    });
    return self?.role.code;
  }

  /**
   * Invites a person to the current company. An existing user gets an INVITED
   * membership and accepts it themself (GET /me/invitations). A new user gets an
   * ACTIVE membership and a generated temporary password, returned once here.
   */
  async invite(dto: InviteUserDto) {
    const prisma = this.tenant();
    const role = await this.prisma.client.role.findUnique({ where: { code: dto.roleCode } });
    if (!role) throw DomainError.notFound('Role', dto.roleCode);
    if (role.code === 'OWNER' && (await this.callerRoleCode()) !== 'OWNER') {
      throw new DomainError(ErrorCode.FORBIDDEN, 'Only an owner can grant the owner role');
    }

    const branchIds = dto.branchIds?.map(BigInt) ?? [];
    if (branchIds.length > 0) {
      const found = await prisma.branch.findMany({ where: { id: { in: branchIds } } });
      if (found.length !== branchIds.length) {
        throw new DomainError(ErrorCode.VALIDATION, 'One or more branches are invalid');
      }
    }
    if (dto.defaultBranchId) {
      const branch = await prisma.branch.findFirst({
        where: { id: BigInt(dto.defaultBranchId) },
      });
      if (!branch) throw DomainError.notFound('Branch', dto.defaultBranchId);
    }

    // Hash before the transaction: it holds the tenant lock (plan limit).
    // systemPrisma: users is a platform-global table.
    const knownUser = await this.prisma.client.user.findUnique({ where: { email: dto.email } });
    let temporaryPassword: string | undefined;
    let newUser: Prisma.UserCreateInput | undefined;
    if (!knownUser) {
      // A new account signs in with a generated password and must replace it first (ADR-012).
      temporaryPassword = generateTemporaryPassword();
      newUser = {
        email: dto.email,
        fullName: dto.fullName ?? dto.email.split('@')[0]!,
        passwordHash: await this.passwords.hash(temporaryPassword),
        mustChangePassword: true,
      };
    }

    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId')!;
    const invitedBy = cls.get('userId');
    const { membership, createdUser, status, acceptanceCode, codeExpiresAt } = await prisma.$transaction(async (tx) => {
      // First statement: locks the tenant row so concurrent invites cannot overshoot the plan (PLAT-04).
      await this.planLimits.assertUserSlotAvailable(tx);

      const existingMembership = await tx.tenantMembership.findFirst({
        where: { user: { email: dto.email } },
      });
      if (existingMembership) {
        throw new DomainError(ErrorCode.CONFLICT, 'User is already a member of this tenant');
      }

      let user = await tx.user.findUnique({ where: { email: dto.email } });
      const createdUser = !user;
      if (!user) {
        if (!newUser)
          throw new DomainError(ErrorCode.CONFLICT, 'User changed during invite; retry');
        user = await tx.user.create({ data: newUser });
      }

      // An existing user accepts the invitation themself; only a brand-new account is active at once.
      const status = createdUser ? 'ACTIVE' : 'INVITED';
      // The invited person accepts only with this code, handed over by the admin
      // (ADR-012 §PLAT-10): holding their account is not enough to join.
      const issued = status === 'INVITED' ? issueInvitationCode() : null;
      const membership = await tx.tenantMembership.create({
        data: {
          tenantId,
          userId: user.id,
          roleId: role.id,
          status,
          ...(issued?.data ?? {}),
          defaultBranchId: dto.defaultBranchId ? BigInt(dto.defaultBranchId) : null,
          invitedBy,
          allowedBranches: {
            create: branchIds.map((branchId) => ({ branchId })),
          },
        },
        include: membershipInclude,
      });
      return { membership, createdUser, status, acceptanceCode: issued?.code, codeExpiresAt: issued?.data.inviteCodeExpiresAt };
    });

    await this.audit.log({
      action: 'user.invite',
      entityType: 'tenant_membership',
      entityId: membership.id,
      after: { email: dto.email, roleCode: dto.roleCode, status },
    });

    return {
      ...serialize(membership),
      ...(createdUser && temporaryPassword ? { temporaryPassword } : {}),
      // Shown once: the admin gives it to the person directly.
      ...(acceptanceCode ? { acceptanceCode, acceptanceCodeExpiresAt: codeExpiresAt } : {}),
    };
  }

  /**
   * Issues a new acceptance code for a pending invitation; the old one stops
   * working and the attempt count starts again (ADR-012 §PLAT-10).
   */
  async reissueInvitationCode(membershipId: bigint): Promise<{ membershipId: string; acceptanceCode: string; acceptanceCodeExpiresAt: Date }> {
    const prisma = this.tenant();
    const issued = issueInvitationCode();
    // Tenant-scoped: another company's membership id matches nothing (404).
    const updated = await prisma.tenantMembership.updateMany({
      where: { id: membershipId, status: 'INVITED' },
      data: issued.data,
    });
    if (updated.count === 0) throw DomainError.notFound('Invitation', membershipId.toString());
    await this.audit.log({
      action: 'user.invite_code_reissue',
      entityType: 'tenant_membership',
      entityId: membershipId,
    });
    return {
      membershipId: membershipId.toString(),
      acceptanceCode: issued.code,
      acceptanceCodeExpiresAt: issued.data.inviteCodeExpiresAt,
    };
  }

  async update(membershipId: bigint, dto: UpdateMembershipDto) {
    const prisma = this.tenant();
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId },
      include: { role: true },
    });
    if (!membership) throw DomainError.notFound('Membership', membershipId.toString());
    // Only the invitee accepts an invitation (or the inviter cancels it, see suspend()).
    if (membership.status === 'INVITED' && dto.status !== undefined) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'An invited member accepts the invitation themself');
    }

    // PLAT-01: no self role/status change; only an owner grants OWNER or
    // touches an owner's membership.
    const selfId = ClsServiceManager.getClsService<RequestContext>().get('membershipId');
    if (membershipId === selfId && (dto.roleCode !== undefined || dto.status !== undefined)) {
      throw new DomainError(ErrorCode.FORBIDDEN, 'You cannot change your own role or status');
    }
    if (
      (membership.role.code === 'OWNER' || dto.roleCode === 'OWNER') &&
      (await this.callerRoleCode()) !== 'OWNER'
    ) {
      throw new DomainError(
        ErrorCode.FORBIDDEN,
        'Only an owner can grant the owner role or change an owner',
      );
    }

    const data: Prisma.TenantMembershipUncheckedUpdateInput = {};
    // Only an ACTIVE owner counts toward the last-owner rule (the count below is
    // ACTIVE owners), so re-roling an OWNER invitation or a suspended owner is
    // not removing an owner.
    const activeOwner = membership.role.code === 'OWNER' && membership.status === 'ACTIVE';
    let removesOwner = false;
    if (dto.roleCode !== undefined) {
      const role = await this.prisma.client.role.findUnique({ where: { code: dto.roleCode } });
      if (!role) throw DomainError.notFound('Role', dto.roleCode);
      removesOwner ||= activeOwner && role.code !== 'OWNER';
      data.roleId = role.id;
    }
    if (dto.status !== undefined) {
      removesOwner ||= activeOwner && dto.status === 'SUSPENDED';
      data.status = dto.status;
    }
    if (dto.defaultBranchId !== undefined) {
      data.defaultBranchId = dto.defaultBranchId ? BigInt(dto.defaultBranchId) : null;
      if (dto.defaultBranchId) {
        const branch = await prisma.branch.findFirst({
          where: { id: BigInt(dto.defaultBranchId) },
        });
        if (!branch) throw DomainError.notFound('Branch', dto.defaultBranchId);
      }
    }

    await prisma.$transaction(async (tx) => {
      if (removesOwner) {
        // Never remove the last active OWNER. The tenant row lock comes first
        // so two owners demoting each other at once cannot both pass the
        // count (the count's snapshot is taken after the lock).
        const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
        await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
        // Only ACTIVE owners count: an OWNER invitation not yet accepted protects nothing.
        const ownerCount = await tx.tenantMembership.count({
          where: { role: { code: 'OWNER' }, status: 'ACTIVE' },
        });
        if (ownerCount <= 1) {
          throw new DomainError(
            ErrorCode.CONFLICT,
            'Cannot remove or suspend the last active OWNER',
          );
        }
      }
      await tx.tenantMembership.update({ where: { id: membershipId }, data });
    });

    if (dto.branchIds !== undefined) {
      const branchIds = dto.branchIds.map(BigInt);
      if (branchIds.length > 0) {
        const found = await prisma.branch.findMany({ where: { id: { in: branchIds } } });
        if (found.length !== branchIds.length) {
          throw new DomainError(ErrorCode.VALIDATION, 'One or more branches are invalid');
        }
      }
      const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
      await prisma.membershipBranch.deleteMany({ where: { membershipId } });
      if (branchIds.length > 0) {
        await prisma.membershipBranch.createMany({
          data: branchIds.map((branchId) => ({ tenantId, membershipId, branchId })),
        });
      }
    }

    await this.audit.log({
      action: 'user.update_membership',
      entityType: 'tenant_membership',
      entityId: membershipId,
      before: { roleCode: membership.role.code, status: membership.status },
      after: dto,
    });

    const refreshed = await prisma.tenantMembership.findFirstOrThrow({
      where: { id: membershipId },
      include: membershipInclude,
    });
    return serialize(refreshed);
  }

  /**
   * Replaces a member's password with a temporary one (ADR-012). The member
   * must change it at next sign-in and every refresh token is revoked. The
   * refusals below are the reasons a reset is not allowed.
   */
  async resetPassword(membershipId: bigint): Promise<{ temporaryPassword: string }> {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const callerId = cls.get('userId');
    const prisma = this.tenant();
    const tenantId = cls.get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId },
      include: { role: { select: { code: true } } },
    });
    if (!membership) throw DomainError.notFound('Membership', membershipId.toString());
    const targetUserId = membership.userId;

    // An invited person has not joined this company: it may not take over their
    // existing identity (they may have no other membership to block it below).
    if (membership.status === 'INVITED') {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_NOT_ALLOWED,
        'This person has not accepted the invitation yet',
      );
    }

    if (targetUserId === callerId) {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_NOT_ALLOWED,
        'Use change password to change your own password',
      );
    }

    // systemPrisma: users and memberships of other tenants are platform-wide; the
    // reads only decide whether a reset is allowed, and no other tenant's data is returned.
    const target = await this.prisma.client.user.findUnique({
      where: { id: targetUserId },
      select: { isPlatformAdmin: true },
    });
    if (target?.isPlatformAdmin) {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_NOT_ALLOWED,
        'A platform administrator password cannot be reset here',
      );
    }
    // Users are global: a reset here would change the password for their other
    // companies too, which would let one company take over another's account.
    const otherTenants = await this.prisma.client.tenantMembership.count({
      where: { userId: targetUserId, tenantId: { not: tenantId } },
    });
    if (otherTenants > 0) {
      throw new DomainError(
        ErrorCode.PASSWORD_RESET_NOT_ALLOWED,
        'This user also belongs to another company; their password cannot be reset from here',
      );
    }
    if (membership.role.code === 'OWNER') {
      if ((await this.callerRoleCode()) !== 'OWNER') {
        throw new DomainError(
          ErrorCode.PASSWORD_RESET_NOT_ALLOWED,
          'Only an owner can reset an owner password',
        );
      }
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const now = new Date();
    // systemPrisma: users and refresh_tokens are platform-wide tables.
    await this.prisma.client.$transaction([
      ...temporaryPasswordWrites(this.prisma.client, targetUserId, passwordHash, now),
    ]);

    await this.audit.log({
      action: 'user.password_reset',
      entityType: 'tenant_membership',
      entityId: membership.id,
      after: { userId: targetUserId.toString() },
    });

    return { temporaryPassword };
  }

  /**
   * Suspends an active member, or cancels a pending invitation (the membership is
   * deleted and its branch links cascade). Suspension goes through update(), which
   * keeps the last-OWNER guard (PLAT-24).
   */
  async suspend(membershipId: bigint) {
    const prisma = this.tenant();
    const current = await prisma.tenantMembership.findFirst({
      where: { id: membershipId },
      select: { status: true, userId: true },
    });
    if (!current) throw DomainError.notFound('Membership', membershipId.toString());
    if (current.status === 'INVITED') return this.cancelInvitation(membershipId);

    const result = await this.update(membershipId, { status: 'SUSPENDED' });

    // Revoke refresh tokens issued for this user in this tenant.
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
    // systemPrisma: refresh_tokens is platform-global; scoped explicitly.
    await this.prisma.client.refreshToken.updateMany({
      where: {
        userId: current.userId,
        tenantId,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });
    await this.audit.log({
      action: 'user.suspend',
      entityType: 'tenant_membership',
      entityId: membershipId,
    });
    return result;
  }

  /** Deletes a pending invitation of the current tenant (membership_branches cascade). */
  private async cancelInvitation(membershipId: bigint) {
    await this.tenant().$transaction(async (tx) => {
      const removed = await tx.tenantMembership.deleteMany({
        where: { id: membershipId, status: 'INVITED' },
      });
      if (removed.count === 0) throw DomainError.notFound('Invitation', membershipId.toString());
    });

    await this.audit.log({
      action: 'user.invite_cancel',
      entityType: 'tenant_membership',
      entityId: membershipId,
    });
    return { membershipId: membershipId.toString(), cancelled: true as const };
  }
}
