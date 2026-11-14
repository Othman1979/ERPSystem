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
  PERMISSIONS.STOCK_ISSUE_WITHOUT_REQUEST,
] as const;

export type MemberPermissionCode = (typeof MEMBER_PERMISSION_CODES)[number];

/** The one code with an amount limit. */
export const LIMITED_MEMBER_PERMISSION: MemberPermissionCode = PERMISSIONS.PURCHASE_APPROVE;

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
}

const isMemberCode = (code: string): code is MemberPermissionCode =>
  (MEMBER_PERMISSION_CODES as readonly string[]).includes(code);

/** What a member holds: everything for an owner, else the stored grants of the fixed codes. */
export function effectiveMemberPermissions(roleCode: string, grants: readonly MemberPermissionGrant[]): EffectiveMemberPermissions {
  if (roleCode === OWNER_ROLE) return { codes: [...MEMBER_PERMISSION_CODES], approvalLimit: null };
  const held = new Set(grants.map((g) => g.permissionCode).filter(isMemberCode));
  const approve = grants.find((g) => g.permissionCode === LIMITED_MEMBER_PERMISSION);
  return {
    codes: MEMBER_PERMISSION_CODES.filter((c) => held.has(c)),
    approvalLimit: approve?.amountLimit ? approve.amountLimit.toFixed(3) : null,
  };
}
