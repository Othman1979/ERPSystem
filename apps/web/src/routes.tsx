import type { ReactNode } from 'react';
import {
  AuditOutlined,
  BankOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ContainerOutlined,
  DashboardOutlined,
  DiffOutlined,
  ExportOutlined,
  FileAddOutlined,
  FileDoneOutlined,
  FileTextOutlined,
  FlagOutlined,
  FileProtectOutlined,
  ImportOutlined,
  InboxOutlined,
  MailOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  SolutionOutlined,
  TeamOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { lazyPage } from './lazyPage';
import { PERMISSIONS, type Permission } from './auth/permissions';
import { meetsProcurementLevel, type ProcurementLevel } from './auth/procurementLevel';
import type { ModuleTone } from './theme';

/**
 * Each module's page is its own chunk, loaded when first opened (WEB-10).
 * Exported for the test that checks every loader resolves to a component.
 */
export const PAGE_LOADERS = {
  accounts: () => import('./pages/AccountsPage').then((m) => m.AccountsPage),
  journal: () => import('./pages/JournalPage').then((m) => m.JournalPage),
  openingBalances: () => import('./pages/OpeningBalancesPage').then((m) => m.OpeningBalancesPage),
  treasury: () => import('./pages/TreasuryPage').then((m) => m.TreasuryPage),
  reports: () => import('./pages/ReportsPage').then((m) => m.ReportsPage),
  fiscal: () => import('./pages/FiscalPage').then((m) => m.FiscalPage),
  sales: () => import('./pages/SalesPage').then((m) => m.SalesPage),
  einvoice: () => import('./pages/EInvoicePage').then((m) => m.EInvoicePage),
  purchases: () => import('./pages/PurchasesPage').then((m) => m.PurchasesPage),
  purchaseRequests: () => import('./pages/PurchaseRequestsPage').then((m) => m.PurchaseRequestsPage),
  purchaseQuotes: () => import('./pages/PurchaseQuotesPage').then((m) => m.PurchaseQuotesPage),
  purchaseOrders: () => import('./pages/PurchaseOrdersPage').then((m) => m.PurchaseOrdersPage),
  goodsNotes: () => import('./pages/GoodsNotesPage').then((m) => m.GoodsNotesPage),
  issueRequests: () => import('./pages/IssueRequestsPage').then((m) => m.IssueRequestsPage),
  parties: () => import('./pages/PartiesPage').then((m) => m.PartiesPage),
  items: () => import('./pages/ItemsPage').then((m) => m.ItemsPage),
  warehouses: () => import('./pages/WarehousesPage').then((m) => m.WarehousesPage),
  stock: () => import('./pages/StockPage').then((m) => m.StockPage),
  users: () => import('./pages/UsersPage').then((m) => m.UsersPage),
  branches: () => import('./pages/BranchesPage').then((m) => m.BranchesPage),
  settings: () => import('./pages/SettingsPage').then((m) => m.SettingsPage),
  health: () => import('./pages/HealthPage').then((m) => m.HealthPage),
  invitations: () => import('./pages/InvitationsPage').then((m) => m.InvitationsPage),
};

const AccountsPage = lazyPage(PAGE_LOADERS.accounts);
const JournalPage = lazyPage(PAGE_LOADERS.journal);
const OpeningBalancesPage = lazyPage(PAGE_LOADERS.openingBalances);
const TreasuryPage = lazyPage(PAGE_LOADERS.treasury);
const ReportsPage = lazyPage(PAGE_LOADERS.reports);
const FiscalPage = lazyPage(PAGE_LOADERS.fiscal);
const SalesPage = lazyPage(PAGE_LOADERS.sales);
const EInvoicePage = lazyPage(PAGE_LOADERS.einvoice);
const PurchasesPage = lazyPage(PAGE_LOADERS.purchases);
const PurchaseRequestsPage = lazyPage(PAGE_LOADERS.purchaseRequests);
const PurchaseQuotesPage = lazyPage(PAGE_LOADERS.purchaseQuotes);
const PurchaseOrdersPage = lazyPage(PAGE_LOADERS.purchaseOrders);
const GoodsNotesPage = lazyPage(PAGE_LOADERS.goodsNotes);
const IssueRequestsPage = lazyPage(PAGE_LOADERS.issueRequests);
const PartiesPage = lazyPage(PAGE_LOADERS.parties);
const ItemsPage = lazyPage(PAGE_LOADERS.items);
const WarehousesPage = lazyPage(PAGE_LOADERS.warehouses);
const StockPage = lazyPage(PAGE_LOADERS.stock);
const UsersPage = lazyPage(PAGE_LOADERS.users);
const BranchesPage = lazyPage(PAGE_LOADERS.branches);
const SettingsPage = lazyPage(PAGE_LOADERS.settings);
const HealthPage = lazyPage(PAGE_LOADERS.health);
const InvitationsPage = lazyPage(PAGE_LOADERS.invitations);

export interface AppRoute {
  key: string;
  /** URL path, e.g. /sales. */
  path: string;
  /** i18n key of the module name. */
  label: string;
  icon: ReactNode;
  element: ReactNode;
  /** Count shown as a badge on the menu entry, when above zero. */
  badge?: 'pendingInvitations';
  /**
   * Permission the screen's main list needs (the API's @RequirePermission on
   * it). Without it the entry is hidden and the URL shows "no access" instead
   * of a request that fails with 403. Absent: no company permission needed.
   */
  permission?: Permission;
  /**
   * Lowest procurement level whose cycle uses the screen (ADR-024 §2.3): below
   * it the entry is hidden and the URL shows "no access". The purchase
   * request, quote and order screens of phase 12 (ADR-025), and phase 13's.
   */
  minProcurementLevel?: ProcurementLevel;
  /**
   * i18n key of the ribbon's sub-group caption (ADR-029 §3). Without one the
   * button sits under its tab's own caption.
   */
  section?: string;
  /**
   * Path that opens the screen's new-document form (`?new=1`, read by
   * useNewFromUrl). Only set where the page supports it; the ribbon then adds
   * a "new" button for it.
   */
  newPath?: string;
  /** Permission needed to create the document behind newPath; without it the button is not offered. */
  newPermission?: Permission;
}

export interface AppGroup {
  /** i18n key of the tab caption (ribbon) and of the menu heading. */
  label: string;
  /** Tab colour (theme.ts moduleTone), also the home-screen colour. */
  tone: ModuleTone;
  routes: AppRoute[];
}

/** A "new document" shortcut on the home screen and in the ribbon's home tab. */
export interface QuickAction {
  key: string;
  /** i18n key of the button label. */
  label: string;
  path: string;
  icon: ReactNode;
  tone: ModuleTone;
  permission: Permission;
}

/** Everyday documents, opened straight into a new form (pages read `?new=1`); shown to roles that may create them. */
export const QUICK_ACTIONS: QuickAction[] = [
  { key: 'sale', label: 'sales.newInvoice', path: '/sales?new=1', icon: <ShoppingCartOutlined />, tone: 'sales', permission: PERMISSIONS.SALES_MANAGE },
  { key: 'purchase', label: 'purchases.newInvoice', path: '/purchases?new=1', icon: <ShoppingOutlined />, tone: 'purchases', permission: PERMISSIONS.PURCHASE_MANAGE },
  { key: 'receipt', label: 'treasury.newReceipt', path: '/treasury?tab=receipts&new=1', icon: <ImportOutlined />, tone: 'treasury', permission: PERMISSIONS.TREASURY_MANAGE },
  { key: 'payment', label: 'treasury.newPayment', path: '/treasury?tab=payments&new=1', icon: <ExportOutlined />, tone: 'treasury', permission: PERMISSIONS.TREASURY_MANAGE },
  { key: 'journal', label: 'journal.newEntry', path: '/journal?new=1', icon: <ProfileOutlined />, tone: 'accounting', permission: PERMISSIONS.JOURNAL_MANAGE },
];

/** The platform owner's console (§13.3), outside the tenant modules. */
export const PLATFORM_PATH = '/platform';

/** Invitations are reachable without a company (ADR-012 §PLAT-10). */
export const INVITATIONS_PATH = '/invitations';

/** The setup wizard (§13.4), outside the module groups. */
export const SETUP_PATH = '/setup';
/** The wizard reads /tax-categories and finishes with POST /company/onboarding/complete: both need this. */
export const SETUP_PERMISSION: Permission = PERMISSIONS.SETTINGS_MANAGE;

/** Suppliers and customers: one screen, listed under both sales and purchases. */
const PARTIES_ROUTE: AppRoute = {
  key: 'parties',
  path: '/parties',
  label: 'nav.parties',
  icon: <SolutionOutlined />,
  element: <PartiesPage />,
  permission: PERMISSIONS.TENANT_READ,
  section: 'nav.sectionPartners',
};

/**
 * Every module, in the order of the ribbon's tabs (ADR-029 §3) and of the side menu.
 * A tab is a group; `section` splits its buttons into captioned sub-groups.
 */
export const APP_GROUPS: AppGroup[] = [
  {
    label: 'nav.groupAccounting',
    tone: 'accounting',
    routes: [
      { key: 'accounts', path: '/accounts', label: 'nav.accounts', icon: <BankOutlined />, element: <AccountsPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionLedger' },
      {
        key: 'journal',
        path: '/journal',
        label: 'nav.journal',
        icon: <ProfileOutlined />,
        element: <JournalPage />,
        permission: PERMISSIONS.TENANT_READ,
        section: 'nav.sectionLedger',
        newPath: '/journal?new=1',
        newPermission: PERMISSIONS.JOURNAL_MANAGE,
      },
      {
        key: 'openingBalances',
        path: '/opening-balances',
        label: 'nav.openingBalances',
        icon: <FlagOutlined />,
        element: <OpeningBalancesPage />,
        permission: PERMISSIONS.TENANT_READ,
        section: 'nav.sectionLedger',
        newPath: '/opening-balances?new=1',
        newPermission: PERMISSIONS.JOURNAL_MANAGE,
      },
      { key: 'fiscal', path: '/fiscal', label: 'nav.fiscal', icon: <CalendarOutlined />, element: <FiscalPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionPeriods' },
    ],
  },
  {
    label: 'nav.groupTreasury',
    tone: 'treasury',
    routes: [
      { key: 'treasury', path: '/treasury', label: 'nav.treasury', icon: <WalletOutlined />, element: <TreasuryPage />, permission: PERMISSIONS.TENANT_READ },
    ],
  },
  {
    label: 'nav.groupSales',
    tone: 'sales',
    routes: [
      {
        key: 'sales',
        path: '/sales',
        label: 'nav.sales',
        icon: <ShoppingCartOutlined />,
        element: <SalesPage />,
        permission: PERMISSIONS.TENANT_READ,
        section: 'nav.sectionDocuments',
        newPath: '/sales?new=1',
        newPermission: PERMISSIONS.SALES_MANAGE,
      },
      { key: 'einvoice', path: '/einvoice', label: 'nav.einvoice', icon: <FileProtectOutlined />, element: <EInvoicePage />, permission: PERMISSIONS.REPORTS_VIEW, section: 'nav.sectionDocuments' },
      PARTIES_ROUTE,
    ],
  },
  {
    label: 'nav.groupPurchases',
    tone: 'purchases',
    routes: [
      {
        key: 'purchases',
        path: '/purchases',
        label: 'nav.purchases',
        icon: <ShoppingOutlined />,
        element: <PurchasesPage />,
        permission: PERMISSIONS.TENANT_READ,
        section: 'nav.sectionDocuments',
        newPath: '/purchases?new=1',
        newPermission: PERMISSIONS.PURCHASE_MANAGE,
      },
      { key: 'goodsNotes', path: '/goods-notes', label: 'nav.goodsNotes', icon: <FileDoneOutlined />, element: <GoodsNotesPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionDocuments' },
      // Phase 12 (ADR-025): requests and quotes at FULL, orders from MEDIUM.
      {
        key: 'purchaseRequests',
        path: '/purchase-requests',
        label: 'nav.purchaseRequests',
        icon: <FileAddOutlined />,
        element: <PurchaseRequestsPage />,
        permission: PERMISSIONS.TENANT_READ,
        minProcurementLevel: 'FULL',
        section: 'nav.sectionCycle',
        newPath: '/purchase-requests?new=1',
        newPermission: PERMISSIONS.PURCHASE_REQUEST_MANAGE,
      },
      {
        key: 'purchaseQuotes',
        path: '/purchase-quotes',
        label: 'nav.purchaseQuotes',
        icon: <DiffOutlined />,
        element: <PurchaseQuotesPage />,
        permission: PERMISSIONS.TENANT_READ,
        minProcurementLevel: 'FULL',
        section: 'nav.sectionCycle',
        newPath: '/purchase-quotes?new=1',
        newPermission: PERMISSIONS.PURCHASE_MANAGE,
      },
      {
        key: 'purchaseOrders',
        path: '/purchase-orders',
        label: 'nav.purchaseOrders',
        icon: <FileTextOutlined />,
        element: <PurchaseOrdersPage />,
        permission: PERMISSIONS.TENANT_READ,
        minProcurementLevel: 'MEDIUM',
        section: 'nav.sectionCycle',
        newPath: '/purchase-orders?new=1',
        newPermission: PERMISSIONS.PURCHASE_MANAGE,
      },
      PARTIES_ROUTE,
    ],
  },
  {
    label: 'nav.groupInventory',
    tone: 'inventory',
    routes: [
      { key: 'items', path: '/items', label: 'nav.items', icon: <InboxOutlined />, element: <ItemsPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionCatalog' },
      { key: 'warehouses', path: '/warehouses', label: 'nav.warehouses', icon: <ContainerOutlined />, element: <WarehousesPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionCatalog' },
      { key: 'stock', path: '/stock', label: 'nav.stock', icon: <AuditOutlined />, element: <StockPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionMovements' },
      // Phase 13 (ADR-026 §9): issue requests, FULL procurement level only.
      {
        key: 'issueRequests',
        path: '/issue-requests',
        label: 'nav.issueRequests',
        icon: <ExportOutlined />,
        element: <IssueRequestsPage />,
        permission: PERMISSIONS.TENANT_READ,
        minProcurementLevel: 'FULL',
        section: 'nav.sectionMovements',
        newPath: '/issue-requests?new=1',
        newPermission: PERMISSIONS.PURCHASE_REQUEST_MANAGE,
      },
    ],
  },
  {
    label: 'nav.groupReports',
    tone: 'reports',
    routes: [
      { key: 'reports', path: '/reports', label: 'nav.reports', icon: <BarChartOutlined />, element: <ReportsPage />, permission: PERMISSIONS.REPORTS_VIEW },
    ],
  },
  {
    label: 'nav.groupAdmin',
    tone: 'admin',
    routes: [
      { key: 'users', path: '/users', label: 'nav.users', icon: <TeamOutlined />, element: <UsersPage />, permission: PERMISSIONS.USER_MANAGE, section: 'nav.sectionPeople' },
      { key: 'branches', path: '/branches', label: 'nav.branches', icon: <ShopOutlined />, element: <BranchesPage />, permission: PERMISSIONS.TENANT_READ, section: 'nav.sectionCompany' },
      { key: 'settings', path: '/settings', label: 'nav.settings', icon: <SettingOutlined />, element: <SettingsPage />, permission: PERMISSIONS.SETTINGS_MANAGE, section: 'nav.sectionCompany' },
      { key: 'health', path: '/health', label: 'nav.health', icon: <DashboardOutlined />, element: <HealthPage />, section: 'nav.sectionSystem' },
    ],
  },
  {
    label: 'nav.groupAccount',
    tone: 'admin',
    routes: [
      {
        key: 'invitations',
        path: INVITATIONS_PATH,
        label: 'nav.invitations',
        icon: <MailOutlined />,
        element: <InvitationsPage />,
        badge: 'pendingInvitations',
      },
    ],
  },
];

/** Each screen once, even when a tab lists it too (parties): routes are registered by key. */
export const ALL_ROUTES: AppRoute[] = APP_GROUPS.flatMap((g) => g.routes).filter(
  (route, index, all) => all.findIndex((other) => other.key === route.key) === index,
);

/**
 * True when a role with `can`, in a company at procurement `level`, may open
 * `route`: the permission it names, if any, and its minimum level, if any.
 */
export function allowedRoute(
  route: AppRoute,
  can: (permission: Permission) => boolean,
  level?: ProcurementLevel,
): boolean {
  return (!route.permission || can(route.permission)) && meetsProcurementLevel(level, route.minProcurementLevel);
}

/**
 * True when a role with `can` may open `path` (a module, its nested paths or
 * the setup wizard). Paths that need no company permission (help, legal) are open.
 */
export function canOpenPath(path: string, can: (permission: Permission) => boolean, level?: ProcurementLevel): boolean {
  const bare = path.split('?')[0];
  if (bare === SETUP_PATH || bare.startsWith(`${SETUP_PATH}/`)) return can(SETUP_PERMISSION);
  const route = routeForPath(bare);
  return !route || allowedRoute(route, can, level);
}

/** `groups` with only the routes the role may open at `level`; groups left empty are dropped. */
export function allowedGroups(
  groups: AppGroup[],
  can: (permission: Permission) => boolean,
  level?: ProcurementLevel,
): AppGroup[] {
  return groups
    .map((g) => ({ ...g, routes: g.routes.filter((r) => allowedRoute(r, can, level)) }))
    .filter((g) => g.routes.length > 0);
}

/** The module a URL belongs to (also matches nested paths like /sales/…); undefined on home. */
export function routeForPath(pathname: string): AppRoute | undefined {
  return ALL_ROUTES.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`));
}
