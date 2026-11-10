import type { ReactNode } from 'react';
import {
  AuditOutlined,
  BankOutlined,
  BarChartOutlined,
  CalendarOutlined,
  ContainerOutlined,
  DashboardOutlined,
  FileDoneOutlined,
  InboxOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  SolutionOutlined,
  TeamOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { AccountsPage } from './pages/AccountsPage';
import { BranchesPage } from './pages/BranchesPage';
import { FiscalPage } from './pages/FiscalPage';
import { GoodsNotesPage } from './pages/GoodsNotesPage';
import { HealthPage } from './pages/HealthPage';
import { ItemsPage } from './pages/ItemsPage';
import { JournalPage } from './pages/JournalPage';
import { PartiesPage } from './pages/PartiesPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { ReportsPage } from './pages/ReportsPage';
import { SalesPage } from './pages/SalesPage';
import { SettingsPage } from './pages/SettingsPage';
import { StockPage } from './pages/StockPage';
import { TreasuryPage } from './pages/TreasuryPage';
import { UsersPage } from './pages/UsersPage';
import { WarehousesPage } from './pages/WarehousesPage';

export interface AppRoute {
  key: string;
  /** URL path, e.g. /sales. */
  path: string;
  /** i18n key of the module name. */
  label: string;
  icon: ReactNode;
  element: ReactNode;
}

export interface AppGroup {
  /** i18n key of the group heading. */
  label: string;
  /** Tile colour for the group on the home screen (theme token name). */
  tone: 'finance' | 'trade' | 'inventory' | 'admin';
  routes: AppRoute[];
}

/** Every module, grouped as on the home screen and in the side menu. */
export const APP_GROUPS: AppGroup[] = [
  {
    label: 'nav.groupFinance',
    tone: 'finance',
    routes: [
      { key: 'accounts', path: '/accounts', label: 'nav.accounts', icon: <BankOutlined />, element: <AccountsPage /> },
      { key: 'journal', path: '/journal', label: 'nav.journal', icon: <ProfileOutlined />, element: <JournalPage /> },
      { key: 'treasury', path: '/treasury', label: 'nav.treasury', icon: <WalletOutlined />, element: <TreasuryPage /> },
      { key: 'reports', path: '/reports', label: 'nav.reports', icon: <BarChartOutlined />, element: <ReportsPage /> },
      { key: 'fiscal', path: '/fiscal', label: 'nav.fiscal', icon: <CalendarOutlined />, element: <FiscalPage /> },
    ],
  },
  {
    label: 'nav.groupSales',
    tone: 'trade',
    routes: [
      { key: 'sales', path: '/sales', label: 'nav.sales', icon: <ShoppingCartOutlined />, element: <SalesPage /> },
      { key: 'purchases', path: '/purchases', label: 'nav.purchases', icon: <ShoppingOutlined />, element: <PurchasesPage /> },
      { key: 'goodsNotes', path: '/goods-notes', label: 'nav.goodsNotes', icon: <FileDoneOutlined />, element: <GoodsNotesPage /> },
      { key: 'parties', path: '/parties', label: 'nav.parties', icon: <SolutionOutlined />, element: <PartiesPage /> },
    ],
  },
  {
    label: 'nav.groupInventory',
    tone: 'inventory',
    routes: [
      { key: 'items', path: '/items', label: 'nav.items', icon: <InboxOutlined />, element: <ItemsPage /> },
      { key: 'warehouses', path: '/warehouses', label: 'nav.warehouses', icon: <ContainerOutlined />, element: <WarehousesPage /> },
      { key: 'stock', path: '/stock', label: 'nav.stock', icon: <AuditOutlined />, element: <StockPage /> },
    ],
  },
  {
    label: 'nav.groupAdmin',
    tone: 'admin',
    routes: [
      { key: 'users', path: '/users', label: 'nav.users', icon: <TeamOutlined />, element: <UsersPage /> },
      { key: 'branches', path: '/branches', label: 'nav.branches', icon: <ShopOutlined />, element: <BranchesPage /> },
      { key: 'settings', path: '/settings', label: 'nav.settings', icon: <SettingOutlined />, element: <SettingsPage /> },
      { key: 'health', path: '/health', label: 'nav.health', icon: <DashboardOutlined />, element: <HealthPage /> },
    ],
  },
];

export const ALL_ROUTES: AppRoute[] = APP_GROUPS.flatMap((g) => g.routes);

/** The module a URL belongs to (also matches nested paths like /sales/…); undefined on home. */
export function routeForPath(pathname: string): AppRoute | undefined {
  return ALL_ROUTES.find((r) => pathname === r.path || pathname.startsWith(`${r.path}/`));
}
