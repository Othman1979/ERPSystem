import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type TenantMirrorClient = PrismaClient | Prisma.TransactionClient;

@Injectable()
export class TenantMirrorService {
  // systemPrisma: control-plane records are copied into tenant databases.
  private readonly logger = new Logger(TenantMirrorService.name);

  constructor(private readonly prisma: PrismaService) {}

  async syncReference(tenantDb: TenantMirrorClient): Promise<void> {
    const control = this.prisma.control();
    const [plans, currencies, roles, permissions] = await Promise.all([
      control.plan.findMany(),
      control.currency.findMany(),
      control.role.findMany(),
      control.rolePermission.findMany(),
    ]);
    for (const row of plans) {
      await tenantDb.plan.upsert({ where: { id: row.id }, create: row, update: row });
    }
    for (const row of currencies) {
      await tenantDb.currency.upsert({ where: { id: row.id }, create: row, update: row });
    }
    for (const row of roles) {
      await tenantDb.role.upsert({ where: { id: row.id }, create: row, update: row });
    }
    for (const row of permissions) {
      await tenantDb.rolePermission.upsert({ where: { id: row.id }, create: row, update: row });
    }
  }

  async syncTenant(tenantDb: TenantMirrorClient, tenantId: bigint): Promise<void> {
    const tenant = await this.prisma.control().tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found in control database`);
    const data = {
      id: tenant.id,
      name: tenant.name,
      status: tenant.status,
      planId: tenant.planId,
      trialEndsAt: tenant.trialEndsAt,
      statusChangedAt: tenant.statusChangedAt,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
    };
    await tenantDb.tenant.upsert({ where: { id: tenantId }, create: data, update: data });
  }

  async syncPlan(tenantDb: TenantMirrorClient, planId: bigint): Promise<void> {
    const plan = await this.prisma.control().plan.findUnique({ where: { id: planId } });
    if (!plan) throw new Error(`Plan ${planId} not found in control database`);
    await tenantDb.plan.upsert({ where: { id: planId }, create: plan, update: plan });
  }

  async syncUser(tenantDb: TenantMirrorClient, userId: bigint): Promise<void> {
    const user = await this.prisma.control().user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        locale: true,
        isActive: true,
        isPlatformAdmin: true,
        lastLoginAt: true,
        mustChangePassword: true,
        passwordChangedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) throw new Error(`User ${userId} not found in control database`);
    const data = { ...user, passwordHash: '!' };
    await tenantDb.user.upsert({ where: { id: userId }, create: data, update: data });
  }

  async syncUserForTenant(userId: bigint, tenantId: bigint): Promise<void> {
    if (this.prisma.tenancyMode !== 'isolated') return;
    try {
      await this.prisma.router.resolve(tenantId);
      await this.syncUser(this.prisma.forTenant(tenantId), userId);
    } catch {
      this.logger.warn(`Could not synchronize user mirror ${userId} for tenant ${tenantId}`);
    }
  }

  async syncUserForLinkedTenants(userId: bigint): Promise<void> {
    if (this.prisma.tenancyMode !== 'isolated') return;
    try {
      const links = await this.prisma.control().userTenant.findMany({
        where: { userId },
        select: { tenantId: true },
        orderBy: { tenantId: 'asc' },
      });
      for (const { tenantId } of links) await this.syncUserForTenant(userId, tenantId);
    } catch {
      this.logger.warn(`Could not load tenant links for user mirror ${userId}`);
    }
  }
}
