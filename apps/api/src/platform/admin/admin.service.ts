import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { findPage, mapPage } from '../../common/paging/find-page.js';
import { orderByOf, pageWindow } from '../../common/paging/page-query.dto.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TenantDatabaseState } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantMirrorService } from '../tenancy/tenant-mirror.service.js';
import {
  CreateSubscriptionDto,
  ExtendTrialDto,
  ListTenantsQueryDto,
  UpdatePlanDto,
  UpdateTenantStatusDto,
} from './dto/admin.dto.js';

/**
 * Platform administration — cross-tenant operations reserved for
 * User.isPlatformAdmin. All queries use the system client consciously.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mirrors: TenantMirrorService,
  ) {}

  /**
   * One numbered page of tenants (ADR-022). Tenants are not branch-scoped:
   * this is platform administration, not a company read.
   */
  async listTenants(query: ListTenantsQueryDto) {
    const where: Prisma.TenantWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { name: { contains: query.q } } : {}),
    };
    const orderBy = orderByOf<'id' | 'name' | 'createdAt', Prisma.TenantOrderByWithRelationInput>(
      query.sort,
      '-id',
      {
        id: (dir) => ({ id: dir }),
        name: (dir) => ({ name: dir }),
        createdAt: (dir) => ({ createdAt: dir }),
      },
      (dir) => ({ id: dir }),
    );
    const page = await findPage(this.prisma.control(), pageWindow(query), {
      rows: (tx, window) =>
        tx.tenant.findMany({
          where,
          include: {
            plan: { select: { code: true, nameAr: true, nameEn: true } },
            ...(this.prisma.tenancyMode === 'shared'
              ? { _count: { select: { memberships: true, branches: true } } }
              : {}),
          },
          orderBy,
          ...window,
        }),
      count: (tx) => tx.tenant.count({ where }),
    });
    if (this.prisma.tenancyMode === 'isolated') {
      const stats = await Promise.all(page.items.map((tenant) => this.tenantDatabaseStats(tenant.id)));
      return mapPage(page, (rows) =>
        rows.map((t, index) => ({
          id: t.id.toString(),
          name: t.name,
          status: t.status,
          trialEndsAt: t.trialEndsAt,
          statusChangedAt: t.statusChangedAt,
          plan: t.plan,
          members: stats[index].members,
          branches: stats[index].branches,
          databaseState: stats[index].databaseState,
          createdAt: t.createdAt,
        })),
      );
    }
    return mapPage(page, (rows) =>
      rows.map((t) => ({
        id: t.id.toString(),
        name: t.name,
        status: t.status,
        trialEndsAt: t.trialEndsAt,
        statusChangedAt: t.statusChangedAt,
        plan: t.plan,
        members: t._count.memberships,
        branches: t._count.branches,
        databaseState: null,
        createdAt: t.createdAt,
      })),
    );
  }

  async getTenant(id: bigint) {
    const tenant = await this.prisma.control().tenant.findUnique({
      where: { id },
      include: {
        plan: true,
        subscriptions: { orderBy: { id: 'desc' }, take: 12 },
        ...(this.prisma.tenancyMode === 'shared'
          ? {
              companies: { select: { id: true, legalNameAr: true, isActive: true } },
              _count: { select: { memberships: true, branches: true } },
            }
          : {}),
      },
    });
    if (!tenant) throw DomainError.notFound('Tenant', id.toString());
    const stats =
      this.prisma.tenancyMode === 'isolated'
        ? await this.tenantDatabaseStats(id)
        : {
            companies: tenant.companies,
            members: tenant._count.memberships,
            branches: tenant._count.branches,
            databaseState: null,
          };
    return {
      id: tenant.id.toString(),
      name: tenant.name,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt,
      statusChangedAt: tenant.statusChangedAt,
      plan: tenant.plan,
      companies: stats.companies,
      members: stats.members,
      branches: stats.branches,
      databaseState: stats.databaseState,
      subscriptions: tenant.subscriptions,
      createdAt: tenant.createdAt,
    };
  }

  async updateStatus(id: bigint, dto: UpdateTenantStatusDto) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id } });
    if (!tenant) throw DomainError.notFound('Tenant', id.toString());
    const before = tenant.status;
    const updated = await this.prisma.client.tenant.update({
      where: { id },
      // Grace and post-cancellation retention count from the change (ADR-009).
      data: { status: dto.status, ...(dto.status !== before ? { statusChangedAt: new Date() } : {}) },
    });
    await this.audit.log({
      action: 'admin.tenant_status',
      tenantId: null,
      entityType: 'tenant',
      entityId: id,
      before: { status: before },
      after: { status: dto.status, reason: dto.reason },
    });
    await this.syncTenantMirror(id);
    return { id: updated.id.toString(), status: updated.status };
  }

  async extendTrial(id: bigint, dto: ExtendTrialDto) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id } });
    if (!tenant) throw DomainError.notFound('Tenant', id.toString());
    if (tenant.status !== 'TRIAL') {
      throw new DomainError(ErrorCode.CONFLICT, 'Tenant is not in trial');
    }
    const base = tenant.trialEndsAt && tenant.trialEndsAt > new Date()
      ? tenant.trialEndsAt
      : new Date();
    const trialEndsAt = new Date(base.getTime() + dto.days * 24 * 60 * 60 * 1000);
    await this.prisma.client.tenant.update({ where: { id }, data: { trialEndsAt } });
    await this.audit.log({
      action: 'admin.extend_trial',
      tenantId: null,
      entityType: 'tenant',
      entityId: id,
      after: { days: dto.days, trialEndsAt },
    });
    await this.syncTenantMirror(id);
    return { id: id.toString(), trialEndsAt };
  }

  async createSubscription(id: bigint, dto: CreateSubscriptionDto) {
    const tenant = await this.prisma.client.tenant.findUnique({ where: { id } });
    if (!tenant) throw DomainError.notFound('Tenant', id.toString());
    const plan = await this.prisma.client.plan.findUnique({ where: { code: dto.planCode } });
    if (!plan || !plan.isActive) throw DomainError.notFound('Plan', dto.planCode);

    const periodStart = dto.periodStart ? new Date(dto.periodStart) : new Date();
    const periodEnd = new Date(dto.periodEnd);
    if (periodEnd <= periodStart) {
      throw new DomainError(ErrorCode.VALIDATION, 'periodEnd must be after periodStart');
    }

    const subscription = await this.prisma.client.$transaction(async (tx) => {
      const sub = await tx.subscription.create({
        data: {
          tenantId: id,
          planId: plan.id,
          periodStart,
          periodEnd,
          status: 'ACTIVE',
          amount: dto.amount ?? null,
          notes: dto.notes ?? null,
        },
      });
      await tx.tenant.update({
        where: { id },
        data: {
          planId: plan.id,
          status: 'ACTIVE',
          trialEndsAt: null,
          ...(tenant.status !== 'ACTIVE' ? { statusChangedAt: new Date() } : {}),
        },
      });
      return sub;
    });

    await this.audit.log({
      action: 'admin.create_subscription',
      tenantId: null,
      entityType: 'tenant',
      entityId: id,
      before: { status: tenant.status },
      after: { planCode: dto.planCode, periodEnd, amount: dto.amount ?? null, status: 'ACTIVE' },
    });
    await this.syncTenantMirror(id);
    return { id: subscription.id.toString(), status: subscription.status };
  }

  // ---------------------------------------------------------------- plans

  /** Every plan with its limits and prices (ADR-009 §1). */
  async listPlans() {
    const plans = await this.prisma.client.plan.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { tenants: true } } },
    });
    return plans.map(({ _count, ...p }) => ({ ...p, id: p.id.toString(), tenants: _count.tenants }));
  }

  /** Edits a plan's names, limits or prices; tenants on it get the new limits at once. */
  async updatePlan(code: string, dto: UpdatePlanDto) {
    const plan = await this.prisma.client.plan.findUnique({ where: { code } });
    if (!plan) throw DomainError.notFound('Plan', code);
    const updated = await this.prisma.client.plan.update({ where: { code }, data: dto });
    await this.audit.log({
      action: 'admin.update_plan',
      tenantId: null,
      entityType: 'plan',
      entityId: plan.id,
      before: {
        maxUsers: plan.maxUsers,
        maxBranches: plan.maxBranches,
        maxWarehouses: plan.maxWarehouses,
        maxInvoicesPerMonth: plan.maxInvoicesPerMonth,
        priceMonthly: plan.priceMonthly?.toString() ?? null,
        priceYearly: plan.priceYearly?.toString() ?? null,
        isActive: plan.isActive,
      },
      after: dto,
    });
    if (this.prisma.tenancyMode === 'isolated') {
      const databases = await this.prisma.control().tenantDatabase.findMany({
        where: { state: 'ACTIVE' },
        select: { tenantId: true },
        orderBy: { tenantId: 'asc' },
      });
      for (const { tenantId } of databases) {
        try {
          await this.prisma.router.resolve(tenantId);
          await this.mirrors.syncPlan(this.prisma.forTenant(tenantId), updated.id);
        } catch (error) {
          this.logger.warn(`Could not synchronize plan mirror ${updated.id} for tenant ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { ...updated, id: updated.id.toString() };
  }

  private async syncTenantMirror(tenantId: bigint): Promise<void> {
    if (this.prisma.tenancyMode !== 'isolated') return;
    try {
      await this.prisma.router.resolve(tenantId);
      await this.mirrors.syncTenant(this.prisma.forTenant(tenantId), tenantId);
    } catch (error) {
      this.logger.warn(`Could not synchronize tenant mirror ${tenantId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async tenantDatabaseStats(tenantId: bigint): Promise<{
    members: number | null;
    branches: number | null;
    companies: { id: bigint; legalNameAr: string; isActive: boolean }[];
    databaseState: TenantDatabaseState | null;
  }> {
    const database = await this.prisma.control().tenantDatabase.findUnique({
      where: { tenantId },
      select: { state: true },
    });
    const unavailable = {
      members: null,
      branches: null,
      companies: [],
      databaseState: database?.state ?? null,
    };
    if (!database || database.state !== 'ACTIVE') return unavailable;
    try {
      await this.prisma.router.resolve(tenantId);
      const db = this.prisma.forTenant(tenantId);
      const [members, branches, companies] = await Promise.all([
        db.tenantMembership.count({ where: { tenantId } }),
        db.branch.count({ where: { tenantId } }),
        db.company.findMany({
          where: { tenantId },
          select: { id: true, legalNameAr: true, isActive: true },
        }),
      ]);
      return { members, branches, companies, databaseState: database.state };
    } catch (error) {
      if (error instanceof DomainError && (error.code === ErrorCode.TENANT_MAINTENANCE || error.code === ErrorCode.TENANT_DB_NOT_FOUND)) {
        return unavailable;
      }
      throw error;
    }
  }
}
