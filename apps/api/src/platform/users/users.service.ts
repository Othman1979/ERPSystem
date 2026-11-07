import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PlanLimitsService } from '../../common/plan-limits/plan-limits.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PasswordService } from '../auth/password.service.js';
import { InviteUserDto, UpdateMembershipDto } from './dto/users.dto.js';

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
    user: { ...m.user, id: m.user.id.toString() },
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

  async invite(dto: InviteUserDto) {
    const prisma = this.tenant();
    const role = await this.prisma.client.role.findUnique({ where: { code: dto.roleCode } });
    if (!role) throw DomainError.notFound('Role', dto.roleCode);

    await this.planLimits.assertUserSlotAvailable();

    const existingMembership = await prisma.tenantMembership.findFirst({
      where: { user: { email: dto.email } },
    });
    if (existingMembership) {
      throw new DomainError(ErrorCode.CONFLICT, 'User is already a member of this tenant');
    }

    // systemPrisma: users is a platform-global table; membership is tenant-scoped.
    let user = await this.prisma.client.user.findUnique({ where: { email: dto.email } });
    let temporaryPassword: string | undefined;

    if (!user) {
      if (dto.password) {
        user = await this.prisma.client.user.create({
          data: {
            email: dto.email,
            passwordHash: await this.passwords.hash(dto.password),
            fullName: dto.fullName ?? dto.email.split('@')[0]!,
          },
        });
      } else {
        temporaryPassword = randomBytes(9).toString('base64url');
        user = await this.prisma.client.user.create({
          data: {
            email: dto.email,
            passwordHash: await this.passwords.hash(temporaryPassword),
            fullName: dto.fullName ?? dto.email.split('@')[0]!,
          },
        });
      }
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

    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
    const membership = await prisma.tenantMembership.create({
      data: {
        tenantId,
        userId: user.id,
        roleId: role.id,
        status: 'ACTIVE',
        defaultBranchId: dto.defaultBranchId ? BigInt(dto.defaultBranchId) : null,
        invitedBy: ClsServiceManager.getClsService<RequestContext>().get('userId'),
        allowedBranches: {
          create: branchIds.map((branchId) => ({ branchId })),
        },
      },
      include: membershipInclude,
    });

    await this.audit.log({
      action: 'user.invite',
      entityType: 'tenant_membership',
      entityId: membership.id,
      after: { email: dto.email, roleCode: dto.roleCode },
    });

    return {
      ...serialize(membership),
      ...(temporaryPassword ? { temporaryPassword } : {}),
    };
  }

  async update(membershipId: bigint, dto: UpdateMembershipDto) {
    const prisma = this.tenant();
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId },
      include: { role: true },
    });
    if (!membership) throw DomainError.notFound('Membership', membershipId.toString());

    const data: Prisma.TenantMembershipUncheckedUpdateInput = {};
    if (dto.roleCode !== undefined) {
      const role = await this.prisma.client.role.findUnique({ where: { code: dto.roleCode } });
      if (!role) throw DomainError.notFound('Role', dto.roleCode);

      // Never allow removing the last OWNER of the tenant.
      const isLeavingOwner =
        membership.role.code === 'OWNER' && role.code !== 'OWNER';
      if (isLeavingOwner || dto.status === 'SUSPENDED') {
        const ownerCount = await prisma.tenantMembership.count({
          where: { role: { code: 'OWNER' }, status: { not: 'SUSPENDED' } },
        });
        const selfId = ClsServiceManager.getClsService<RequestContext>().get('membershipId');
        const targetsSelf = membershipId === selfId;
        if (membership.role.code === 'OWNER' && (ownerCount <= 1 || targetsSelf)) {
          // Allow self-demotion only if another active OWNER remains.
          if (ownerCount <= 1) {
            throw new DomainError(
              ErrorCode.CONFLICT,
              'Cannot remove or demote the last active OWNER',
            );
          }
        }
      }
      data.roleId = role.id;
    }
    if (dto.status !== undefined) {
      if (membership.role.code === 'OWNER' && dto.status === 'SUSPENDED') {
        const ownerCount = await prisma.tenantMembership.count({
          where: { role: { code: 'OWNER' }, status: { not: 'SUSPENDED' } },
        });
        if (ownerCount <= 1) {
          throw new DomainError(ErrorCode.CONFLICT, 'Cannot suspend the last active OWNER');
        }
      }
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

    await prisma.tenantMembership.update({
      where: { id: membershipId },
      data,
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

  async suspend(membershipId: bigint) {
    const result = await this.update(membershipId, { status: 'SUSPENDED' });

    // Revoke refresh tokens issued for this user in this tenant.
    const prisma = this.tenant();
    const membership = await prisma.tenantMembership.findFirst({
      where: { id: membershipId },
      select: { userId: true },
    });
    if (membership) {
      const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
      // systemPrisma: refresh_tokens is platform-global; scoped explicitly.
      await this.prisma.client.refreshToken.updateMany({
        where: {
          userId: membership.userId,
          tenantId,
          revokedAt: null,
        },
        data: { revokedAt: new Date() },
      });
    }
    await this.audit.log({
      action: 'user.suspend',
      entityType: 'tenant_membership',
      entityId: membershipId,
    });
    return result;
  }
}
