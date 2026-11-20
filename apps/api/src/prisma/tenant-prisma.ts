import { PrismaClient, type Prisma } from '../generated/prisma/client.js';
import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../common/cls/cls.types.js';
import { DomainError } from '../common/errors/domain.error.js';
import { ErrorCode } from '../common/errors/error-codes.js';

/**
 * Models whose rows belong to a tenant (docs/BUILD_PLAN.md §5.3).
 * Platform/global models (Tenant, User, Plan, Role, RolePermission, Currency,
 * RefreshToken) are intentionally excluded.
 */
export const TENANT_MODELS = [
  'Subscription',
  'Company',
  'Branch',
  'TenantMembership',
  'MembershipBranch',
  'MemberPermission',
  'AuditLog',
  'Attachment',
  'IdempotencyKey',
  'Unit',
  'TaxCategory',
  'PaymentMethod',
  'FiscalYear',
  'FiscalPeriod',
  'FiscalYearClosing',
  'Account',
  'AccountMapping',
  'DocumentSequence',
  'JournalEntry',
  'JournalLine',
  'ItemGroup',
  'Item',
  'ItemUnit',
  'ItemBarcode',
  'Warehouse',
  'StockMovement',
  'StockBalance',
  'ItemCost',
  'StockAdjustment',
  'StockAdjustmentLine',
  'StockTransfer',
  'StockTransferLine',
  'StockCount',
  'StockCountLine',
  // Phase 15 (ADR-030 §3): who entered each count, for the approval guard.
  'StockCountCounter',
  'Party',
  'CashBox',
  'BankAccount',
  'SalesInvoice',
  'SalesInvoiceLine',
  'PurchaseInvoice',
  'PurchaseInvoiceLine',
  'SalesReturn',
  'SalesReturnLine',
  'PurchaseReturn',
  'PurchaseReturnLine',
  'GoodsNote',
  'GoodsNoteLine',
  'Receipt',
  'Payment',
  'Allocation',
  'CashTransfer',
  'EInvoiceSettings',
  'EInvoiceSubmission',
  'EInvoiceAttempt',
  // Phase 11A (ADR-024 §1).
  'CostCenter',
  // Phase 12 (ADR-025 §15).
  'PurchaseRequest',
  'PurchaseRequestLine',
  'PurchaseQuote',
  'PurchaseQuoteLine',
  'PurchaseOrder',
  'PurchaseOrderLine',
  // Phase 13 (ADR-026).
  'PurchaseInvoiceReceipt',
  'IssueRequest',
  'IssueRequestLine',
  // Phase 14 (ADR-027 §8).
  'SalesQuote',
  'SalesQuoteLine',
  'SalesOrder',
  'SalesOrderLine',
  // Phase 16 (ADR-031): bills of materials and production vouchers.
  'Bom',
  'BomLine',
  'ProductionVoucher',
  'ProductionVoucherLine',
  // Phase 17 (ADR-032 §8): the stock components of a recipe sale.
  'SalesInvoiceLineComponent',
  // Phase 20 (ADR-035): bank statements and their matches.
  'BankStatement',
  'BankStatementLine',
  'BankStatementMatch',
] as const;

const TENANT_MODEL_SET: ReadonlySet<string> = new Set(TENANT_MODELS);

const READ_OPS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany']);

function currentTenantId(explicit?: bigint): bigint {
  const tid = explicit ?? ClsServiceManager.getClsService<RequestContext>().get('tenantId');
  if (tid === undefined || tid === null) {
    throw new DomainError(
      ErrorCode.FORBIDDEN,
      'Tenant context is required for this operation',
    );
  }
  return tid;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectWhere(args: any, tenantId: bigint): void {
  args.where = { ...(args.where ?? {}), tenantId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectData(args: any, tenantId: bigint): void {
  if (Array.isArray(args.data)) {
    args.data = args.data.map((row: Record<string, unknown>) => ({ ...row, tenantId }));
  } else if (args.data && typeof args.data === 'object') {
    args.data = { ...args.data, tenantId };
  }
}

/**
 * Returns a Prisma client that automatically scopes every operation on
 * tenant models to `tenantId` (explicit arg wins, otherwise the CLS context).
 * Throws when no tenant context exists — raw PrismaClient access without a
 * tenant must go through `systemPrisma` consciously (platform/jobs only).
 *
 * NOTE: Prisma's query extension `args` is intentionally `any` here — the
 * extension API is dynamically typed per model. All mutations are confined
 * to adding `tenantId` filters/data and are covered by isolation tests.
 */
export function tenantScopedPrisma(client: PrismaClient, tenantId?: bigint): PrismaClient {
  const extended = client.$extends({
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async $allOperations({ model, operation, args, query }: any) {
          if (!TENANT_MODEL_SET.has(model)) {
            return query(args);
          }
          const tid = currentTenantId(tenantId);
          const op = operation as string;

          if (READ_OPS.has(op)) {
            injectWhere(args, tid);
          } else if (op === 'create' || op === 'createMany' || op === 'createManyAndReturn') {
            injectData(args, tid);
          } else if (op === 'upsert') {
            injectWhere(args, tid);
            if (args.create) args.create = { ...args.create, tenantId: tid };
            if (args.update) args.update = { ...args.update };
          } else if (WRITE_OPS.has(op)) {
            injectWhere(args, tid);
          }
          // Aggregates/groupBy already covered by READ_OPS via args.where.

          return query(args);
        },
      },
    },
  });
  return new Proxy(extended, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property !== '$transaction' || typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        const [operation, options] = args;
        if (typeof operation !== 'function') {
          return Reflect.apply(value, target, args);
        }
        return Reflect.apply(
          value,
          target,
          [
            async (tx: Prisma.TransactionClient) => {
              const result = await operation(tx);
              const cls = ClsServiceManager.getClsService<RequestContext>();
              const idempotencyKeyId = cls.isActive() ? cls.get('idempotencyKeyId') : undefined;
              if (idempotencyKeyId !== undefined) {
                // The marker commits atomically with the request's work.
                const marker = await tx.idempotencyKey.updateMany({
                  where: { id: idempotencyKeyId, status: { in: ['RESERVED', 'COMMITTED'] } },
                  data: { status: 'COMMITTED' },
                });
                if (marker.count === 0) {
                  throw new DomainError(
                    ErrorCode.CONFLICT,
                    'The Idempotency-Key reservation was taken over; this request was rolled back',
                  );
                }
              }
              return result;
            },
            options,
          ],
        );
      };
    },
  }) as unknown as PrismaClient;
}
