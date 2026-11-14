import type { MemberPermissionCode, UpdatePurchasePermissionsDto, UserPurchasePermissionDto } from '@erp/api-client';
import { toDecimal } from '../../format/number';

/**
 * The three purchase permissions an owner grants a member (ADR-013 §2,
 * ADR-024 §3), in the API's order, with the i18n key of each
 * (users.purchaseCodes.<key>, users.purchaseHints.<key>).
 */
export const PURCHASE_PERMISSIONS: readonly { code: MemberPermissionCode; key: string }[] = [
  { code: 'purchase.direct', key: 'direct' },
  { code: 'purchase.approve', key: 'approve' },
  { code: 'stock.issue_without_request', key: 'issueWithoutRequest' },
];

/** The one permission with an amount limit. */
export const APPROVE_CODE: MemberPermissionCode = 'purchase.approve';

/** The editor's form: the codes ticked, and the approval limit as typed. */
export interface PurchasePermissionsForm {
  codes: MemberPermissionCode[];
  approvalLimit?: string;
}

/** A member's permissions, as the editor opens them. */
export function toPurchaseForm(held: readonly UserPurchasePermissionDto[]): PurchasePermissionsForm {
  const approve = held.find((p) => p.code === APPROVE_CODE);
  return { codes: held.map((p) => p.code), approvalLimit: approve?.amountLimit ?? undefined };
}

/** The API's amount rule: up to 15 digits and 3 decimals, no sign, and above zero. */
export function isApprovalLimit(text: string): boolean {
  if (!/^\d{1,15}(\.\d{1,3})?$/.test(text)) return false;
  return toDecimal(text)?.greaterThan(0) ?? false;
}

/**
 * The PUT body: every ticked code, in the API's order; the limit only on
 * purchase.approve, and only when one was typed (blank = no limit).
 */
export function purchasePermissionsPayload(form: PurchasePermissionsForm): UpdatePurchasePermissionsDto {
  const limit = form.approvalLimit?.trim();
  return {
    permissions: PURCHASE_PERMISSIONS.filter((p) => form.codes.includes(p.code)).map((p) =>
      p.code === APPROVE_CODE && limit ? { code: p.code, amountLimit: limit } : { code: p.code },
    ),
  };
}
