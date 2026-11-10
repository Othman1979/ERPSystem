import { ClsServiceManager } from 'nestjs-cls';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** Branch of the current request (from BranchGuard / CLS), or null if the company has none. */
export function currentBranchId(): bigint | null {
  return ClsServiceManager.getClsService<RequestContext>().get('branchId') ?? null;
}

/**
 * Throws BRANCH_NOT_ALLOWED unless the current member may post on `branchId`
 * (ADR-003). Documents without a branch (pre-backfill) are not restricted.
 */
export function assertBranchAllowed(branchId: bigint | null | undefined): void {
  if (branchId == null) return;
  const allowed = ClsServiceManager.getClsService<RequestContext>().get('allowedBranchIds');
  if (allowed == null) return; // no branches assigned → every branch
  if (!allowed.has(branchId)) {
    throw new DomainError(
      ErrorCode.BRANCH_NOT_ALLOWED,
      `This document belongs to branch ${branchId.toString()}, which you may not post on`,
    );
  }
}
