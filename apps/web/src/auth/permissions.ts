/**
 * Permission codes the web checks with `useAuth().can(...)`. They mirror
 * apps/api/src/common/permissions/permissions.ts (the API is the authority:
 * GET /me lists the codes the caller's role has in the active tenant, and the
 * guards enforce them). Only the codes the web uses are listed here.
 */
export const PERMISSIONS = {
  TENANT_READ: 'tenant.read',
  USER_MANAGE: 'user.manage',
  SETTINGS_MANAGE: 'settings.manage',
  JOURNAL_MANAGE: 'journal.manage',
  SALES_MANAGE: 'sales.manage',
  PURCHASE_MANAGE: 'purchase.manage',
  TREASURY_MANAGE: 'treasury.manage',
  EINVOICE_MANAGE: 'einvoice.manage',
  REPORTS_VIEW: 'reports.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
