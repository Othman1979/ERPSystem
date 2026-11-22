import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { ErrorCode } from '../errors/error-codes.js';
import type { Plan, Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { PlanLimitsService } from './plan-limits.service.js';

const cls = ClsServiceManager.getClsService<RequestContext>();

function transaction(plan: Plan) {
  const branchCalls: unknown[] = [];
  const invoiceCalls: unknown[] = [];
  let tenantReads = 0;
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
    tenant: {
      findUnique: async () => {
        tenantReads += 1;
        return { plan };
      },
    },
    tenantMembership: { count: async () => 0 },
    branch: { count: branchCount },
    warehouse: { count: async () => 0 },
    salesInvoice: { count: invoiceCount },
  } as unknown as Prisma.TransactionClient;
  return { tx, branchCalls, invoiceCalls, tenantReads: () => tenantReads };
}

describe('PlanLimitsService tenant-wide counts', () => {
  it('counts branches from all companies while a request company is selected', async () => {
    const plan = { code: 'BASIC', maxUsers: 5, maxBranches: 2, maxWarehouses: 2, maxInvoicesPerMonth: 50 } as Plan;
    const { tx, branchCalls } = transaction(plan);
    const prisma = {
      tenancyMode: 'shared',
      control: () => {
        throw new Error('Shared mode must keep plan reads in the transaction');
      },
    } as unknown as PrismaService;
    const limits = new PlanLimitsService(prisma);

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
    const prisma = {
      tenancyMode: 'shared',
      control: () => {
        throw new Error('Shared mode must keep plan reads in the transaction');
      },
    } as unknown as PrismaService;
    const limits = new PlanLimitsService(prisma);
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

  it('reads plan data from control in isolated mode', async () => {
    const plan = { code: 'BASIC', maxUsers: 5, maxBranches: 2, maxWarehouses: 2, maxInvoicesPerMonth: 50 } as Plan;
    const { tx, tenantReads } = transaction(plan);
    let controlReads = 0;
    const prisma = {
      tenancyMode: 'isolated',
      control: () => ({
        tenant: {
          findUnique: async () => {
            controlReads += 1;
            return { plan };
          },
        },
      }),
    } as unknown as PrismaService;
    const limits = new PlanLimitsService(prisma);

    await cls.run({ ifNested: 'override' }, async () => {
      cls.set('tenantId', 7n);
      cls.set('companyId', 101n);

      await expect(limits.assertBranchSlotAvailable(tx)).rejects.toMatchObject({
        code: ErrorCode.PLAN_LIMIT_EXCEEDED,
        details: { limit: 2, used: 2 },
      });
    });

    expect(controlReads).toBe(1);
    expect(tenantReads()).toBe(0);
  });
});
