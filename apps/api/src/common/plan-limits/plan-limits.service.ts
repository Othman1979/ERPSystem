import { Injectable } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { Plan, Prisma } from '../../generated/prisma/client.js';

/**
 * Enforces subscription plan limits (docs/BUILD_PLAN.md §13.1).
 * Returns 402 PLAN_LIMIT_EXCEEDED when a limit is reached.
 */
@Injectable()
export class PlanLimitsService {
  /**
   * Locks the tenant row, then reads its plan and counts `model` rows, all in
   * the caller's transaction (PLAT-04). Concurrent creations of the same
   * tenant queue on the lock, so the count-then-insert cannot overshoot the
   * limit. The lock MUST be the transaction's first statement: under
   * REPEATABLE READ the count's snapshot is taken at the first plain read, so
   * it then sees every row committed by the previous holder of the lock.
   */
  private async assertSlot(
    tx: Prisma.TransactionClient,
    model: 'tenantMembership' | 'branch' | 'warehouse',
    label: string,
    limitOf: (plan: Plan) => number,
  ): Promise<void> {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) return;
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE`;
    const plan = (await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }))
      ?.plan;
    if (!plan) return; // no plan → trial defaults handled at registration
    // Explicit tenantId: counts include INVITED/SUSPENDED memberships and
    // disabled branches.
    const used =
      model === 'tenantMembership'
        ? await tx.tenantMembership.count({ where: { tenantId } })
        : model === 'warehouse'
          ? await tx.warehouse.count({ where: { tenantId } })
          : await tx.branch.count({ where: { tenantId } });
    const limit = limitOf(plan);
    if (used >= limit) {
      throw new DomainError(
        ErrorCode.PLAN_LIMIT_EXCEEDED,
        `${label} limit reached for plan ${plan.code} (${limit})`,
        { limit, used },
      );
    }
  }

  /** Call first inside the transaction that creates the membership. */
  assertUserSlotAvailable(tx: Prisma.TransactionClient): Promise<void> {
    return this.assertSlot(tx, 'tenantMembership', 'User', (p) => p.maxUsers);
  }

  /** Call first inside the transaction that creates the branch. */
  assertBranchSlotAvailable(tx: Prisma.TransactionClient): Promise<void> {
    return this.assertSlot(tx, 'branch', 'Branch', (p) => p.maxBranches);
  }

  /** Call first inside the transaction that creates the warehouse. */
  assertWarehouseSlotAvailable(tx: Prisma.TransactionClient): Promise<void> {
    return this.assertSlot(tx, 'warehouse', 'Warehouse', (p) => p.maxWarehouses);
  }

  /**
   * Monthly sales-invoice quota (§13.1, ADR-009). `posted` is the number of
   * sales invoices the tenant already posted in the invoice's calendar month;
   * the sales module counts its own table and passes it in. Two invoices
   * posted at the same instant at the limit may both pass: a commercial
   * limit, not worth serialising every posting of the tenant for. The tenant
   * row lock used above is unsafe here: about 50 tables have a foreign key to
   * tenants, so every insert takes a shared lock on that row, and an
   * exclusive lock taken mid-posting would deadlock with concurrent postings
   * that hold item locks (PLAT-04).
   *
   * The plan is read through the caller's `tx`, never another client: a
   * second pool connection taken while the posting transaction holds one
   * deadlocks the pool once DB_POOL_SIZE postings run at once (each holds a
   * connection and waits for another), and they all fail with 503.
   */
  async assertMonthlyInvoiceQuota(tx: Prisma.TransactionClient, posted: number): Promise<void> {
    const tenantId = ClsServiceManager.getClsService<RequestContext>().get('tenantId');
    if (!tenantId) return;
    const plan = (await tx.tenant.findUnique({ where: { id: tenantId }, select: { plan: true } }))?.plan;
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
