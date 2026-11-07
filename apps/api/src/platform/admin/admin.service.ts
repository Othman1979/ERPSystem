import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CreateSubscriptionDto,
  ExtendTrialDto,
  UpdateTenantStatusDto,
} from './dto/admin.dto.js';

/**
 * Platform administration — cross-tenant operations reserved for
 * User.isPlatformAdmin. All queries use the system client consciously.
 */
@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listTenants(query: { status?: string; search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where = {
      ...(query.status ? { status: query.status as never } : {}),
      ...(query.search
        ? { name: { contains: query.search } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.client.tenant.count({ where }),
      this.prisma.client.tenant.findMany({
        where,
        include: {
          plan: { select: { code: true, nameAr: true, nameEn: true } },
          _count: { select: { memberships: true, branches: true } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: rows.map((t) => ({
        id: t.id.toString(),
        name: t.name,
        status: t.status,
        trialEndsAt: t.trialEndsAt,
        plan: t.plan,
        members: t._count.memberships,
        branches: t._count.branches,
        createdAt: t.createdAt,
      })),
    };
  }

  async getTenant(id: bigint) {
    const tenant = await this.prisma.client.tenant.findUnique({
      where: { id },
      include: {
        plan: true,
        subscriptions: { orderBy: { id: 'desc' }, take: 12 },
        companies: { select: { id: true, legalNameAr: true, isActive: true } },
        _count: { select: { memberships: true, branches: true } },
      },
    });
    if (!tenant) throw DomainError.notFound('Tenant', id.toString());
    return {
      id: tenant.id.toString(),
      name: tenant.name,
      status: tenant.status,
      trialEndsAt: tenant.trialEndsAt,
      plan: tenant.plan,
      companies: tenant.companies,
      members: tenant._count.memberships,
      branches: tenant._count.branches,
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
      data: { status: dto.status },
    });
    await this.audit.log({
      action: 'admin.tenant_status',
      entityType: 'tenant',
      entityId: id,
      before: { status: before },
      after: { status: dto.status, reason: dto.reason },
    });
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
      entityType: 'tenant',
      entityId: id,
      after: { days: dto.days, trialEndsAt },
    });
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
          notes: dto.notes ?? null,
        },
      });
      await tx.tenant.update({
        where: { id },
        data: { planId: plan.id, status: 'ACTIVE', trialEndsAt: null },
      });
      return sub;
    });

    await this.audit.log({
      action: 'admin.create_subscription',
      entityType: 'tenant',
      entityId: id,
      after: { planCode: dto.planCode, periodEnd },
    });
    return { id: subscription.id.toString(), status: subscription.status };
  }
}
