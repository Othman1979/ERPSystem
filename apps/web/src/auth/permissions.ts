/**
 * Permission codes the web checks with `useAuth().can(...)`. They mirror
 * apps/api/src/common/permissions/permissions.ts (the API is the authority:
 * GET /me lists the codes the caller's role has in the active tenant, and the
 * guards enforce them). Only the codes the web uses are listed here.
 */
export const PERMISSIONS = {
  TENANT_READ: 'tenant.read',
  USER_MANAGE: 'user.manage',
  COMPANY_MANAGE: 'company.manage',
  SETTINGS_MANAGE: 'settings.manage',
  JOURNAL_MANAGE: 'journal.manage',
  SALES_MANAGE: 'sales.manage',
  PURCHASE_MANAGE: 'purchase.manage',
  /** Create, edit and submit purchase requests (ADR-025 §13). */
  PURCHASE_REQUEST_MANAGE: 'purchase_request.manage',
  TREASURY_MANAGE: 'treasury.manage',
  EINVOICE_MANAGE: 'einvoice.manage',
  REPORTS_VIEW: 'reports.view',
  COST_CENTER_MANAGE: 'cost_center.manage',
  // Purchase permissions per member (ADR-024 §3); an owner holds all three.
  PURCHASE_DIRECT: 'purchase.direct',
  PURCHASE_APPROVE: 'purchase.approve',
  STOCK_ISSUE_WITHOUT_REQUEST: 'stock.issue_without_request',
  /** Post stock movements, e.g. the issue note of an approved issue request (ADR-026 §9). */
  STOCK_MOVEMENT: 'stock.movement',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
