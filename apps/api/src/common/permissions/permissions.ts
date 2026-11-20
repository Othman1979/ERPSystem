/**
 * Static permission catalog (docs/BUILD_PLAN.md §7.1 note: permissions are
 * defined in code and bound to roles via seed — no UI editor in MVP).
 */
export const PERMISSIONS = {
  TENANT_READ: 'tenant.read',
  USER_MANAGE: 'user.manage',
  BRANCH_MANAGE: 'branch.manage',
  COMPANY_MANAGE: 'company.manage',
  SETTINGS_MANAGE: 'settings.manage',
  ACCOUNT_MANAGE: 'account.manage',
  /** Cost centre tree (ADR-024 §1). */
  COST_CENTER_MANAGE: 'cost_center.manage',
  JOURNAL_MANAGE: 'journal.manage',
  JOURNAL_POST: 'journal.post',
  FISCAL_MANAGE: 'fiscal.manage',
  FISCAL_CLOSE: 'fiscal.close',
  ITEM_MANAGE: 'item.manage',
  WAREHOUSE_MANAGE: 'warehouse.manage',
  STOCK_MOVEMENT: 'stock.movement',
  PARTIES_MANAGE: 'parties.manage',
  SALES_MANAGE: 'sales.manage',
  SALES_POST: 'sales.post',
  SALES_RETURN: 'sales.return',
  /** Approve sales orders over the credit limit or flagged ALWAYS, up to a limit (ADR-027 §6). */
  SALES_APPROVE: 'sales.approve',
  PURCHASE_MANAGE: 'purchase.manage',
  PURCHASE_POST: 'purchase.post',
  PURCHASE_RETURN: 'purchase.return',
  /** Create, edit and submit purchase requests (ADR-025 §13). */
  PURCHASE_REQUEST_MANAGE: 'purchase_request.manage',
  TREASURY_MANAGE: 'treasury.manage',
  EINVOICE_MANAGE: 'einvoice.manage',
  REPORTS_VIEW: 'reports.view',
  AUDIT_VIEW: 'audit.view',
  IMPORT_EXPORT: 'import_export.manage',
  ONBOARDING_MANAGE: 'onboarding.manage',
  // Purchase permissions per member (ADR-013 §2, ADR-024 §3): granted by an
  // owner in member_permissions on top of the role; an owner holds all three.
  PURCHASE_DIRECT: 'purchase.direct',
  PURCHASE_APPROVE: 'purchase.approve',
  STOCK_ISSUE_WITHOUT_REQUEST: 'stock.issue_without_request',
  PLATFORM_ADMIN: 'platform.admin',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const ALL_TENANT_PERMISSIONS: PermissionCode[] = Object.values(PERMISSIONS).filter(
  (p) => p !== PERMISSIONS.PLATFORM_ADMIN,
);

const FINANCE_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.BRANCH_MANAGE,
  PERMISSIONS.COMPANY_MANAGE,
  PERMISSIONS.SETTINGS_MANAGE,
  PERMISSIONS.ACCOUNT_MANAGE,
  PERMISSIONS.COST_CENTER_MANAGE,
  PERMISSIONS.JOURNAL_MANAGE,
  PERMISSIONS.JOURNAL_POST,
  PERMISSIONS.FISCAL_MANAGE,
  PERMISSIONS.FISCAL_CLOSE,
  PERMISSIONS.PARTIES_MANAGE,
  PERMISSIONS.SALES_MANAGE,
  PERMISSIONS.SALES_POST,
  PERMISSIONS.SALES_RETURN,
  PERMISSIONS.PURCHASE_MANAGE,
  PERMISSIONS.PURCHASE_POST,
  PERMISSIONS.PURCHASE_RETURN,
  PERMISSIONS.PURCHASE_REQUEST_MANAGE,
  PERMISSIONS.TREASURY_MANAGE,
  PERMISSIONS.EINVOICE_MANAGE,
  PERMISSIONS.REPORTS_VIEW,
  PERMISSIONS.AUDIT_VIEW,
  PERMISSIONS.IMPORT_EXPORT,
  PERMISSIONS.ONBOARDING_MANAGE,
];

const STORE_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.ITEM_MANAGE,
  PERMISSIONS.WAREHOUSE_MANAGE,
  PERMISSIONS.STOCK_MOVEMENT,
  PERMISSIONS.PARTIES_MANAGE,
  PERMISSIONS.PURCHASE_REQUEST_MANAGE,
  PERMISSIONS.REPORTS_VIEW,
];

const CASHIER_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.SALES_MANAGE,
  PERMISSIONS.SALES_POST,
  PERMISSIONS.SALES_RETURN,
  PERMISSIONS.PURCHASE_MANAGE,
  PERMISSIONS.TREASURY_MANAGE,
  PERMISSIONS.REPORTS_VIEW,
];

const VIEWER_PERMISSIONS: PermissionCode[] = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.REPORTS_VIEW,
];

export const ROLE_PERMISSIONS: Record<string, PermissionCode[]> = {
  OWNER: ALL_TENANT_PERMISSIONS,
  ACCOUNTANT: FINANCE_PERMISSIONS,
  STOREKEEPER: STORE_PERMISSIONS,
  CASHIER: CASHIER_PERMISSIONS,
  VIEWER: VIEWER_PERMISSIONS,
};

export const ROLE_DEFINITIONS: { code: string; nameAr: string; nameEn: string; description: string }[] = [
  { code: 'OWNER', nameAr: 'مالك', nameEn: 'Owner', description: 'Full access to the tenant' },
  { code: 'ACCOUNTANT', nameAr: 'محاسب', nameEn: 'Accountant', description: 'Finance, accounting and reports' },
  { code: 'STOREKEEPER', nameAr: 'أمين مستودع', nameEn: 'Storekeeper', description: 'Inventory and stock operations' },
  { code: 'CASHIER', nameAr: 'أمين صندوق', nameEn: 'Cashier', description: 'Sales, purchasing docs and treasury' },
  { code: 'VIEWER', nameAr: 'مشاهد', nameEn: 'Viewer', description: 'Read-only access' },
];

/**
 * What a company's own role may hold (ADR-038 §3): every tenant permission
 * except team management (owner only, PLAT-28) and the per-member grants
 * with limits (member_permissions: purchase, ADR-024 §3; sales approval, ADR-027 §6).
 */
export const CUSTOM_ROLE_PERMISSIONS: PermissionCode[] = ALL_TENANT_PERMISSIONS.filter(
  (p) =>
    p !== PERMISSIONS.USER_MANAGE &&
    // Sales approval carries a per-member amount limit (ADR-027 §6), read from member_permissions.
    p !== PERMISSIONS.SALES_APPROVE &&
    p !== PERMISSIONS.PURCHASE_DIRECT &&
    p !== PERMISSIONS.PURCHASE_APPROVE &&
    p !== PERMISSIONS.STOCK_ISSUE_WITHOUT_REQUEST,
);
