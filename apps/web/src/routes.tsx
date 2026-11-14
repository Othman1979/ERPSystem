import type { ReactNode } from 'react';
import {
  AuditOutlined,
  BankOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ContainerOutlined,
  DashboardOutlined,
  FileDoneOutlined,
  FlagOutlined,
  FileProtectOutlined,
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
  goodsNotes: () => import('./pages/GoodsNotesPage').then((m) => m.GoodsNotesPage),
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
const GoodsNotesPage = lazyPage(PAGE_LOADERS.goodsNotes);
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
}

export interface AppGroup {
  /** i18n key of the group heading. */
  label: string;
  /** Tile colour for the group on the home screen (theme token name). */
  tone: 'finance' | 'trade' | 'inventory' | 'admin';
  routes: AppRoute[];
}

/** Invitations are reachable without a company (ADR-012 §PLAT-10). */
export const INVITATIONS_PATH = '/invitations';

/** The setup wizard (§13.4), outside the module groups. */
export const SETUP_PATH = '/setup';
/** The wizard reads /tax-categories and finishes with POST /company/onboarding/complete: both need this. */
export const SETUP_PERMISSION: Permission = PERMISSIONS.SETTINGS_MANAGE;

/** Every module, grouped as on the home screen and in the side menu. */
export const APP_GROUPS: AppGroup[] = [
  {
    label: 'nav.groupFinance',
    tone: 'finance',
    routes: [
      { key: 'accounts', path: '/accounts', label: 'nav.accounts', icon: <BankOutlined />, element: <AccountsPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'journal', path: '/journal', label: 'nav.journal', icon: <ProfileOutlined />, element: <JournalPage />, permission: PERMISSIONS.TENANT_READ },
      {
        key: 'openingBalances',
        path: '/opening-balances',
        label: 'nav.openingBalances',
        icon: <FlagOutlined />,
        element: <OpeningBalancesPage />,
        permission: PERMISSIONS.TENANT_READ,
      },
      { key: 'treasury', path: '/treasury', label: 'nav.treasury', icon: <WalletOutlined />, element: <TreasuryPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'reports', path: '/reports', label: 'nav.reports', icon: <BarChartOutlined />, element: <ReportsPage />, permission: PERMISSIONS.REPORTS_VIEW },
      { key: 'fiscal', path: '/fiscal', label: 'nav.fiscal', icon: <CalendarOutlined />, element: <FiscalPage />, permission: PERMISSIONS.TENANT_READ },
    ],
  },
  {
    label: 'nav.groupSales',
    tone: 'trade',
    routes: [
      { key: 'sales', path: '/sales', label: 'nav.sales', icon: <ShoppingCartOutlined />, element: <SalesPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'einvoice', path: '/einvoice', label: 'nav.einvoice', icon: <FileProtectOutlined />, element: <EInvoicePage />, permission: PERMISSIONS.REPORTS_VIEW },
      { key: 'purchases', path: '/purchases', label: 'nav.purchases', icon: <ShoppingOutlined />, element: <PurchasesPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'goodsNotes', path: '/goods-notes', label: 'nav.goodsNotes', icon: <FileDoneOutlined />, element: <GoodsNotesPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'parties', path: '/parties', label: 'nav.parties', icon: <SolutionOutlined />, element: <PartiesPage />, permission: PERMISSIONS.TENANT_READ },
    ],
  },
  {
    label: 'nav.groupInventory',
    tone: 'inventory',
    routes: [
      { key: 'items', path: '/items', label: 'nav.items', icon: <InboxOutlined />, element: <ItemsPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'warehouses', path: '/warehouses', label: 'nav.warehouses', icon: <ContainerOutlined />, element: <WarehousesPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'stock', path: '/stock', label: 'nav.stock', icon: <AuditOutlined />, element: <StockPage />, permission: PERMISSIONS.TENANT_READ },
    ],
  },
  {
    label: 'nav.groupAdmin',
    tone: 'admin',
    routes: [
      { key: 'users', path: '/users', label: 'nav.users', icon: <TeamOutlined />, element: <UsersPage />, permission: PERMISSIONS.USER_MANAGE },
      { key: 'branches', path: '/branches', label: 'nav.branches', icon: <ShopOutlined />, element: <BranchesPage />, permission: PERMISSIONS.TENANT_READ },
      { key: 'settings', path: '/settings', label: 'nav.settings', icon: <SettingOutlined />, element: <SettingsPage />, permission: PERMISSIONS.SETTINGS_MANAGE },
      { key: 'health', path: '/health', label: 'nav.health', icon: <DashboardOutlined />, element: <HealthPage /> },
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

export const ALL_ROUTES: AppRoute[] = APP_GROUPS.flatMap((g) => g.routes);

/** True when a role with `can` may open `route` (the permission it names, if any). */
export function allowedRoute(route: AppRoute, can: (permission: Permission) => boolean): boolean {
  return !route.permission || can(route.permission);
}

/**
 * True when a role with `can` may open `path` (a module, its nested paths or
 * the setup wizard). Paths that need no company permission (help, legal) are open.
 */
export function canOpenPath(path: string, can: (permission: Permission) => boolean): boolean {
  const bare = path.split('?')[0];
  if (bare === SETUP_PATH || bare.startsWith(`${SETUP_PATH}/`)) return can(SETUP_PERMISSION);
  const route = routeForPath(bare);
  return !route || allowedRoute(route, can);
}

/** `groups` with only the routes the role may open; groups left empty are dropped. */
export function allowedGroups(groups: AppGroup[], can: (permission: Permission) => boolean): AppGroup[] {
  return groups
    .map((g) => ({ ...g, routes: g.routes.filter((r) => allowedRoute(r, can)) }))
    .filter((g) => g.routes.length > 0);
}

/** The module a URL belongs to (also matches nested paths like /sales/…); undefined on home. */
export function routeForPath(pathname: string): AppRoute | undefined {
  return ALL_ROUTES.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`));
}
