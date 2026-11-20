import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { Plan, Prisma } from '../../generated/prisma/client.js';
import { PlanLimitsService } from './plan-limits.service.js';

const cls = ClsServiceManager.getClsService<RequestContext>();

function transaction(plan: Plan) {
  const branchCalls: unknown[] = [];
  const invoiceCalls: unknown[] = [];
  const branchCount = async (args: unknown) => {
    branchCalls.push(args);
    expect(cls.get('companyId')).toBeUndefined();
    return 2;
  };
  const invoiceCount = async (args: unknown) => {
    invoiceCalls.push(args);
    expect(cls.get('companyId')).toBeUndefined();
    return 2;
  };
  const tx = {
    $queryRaw: async () => [],
    tenant: { findUnique: async () => ({ plan }) },
    tenantMembership: { count: async () => 0 },
    branch: { count: branchCount },
    warehouse: { count: async () => 0 },
    salesInvoice: { count: invoiceCount },
  } as unknown as Prisma.TransactionClient;
  return { tx, branchCalls, invoiceCalls };
}

describe('PlanLimitsService tenant-wide counts', () => {
  const limits = new PlanLimitsService();

  it('counts branches from all companies while a request company is selected', async () => {
    const plan = { code: 'BASIC', maxUsers: 5, maxBranches: 2, maxWarehouses: 2, maxInvoicesPerMonth: 50 } as Plan;
    const { tx, branchCalls } = transaction(plan);

    await cls.run({ ifNested: 'override' }, async () => {
      cls.set('tenantId', 7n);
      cls.set('companyId', 101n);

      await expect(limits.assertBranchSlotAvailable(tx)).rejects.toMatchObject({
        code: ErrorCode.PLAN_LIMIT_EXCEEDED,
        details: { limit: 2, used: 2 },
      });
    });

    expect(branchCalls).toEqual([{ where: { tenantId: 7n } }]);
  });

  it('counts monthly invoices across all companies', async () => {
    const plan = { code: 'BASIC', maxUsers: 5, maxBranches: 2, maxWarehouses: 2, maxInvoicesPerMonth: 2 } as Plan;
    const { tx, invoiceCalls } = transaction(plan);
    const invoiceDate = new Date('2025-03-15T12:00:00.000Z');

    await cls.run({ ifNested: 'override' }, async () => {
      cls.set('tenantId', 7n);
      cls.set('companyId', 101n);

      await expect(limits.assertMonthlyInvoiceQuota(tx, invoiceDate)).rejects.toMatchObject({
        code: ErrorCode.PLAN_LIMIT_EXCEEDED,
        details: { limit: 2, used: 2 },
      });
    });

    expect(invoiceCalls).toEqual([
      {
        where: {
          tenantId: 7n,
          status: 'POSTED',
          invoiceDate: {
            gte: new Date('2025-03-01T00:00:00.000Z'),
            lt: new Date('2025-04-01T00:00:00.000Z'),
          },
        },
      },
    ]);
  });
});
