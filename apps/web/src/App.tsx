import { Component, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppstoreOutlined,
  BankOutlined,
  CalendarOutlined,
  CarOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileDoneOutlined,
  InboxOutlined,
  LogoutOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShopOutlined,
  ShoppingCartOutlined,
  TeamOutlined,
  UserOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { Avatar, Button, Card, Col, Drawer, Grid, Row, Select, Space, Spin, Typography } from 'antd';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { UsersPage } from './pages/UsersPage';
import { BranchesPage } from './pages/BranchesPage';
import { AccountsPage } from './pages/AccountsPage';
import { FiscalPage } from './pages/FiscalPage';
import { SettingsPage } from './pages/SettingsPage';
import { JournalPage } from './pages/JournalPage';
import { ReportsPage } from './pages/ReportsPage';
import { ItemsPage } from './pages/ItemsPage';
import { WarehousesPage } from './pages/WarehousesPage';
import { StockPage } from './pages/StockPage';
import { PartiesPage } from './pages/PartiesPage';
import { SalesPage } from './pages/SalesPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { GoodsNotesPage } from './pages/GoodsNotesPage';
import { TreasuryPage } from './pages/TreasuryPage';
import { HealthPage } from './pages/HealthPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';

type View =
  | 'home'
  | 'users'
  | 'branches'
  | 'accounts'
  | 'journal'
  | 'items'
  | 'warehouses'
  | 'stock'
  | 'sales'
  | 'purchases'
  | 'goodsNotes'
  | 'parties'
  | 'treasury'
  | 'reports'
  | 'fiscal'
  | 'settings'
  | 'health';

interface AppTile {
  key: View;
  icon: ReactNode;
  color: string;
}

interface AppGroup {
  label: string;
  tiles: AppTile[];
}

const APP_GROUPS: AppGroup[] = [
  {
    label: 'nav.groupFinance',
    tiles: [
      { key: 'accounts', icon: <BankOutlined />, color: '#106ebe' },
      { key: 'journal', icon: <ProfileOutlined />, color: '#106ebe' },
      { key: 'treasury', icon: <WalletOutlined />, color: '#106ebe' },
      { key: 'reports', icon: <DashboardOutlined />, color: '#106ebe' },
      { key: 'fiscal', icon: <CalendarOutlined />, color: '#106ebe' },
    ],
  },
  {
    label: 'nav.groupSales',
    tiles: [
      { key: 'sales', icon: <ShoppingCartOutlined />, color: '#0078d4' },
      { key: 'purchases', icon: <CarOutlined />, color: '#0078d4' },
      { key: 'goodsNotes', icon: <FileDoneOutlined />, color: '#0078d4' },
      { key: 'parties', icon: <TeamOutlined />, color: '#0078d4' },
    ],
  },
  {
    label: 'nav.groupInventory',
    tiles: [
      { key: 'items', icon: <InboxOutlined />, color: '#0078d4' },
      { key: 'warehouses', icon: <DatabaseOutlined />, color: '#0078d4' },
      { key: 'stock', icon: <DatabaseOutlined />, color: '#0078d4' },
    ],
  },
  {
    label: 'nav.groupAdmin',
    tiles: [
      { key: 'users', icon: <TeamOutlined />, color: '#5b6b7a' },
      { key: 'branches', icon: <ShopOutlined />, color: '#5b6b7a' },
      { key: 'settings', icon: <SettingOutlined />, color: '#5b6b7a' },
      { key: 'health', icon: <DashboardOutlined />, color: '#5b6b7a' },
    ],
  },
];

const VIEWS: Record<View, ReactNode> = {
  home: null,
  users: <UsersPage />,
  branches: <BranchesPage />,
  accounts: <AccountsPage />,
  journal: <JournalPage />,
  items: <ItemsPage />,
  warehouses: <WarehousesPage />,
  stock: <StockPage />,
  sales: <SalesPage />,
  purchases: <PurchasesPage />,
  goodsNotes: <GoodsNotesPage />,
  parties: <PartiesPage />,
  treasury: <TreasuryPage />,
  reports: <ReportsPage />,
  fiscal: <FiscalPage />,
  settings: <SettingsPage />,
  health: <HealthPage />,
};

interface ErrorBoundaryState {
  error: Error | null;
}

class ViewErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Card style={{ maxWidth: 560, margin: '40px auto' }}>
          <Typography.Title level={4} type="danger">
            Something went wrong
          </Typography.Title>
          <Typography.Paragraph>
            <Typography.Text code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
              {this.state.error.message}
            </Typography.Text>
          </Typography.Paragraph>
          <Button type="primary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </Card>
      );
    }
    return this.props.children;
  }
}

const NAV_LABEL: Record<View, string> = {
  home: 'nav.home',
  users: 'nav.users',
  branches: 'nav.branches',
  accounts: 'nav.accounts',
  journal: 'nav.journal',
  items: 'nav.items',
  warehouses: 'nav.warehouses',
  stock: 'nav.stock',
  sales: 'nav.sales',
  purchases: 'nav.purchases',
  goodsNotes: 'nav.goodsNotes',
  parties: 'nav.parties',
  treasury: 'nav.treasury',
  reports: 'nav.reports',
  fiscal: 'nav.fiscal',
  settings: 'nav.settings',
  health: 'nav.health',
};

