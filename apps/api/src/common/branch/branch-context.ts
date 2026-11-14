import { Logger } from '@nestjs/common';
import { ClsServiceManager } from 'nestjs-cls';
import { Prisma } from '../../generated/prisma/client.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

const log = new Logger('BranchScope');

/**
 * The member's branches, or null for every branch (ADR-003 §9, §16). Fails
 * closed: a company request whose scope BranchGuard did not set (a route that
 * skipped the guard, a guard-order mistake) is refused with INTERNAL instead
 * of reading every branch. Cron work declares itself with `jobContext`.
 */
function allowedBranches(): ReadonlySet<bigint> | null {
  const cls = ClsServiceManager.getClsService<RequestContext>();
  const scope = cls.isActive() ? cls.get('branchScope') : undefined;
  if (scope === 'ALL') return null;
  if (scope !== undefined) return scope;
  if (cls.isActive() && cls.get('jobContext') === true) return null;
  // No company in context: nothing is scoped (tenant-scoped reads refuse it anyway).
  if (!cls.isActive() || cls.get('tenantId') === undefined) return null;
  log.error(
    `Branch scope missing on a company request (tenant ${String(cls.get('tenantId'))}, request ${String(cls.get('requestId') ?? '?')}): BranchGuard did not run`,
  );
  throw new DomainError(ErrorCode.INTERNAL, 'Branch scope is missing for this request');
}

const byId = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * True when the member may use every branch, i.e. has no assigned branch
 * (ADR-003 §9). A member assigned all current branches is still restricted:
 * a branch added later, or an inactive one, is not theirs.
 */
export function hasAllBranches(): boolean {
  return allowedBranches() === null;
}

/** Sorted ids of the member's allowed branches, or null for every branch. */
export function allowedBranchIdList(): bigint[] | null {
  const allowed = allowedBranches();
  return allowed === null ? null : [...allowed].sort(byId);
}

type BranchIn<F extends string> = { [K in F]: { in: bigint[] } };
type BranchNull<F extends string> = { [K in F]: null };
/** `{}` (every branch) or `{ OR: [allowed branches, no branch] }`. */
export type BranchFilter<F extends string> = { OR?: (BranchIn<F> | BranchNull<F>)[] };

/**
 * Read filter for the caller's branches (ADR-003 §10): `{}` for an
 * all-branch member, else the allowed branches plus documents without a
 * branch (not restricted, as for writes). `field` is the model's branch
 * column. It is an OR: combine it with other OR filters under `AND: [...]`,
 * never by spreading two of them into one object.
 */
export function branchWhere(): BranchFilter<'branchId'>;
export function branchWhere<F extends string>(field: F): BranchFilter<F>;
export function branchWhere(field = 'branchId'): BranchFilter<string> {
  const ids = allowedBranchIdList();
  if (ids === null) return {};
  return { OR: [{ [field]: { in: ids } }, { [field]: null }] };
}

/**
 * The same filter as a SQL fragment for `$queryRaw` (ADR-003 §10). Append it
 * after the mandatory `tenant_id = ${tenantId}`:
 * `AND ${branchSql(Prisma.raw('i.branch_id'))}`. TRUE for an all-branch member.
 * `column` must be a constant column name, never client input.
 */
export function branchSql(column: Prisma.Sql): Prisma.Sql {
  const ids = allowedBranchIdList();
  if (ids === null) return Prisma.sql`TRUE`;
  if (ids.length === 0) return Prisma.sql`${column} IS NULL`;
  return Prisma.sql`(${column} IN (${Prisma.join(ids)}) OR ${column} IS NULL)`;
}

/** Stable text of the caller's branch scope, for cursor fingerprints (ADR-022 §5). */
export function branchScopeKey(): string {
  const ids = allowedBranchIdList();
  return ids === null ? 'all' : ids.map(String).join(',');
}

/** Branch of the current request (from BranchGuard / CLS), or null if the company has none. */
export function currentBranchId(): bigint | null {
  return ClsServiceManager.getClsService<RequestContext>().get('branchId') ?? null;
}

/**
 * Stock moves in a warehouse count as work on the warehouse's branch: throws
 * BRANCH_NOT_ALLOWED when the warehouse belongs to a branch the member may not
 * use (ADR-003). Warehouses without a branch are not restricted.
 */
export async function assertWarehouseBranchAllowed(
  db: Pick<Prisma.TransactionClient, 'warehouse'>,
  warehouseId: bigint | null | undefined,
): Promise<bigint | null> {
  if (warehouseId == null) return null;
  const wh = await db.warehouse.findFirst({ where: { id: warehouseId }, select: { branchId: true } });
  assertBranchAllowed(wh?.branchId);
  // The warehouse's branch: a stock document's journal entry carries it (ADR-003).
  return wh?.branchId ?? null;
}

/**
 * Throws BRANCH_NOT_ALLOWED unless the current member may post on `branchId`
 * (ADR-003). Documents without a branch (pre-backfill) are not restricted.
 */
export function assertBranchAllowed(branchId: bigint | null | undefined): void {
  if (branchId == null) return;
  const allowed = allowedBranches();
  if (allowed === null) return; // no branches assigned → every branch
  if (!allowed.has(branchId)) {
    throw new DomainError(
      ErrorCode.BRANCH_NOT_ALLOWED,
      `This document belongs to branch ${branchId.toString()}, which you may not post on`,
    );
  }
}
