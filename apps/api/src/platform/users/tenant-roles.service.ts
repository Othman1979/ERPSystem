import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { CUSTOM_ROLE_PERMISSIONS, PERMISSIONS, type PermissionCode } from '../../common/permissions/permissions.js';
import type { RequestContext } from '../../common/cls/cls.types.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { SaveTenantRoleDto, TenantRoleDto } from './dto/tenant-roles.dto.js';

/** tenant.read always comes with a role: without it the member sees nothing. */
function normalise(codes: PermissionCode[]): PermissionCode[] {
  return [...new Set<PermissionCode>([PERMISSIONS.TENANT_READ, ...codes])].sort();
}

/** A company's own roles (ADR-038): owner-managed sets of catalog permissions. */
@Injectable()
export class TenantRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private ctx() {
    const cls = ClsServiceManager.getClsService<RequestContext>();
    const tenantId = cls.get('tenantId');
    if (!tenantId) throw new DomainError(ErrorCode.FORBIDDEN, 'No tenant selected');
    return { db: this.prisma.forTenant(tenantId), tenantId, userId: cls.get('userId') };
  }

  catalog() {
    return { assignable: CUSTOM_ROLE_PERMISSIONS };
  }

  async list(): Promise<TenantRoleDto[]> {
    const { db } = this.ctx();
    const rows = await db.tenantRole.findMany({
      include: { permissions: { select: { permissionCode: true } }, _count: { select: { memberships: true } } },
      orderBy: { code: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id.toString(),
      code: r.code,
      nameAr: r.nameAr,
      nameEn: r.nameEn,
      description: r.description,
      permissions: r.permissions.map((p) => p.permissionCode as PermissionCode).sort(),
      memberCount: r._count.memberships,
    }));
  }

  private async one(id: bigint): Promise<TenantRoleDto> {
    const role = (await this.list()).find((r) => r.id === id.toString());
    if (!role) throw DomainError.notFound('TenantRole', id.toString());
    return role;
  }

  private async assertCodeFree(code: string, exceptId?: bigint) {
    const { db } = this.ctx();
    const clash = await db.tenantRole.findFirst({ where: { code, ...(exceptId ? { NOT: { id: exceptId } } : {}) } });
    if (clash) throw new DomainError(ErrorCode.DUPLICATE_CODE, `Role code ${code} already exists`);
  }

  async create(dto: SaveTenantRoleDto): Promise<TenantRoleDto> {
    const { db, tenantId, userId } = this.ctx();
    await this.assertCodeFree(dto.code);
    const permissions = normalise(dto.permissions);
    const role = await db.$transaction(async (tx) => {
      const created = await tx.tenantRole.create({
        data: {
          tenantId,
          code: dto.code,
          nameAr: dto.nameAr,
          nameEn: dto.nameEn ?? null,
          description: dto.description ?? null,
          createdBy: userId ?? null,
        },
      });
      await tx.tenantRolePermission.createMany({
        data: permissions.map((permissionCode) => ({ tenantId, tenantRoleId: created.id, permissionCode })),
      });
      return created;
    });
    await this.audit.log({
      action: 'role.create',
      entityType: 'tenant_role',
      entityId: role.id,
      after: { code: dto.code, permissions },
    });
    return this.one(role.id);
  }

  /** Replaces the role's names and permissions; members holding it get them on their next request. */
  async update(id: bigint, dto: SaveTenantRoleDto): Promise<TenantRoleDto> {
    const { db, tenantId } = this.ctx();
    const before = await this.one(id);
    await this.assertCodeFree(dto.code, id);
    const permissions = normalise(dto.permissions);
    await db.$transaction(async (tx) => {
      await tx.tenantRole.update({
        where: { id },
        data: { code: dto.code, nameAr: dto.nameAr, nameEn: dto.nameEn ?? null, description: dto.description ?? null },
      });
      await tx.tenantRolePermission.deleteMany({ where: { tenantRoleId: id } });
      await tx.tenantRolePermission.createMany({
        data: permissions.map((permissionCode) => ({ tenantId, tenantRoleId: id, permissionCode })),
      });
    });
    await this.audit.log({
      action: 'role.update',
      entityType: 'tenant_role',
      entityId: id,
      before: { code: before.code, permissions: before.permissions },
      after: { code: dto.code, permissions },
    });
    return this.one(id);
  }

  async remove(id: bigint): Promise<{ id: string }> {
    const { db, tenantId } = this.ctx();
    const before = await this.one(id);
    await db.$transaction(async (tx) => {
      // Lock the role so an assignment racing this delete either lands first (and is counted) or fails on the FK.
      await tx.$queryRaw`SELECT id FROM tenant_roles WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
      const inUse = await tx.tenantMembership.count({ where: { customRoleId: id } });
      if (inUse > 0) throw new DomainError(ErrorCode.ROLE_IN_USE, `Role ${before.code} is assigned to ${inUse} member(s)`);
      await tx.tenantRole.delete({ where: { id } });
    });
    await this.audit.log({
      action: 'role.delete',
      entityType: 'tenant_role',
      entityId: id,
      before: { code: before.code, permissions: before.permissions },
    });
    return { id: id.toString() };
  }
}
