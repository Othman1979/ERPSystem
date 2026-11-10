/**
 * Shape of the AsyncLocalStorage request context (nestjs-cls).
 * Populated by AuthGuard / TenantGuard — never read from client input.
 */
export interface RequestContext {
  // Required by nestjs-cls ClsStore constraint.
  [key: symbol]: unknown;
  requestId?: string;
  userId?: bigint;
  userEmail?: string;
  isPlatformAdmin?: boolean;
  tenantId?: bigint;
  membershipId?: bigint;
  roleCode?: string;
  permissions?: ReadonlySet<string>;
  /** Branch of this request (X-Branch-Id or the default), set by BranchGuard. */
  branchId?: bigint;
  /** Branches the member may use; null = all branches of the company (none assigned). */
  allowedBranchIds?: ReadonlySet<bigint> | null;
}
