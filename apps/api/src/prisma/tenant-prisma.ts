import { PrismaClient } from '../generated/prisma/client.js';
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
  'AuditLog',
  'Attachment',
  'IdempotencyKey',
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
  return extended as unknown as PrismaClient;
}
