/**
 * Purchase permissions per member (ADR-013 §2, ADR-024 §3). Three fixed codes,
 * stored in member_permissions on top of the role's permissions; not a general
 * permission editor (that stays deferred, BUILD_PLAN §20).
 *
 *  - an OWNER holds all three, with no approval limit, whatever is stored;
 *  - only purchase.approve carries an amount limit (null = no limit);
 *  - phase 11 stores and shows them: no existing route requires them yet.
 */
import { PERMISSIONS } from './permissions.js';

export const MEMBER_PERMISSION_CODES = [
  PERMISSIONS.PURCHASE_DIRECT,
  PERMISSIONS.PURCHASE_APPROVE,
  PERMISSIONS.SALES_APPROVE,
  PERMISSIONS.STOCK_ISSUE_WITHOUT_REQUEST,
] as const;

export type MemberPermissionCode = (typeof MEMBER_PERMISSION_CODES)[number];

/** The codes that carry an amount limit: the approvals (ADR-025 §2, ADR-027 §6). */
export const LIMITED_MEMBER_PERMISSIONS = [PERMISSIONS.PURCHASE_APPROVE, PERMISSIONS.SALES_APPROVE] as const;
export type LimitedMemberPermission = (typeof LIMITED_MEMBER_PERMISSIONS)[number];

/** The purchase.approve code (kept for the purchase callers). */
export const LIMITED_MEMBER_PERMISSION: LimitedMemberPermission = PERMISSIONS.PURCHASE_APPROVE;

export const isLimitedMemberPermission = (code: string): code is LimitedMemberPermission =>
  (LIMITED_MEMBER_PERMISSIONS as readonly string[]).includes(code);

/** The role whose members hold every member permission implicitly. */
export const OWNER_ROLE = 'OWNER';

/** A stored grant, as read from member_permissions. */
export interface MemberPermissionGrant {
  permissionCode: string;
  amountLimit: { toFixed(dp: number): string } | null;
}

export interface EffectiveMemberPermissions {
  /** Member permission codes the member holds, in catalog order. */
  codes: MemberPermissionCode[];
  /**
   * The purchase.approve limit as a 3-decimal string; null when there is no
   * limit, or when the member cannot approve (then `codes` lacks purchase.approve).
   */
  approvalLimit: string | null;
  /** The sales.approve limit, same rule as approvalLimit. */
  salesApprovalLimit: string | null;
}

const isMemberCode = (code: string): code is MemberPermissionCode =>
  (MEMBER_PERMISSION_CODES as readonly string[]).includes(code);

const limitOf = (grants: readonly MemberPermissionGrant[], code: LimitedMemberPermission): string | null => {
  const g = grants.find((x) => x.permissionCode === code);
  return g?.amountLimit ? g.amountLimit.toFixed(3) : null;
};

/** The limit of one limited code as the member holds it (null when none). */
export function approvalLimitOf(eff: EffectiveMemberPermissions, code: LimitedMemberPermission): string | null {
  return code === PERMISSIONS.SALES_APPROVE ? eff.salesApprovalLimit : eff.approvalLimit;
}

/** What a member holds: everything for an owner, else the stored grants of the fixed codes. */
export function effectiveMemberPermissions(roleCode: string, grants: readonly MemberPermissionGrant[]): EffectiveMemberPermissions {
  if (roleCode === OWNER_ROLE) return { codes: [...MEMBER_PERMISSION_CODES], approvalLimit: null, salesApprovalLimit: null };
  const held = new Set(grants.map((g) => g.permissionCode).filter(isMemberCode));
  return {
    codes: MEMBER_PERMISSION_CODES.filter((c) => held.has(c)),
    approvalLimit: limitOf(grants, PERMISSIONS.PURCHASE_APPROVE),
    salesApprovalLimit: limitOf(grants, PERMISSIONS.SALES_APPROVE),
  };
}