function AppTileCard({
  tile,
  label,
  onOpen,
}: {
  tile: AppTile;
  label: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card
      hoverable
      onClick={onOpen}
      styles={{ body: { padding: '18px 12px', textAlign: 'center' } }}
      style={{ borderRadius: 8 }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          margin: '0 auto 10px',
          borderRadius: 10,
          background: tile.color,
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 24,
        }}
      >
        {tile.icon}
      </div>
      <Typography.Text strong>{t(label)}</Typography.Text>
    </Card>
  );
}

export function App() {
  const { t } = useTranslation();
  const { status, me, logout, switchTenant } = useAuth();
  const [view, setView] = useState<View>('home');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [appsOpen, setAppsOpen] = useState(false);
  const screens = Grid.useBreakpoint();

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  if (status === 'guest') {
    return authMode === 'login' ? (
      <LoginPage onSwitchToRegister={() => setAuthMode('register')} />
    ) : (
      <RegisterPage onSwitchToLogin={() => setAuthMode('login')} />
    );
  }

  const current = i18n.language as AppLanguage;
  const next = current === 'ar' ? 'en' : 'ar';
  const openApp = (v: View) => {
    setView(v);
    setAppsOpen(false);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#f3f3f3' }}>
      {/* Odoo-style top bar */}
      <div
        className="app-topbar"
        style={{
          height: 40,
          background: '#0078d4',
          color: '#fff',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 16px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        <Button
          type="text"
          icon={<AppstoreOutlined style={{ color: '#fff', fontSize: 18 }} />}
          onClick={() => setAppsOpen(true)}
          aria-label={t('nav.apps')}
        />
        <Typography.Text strong style={{ color: '#fff', fontSize: 15 }}>
          {view === 'home' ? t('app.title') : t(NAV_LABEL[view])}
        </Typography.Text>
        {view !== 'home' && (
          <Typography.Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }}>
            / {me?.currentTenant?.name ?? ''}
          </Typography.Text>
        )}
        <div style={{ flex: 1 }} />
        <Space size={12}>
          {me && me.tenants.length > 1 && (
            <Select
              size="small"
              style={{ minWidth: 160 }}
              value={me.currentTenant?.tenantId}
              onChange={(v) => void switchTenant(v)}
              options={me.tenants.map((tn) => ({
                value: tn.tenantId,
                label: tn.tenantName,
              }))}
              popupMatchSelectWidth={false}
            />
          )}
          <Space size={6}>
            <Avatar size="small" icon={<UserOutlined />} />
            <Typography.Text style={{ color: '#fff' }}>
              {me?.user.fullName ?? me?.user.email}
            </Typography.Text>
          </Space>
          <Button
            size="small"
            onClick={() => {
              void i18n.changeLanguage(SUPPORTED_LANGUAGES.includes(next) ? next : 'ar');
            }}
          >
            {t('language.switchTo')}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<LogoutOutlined style={{ color: '#fff' }} />}
            onClick={() => void logout()}
            aria-label={t('auth.logout')}
          />
        </Space>
      </div>

      {/* Content canvas */}
      <div className="app-content" style={{ padding: screens.md ? 24 : 12 }}>
        {view === 'home' ? (
          <>
            <div style={{ marginBottom: 20 }}>
              <Typography.Title level={3} style={{ margin: 0 }}>
                {t('app.title')}
              </Typography.Title>
              <Typography.Text type="secondary">
                {me?.currentTenant?.name} —{' '}
                {me?.currentTenant?.plan
                  ? me.currentTenant.plan.nameAr
                  : t('dashboard.noPlan')}
              </Typography.Text>
            </div>
            {APP_GROUPS.map((g) => (
              <div key={g.label} style={{ marginBottom: 24 }}>
                <Typography.Title level={5} style={{ marginBottom: 12 }}>
                  {t(g.label)}
                </Typography.Title>
                <Row gutter={[16, 16]}>
                  {g.tiles.map((tile) => (
                    <Col key={tile.key} xs={12} sm={8} md={6} lg={4}>
                      <AppTileCard
                        tile={tile}
                        label={NAV_LABEL[tile.key]}
                        onOpen={() => openApp(tile.key)}
                      />
                    </Col>
                  ))}
                </Row>
              </div>
            ))}
          </>
        ) : (
          <ViewErrorBoundary key={view}>{VIEWS[view]}</ViewErrorBoundary>
        )}
      </div>

      {/* Odoo app drawer */}
      <Drawer
        title={t('nav.apps')}
        placement="left"
        open={appsOpen}
        onClose={() => setAppsOpen(false)}
        width={420}
      >
        {APP_GROUPS.map((g) => (
          <div key={g.label} style={{ marginBottom: 20 }}>
            <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 10 }}>
              {t(g.label)}
            </Typography.Text>
            <Row gutter={[12, 12]}>
              {g.tiles.map((tile) => (
                <Col key={tile.key} span={8}>
                  <AppTileCard
                    tile={tile}
                    label={NAV_LABEL[tile.key]}
                    onOpen={() => openApp(tile.key)}
                  />
                </Col>
              ))}
            </Row>
          </div>
        ))}
      </Drawer>
    </div>
  );
}
