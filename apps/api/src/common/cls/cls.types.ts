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
  /** Refresh-token family of this session (access token `fid`), for switch-tenant and logout-all (PLAT-22). */
  familyId?: string;
  isPlatformAdmin?: boolean;
  tenantId?: bigint;
  membershipId?: bigint;
  roleCode?: string;
  permissions?: ReadonlySet<string>;
  /** Branch of this request (X-Branch-Id or the default), set by BranchGuard. */
  branchId?: bigint;
  /**
   * Branches the member may read and write (ADR-003 §9, §16), set by BranchGuard
   * on every company request: 'ALL' (no branch assigned) or the allowed set.
   * Never left unset on a company request: the branch helpers refuse that.
   */
  branchScope?: 'ALL' | ReadonlySet<bigint>;
  /**
   * Set by Cron work that runs in a company's context without a member
   * (stock-verify, the e-invoice sender): every branch, explicitly.
   */
  jobContext?: boolean;
}
