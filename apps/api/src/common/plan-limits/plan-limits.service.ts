import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/**
 * Enforces subscription plan limits (docs/BUILD_PLAN.md §13.1).
 * Returns 402 PLAN_LIMIT_EXCEEDED when a limit is reached.
 */
@Injectable()
export class PlanLimitsService {
  constructor(private readonly prisma: PrismaService) {}

  private async planForCurrentTenant() {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) return null;
    // systemPrisma: plan lookup by tenant id — the count queries below are
    // tenant-scoped explicitly.
    return this.prisma.client.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
  }

  private async countTenantRows(
    model: 'tenantMembership' | 'branch' | 'warehouse',
    tenantId: bigint,
  ) {
    // systemPrisma + explicit tenantId: counts must include INVITED/SUSPENDED
    // memberships and disabled branches to enforce limits correctly.
    if (model === 'tenantMembership') {
      return this.prisma.client.tenantMembership.count({ where: { tenantId } });
    }
    if (model === 'warehouse') {
      return this.prisma.client.warehouse.count({ where: { tenantId } });
    }
    return this.prisma.client.branch.count({ where: { tenantId } });
  }

  async assertUserSlotAvailable(): Promise<void> {
    const tenant = await this.planForCurrentTenant();
    const plan = tenant?.plan;
    if (!plan) return; // no plan → trial defaults handled at registration
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
    const used = await this.countTenantRows('tenantMembership', tenantId);
    if (used >= plan.maxUsers) {
      throw new DomainError(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `User limit reached for plan ${plan.code} (${plan.maxUsers})`,
        { limit: plan.maxUsers, used },
      );
    }
  }

  async assertBranchSlotAvailable(): Promise<void> {
    const tenant = await this.planForCurrentTenant();
    const plan = tenant?.plan;
    if (!plan) return;
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
    const used = await this.countTenantRows('branch', tenantId);
    if (used >= plan.maxBranches) {
      throw new DomainError(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `Branch limit reached for plan ${plan.code} (${plan.maxBranches})`,
        { limit: plan.maxBranches, used },
      );
    }
  }

  async assertWarehouseSlotAvailable(): Promise<void> {
    const tenant = await this.planForCurrentTenant();
    const plan = tenant?.plan;
    if (!plan) return;
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId')!;
    const used = await this.countTenantRows('warehouse', tenantId);
    if (used >= plan.maxWarehouses) {
      throw new DomainError(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `Warehouse limit reached for plan ${plan.code} (${plan.maxWarehouses})`,
        { limit: plan.maxWarehouses, used },
      );
    }
  }

  /**
   * Monthly sales-invoice quota (§13.1, ADR-009). `posted` is the number of
   * sales invoices the tenant already posted in the invoice's calendar month;
   * the sales module counts its own table and passes it in. Two invoices
   * posted at the same instant at the limit may both pass: a commercial
   * limit, not worth serialising every posting of the tenant for.
   */
  async assertMonthlyInvoiceQuota(posted: number): Promise<void> {
    const plan = (await this.planForCurrentTenant())?.plan;
    if (!plan) return;
    if (posted >= plan.maxInvoicesPerMonth) {
      throw new DomainError(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `Monthly invoice limit reached for plan ${plan.code} (${plan.maxInvoicesPerMonth})`,
        { limit: plan.maxInvoicesPerMonth, used: posted },
      );
    }
  }
}
