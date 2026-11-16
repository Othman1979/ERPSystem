import type { MemberPermissionCode, UpdatePurchasePermissionsDto, UserPurchasePermissionDto } from '@erp/api-client';
import { toDecimal } from '../../format/number';

/**
 * The member permissions an owner grants (ADR-013 §2, ADR-024 §3, ADR-027 §6),
 * in the API's order, with the i18n key of each (users.purchaseCodes.<key>,
 * users.purchaseHints.<key>).
 */
export const PURCHASE_PERMISSIONS: readonly { code: MemberPermissionCode; key: string }[] = [
  { code: 'purchase.direct', key: 'direct' },
  { code: 'purchase.approve', key: 'approve' },
  { code: 'sales.approve', key: 'salesApprove' },
  { code: 'stock.issue_without_request', key: 'issueWithoutRequest' },
];

/** The codes with an amount limit: each has its own, the purchase and the sales approval alike. */
export const APPROVE_CODE: MemberPermissionCode = 'purchase.approve';
export const SALES_APPROVE_CODE: MemberPermissionCode = 'sales.approve';

/** The editor's form: the codes ticked, and each approval limit as typed. */
export interface PurchasePermissionsForm {
  codes: MemberPermissionCode[];
  approvalLimit?: string;
  salesApprovalLimit?: string;
}

/** A member's permissions, as the editor opens them. */
export function toPurchaseForm(held: readonly UserPurchasePermissionDto[]): PurchasePermissionsForm {
  const limitOf = (code: MemberPermissionCode) => held.find((p) => p.code === code)?.amountLimit ?? undefined;
  return {
    codes: held.map((p) => p.code),
    approvalLimit: limitOf(APPROVE_CODE),
    salesApprovalLimit: limitOf(SALES_APPROVE_CODE),
  };
}

/** The API's amount rule: up to 15 digits and 3 decimals, no sign, and above zero. */
export function isApprovalLimit(text: string): boolean {
  if (!/^\d{1,15}(\.\d{1,3})?$/.test(text)) return false;
  return toDecimal(text)?.greaterThan(0) ?? false;
}

/**
 * The PUT body: every ticked code, in the API's order. Each approval code
 * takes its own limit, and only when one was typed (blank = no limit).
 */
export function purchasePermissionsPayload(form: PurchasePermissionsForm): UpdatePurchasePermissionsDto {
  const limits: Partial<Record<MemberPermissionCode, string | undefined>> = {
    [APPROVE_CODE]: form.approvalLimit?.trim(),
    [SALES_APPROVE_CODE]: form.salesApprovalLimit?.trim(),
  };
  return {
    permissions: PURCHASE_PERMISSIONS.filter((p) => form.codes.includes(p.code)).map((p) => {
      const limit = limits[p.code];
      return limit ? { code: p.code, amountLimit: limit } : { code: p.code };
    }),
  };
}
