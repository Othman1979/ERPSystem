import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Layout, Menu, Select, Spin, Typography } from 'antd';
import {
  AccountBookOutlined,
  BankOutlined,
  CalendarOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  InboxOutlined,
  LogoutOutlined,
  ProfileOutlined,
  SettingOutlined,
  ShopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useAuth } from './auth/AuthContext';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { UsersPage } from './pages/UsersPage';
import { BranchesPage } from './pages/BranchesPage';
import { AccountsPage } from './pages/AccountsPage';
import { FiscalPage } from './pages/FiscalPage';
import { SettingsPage } from './pages/SettingsPage';
import { JournalPage } from './pages/JournalPage';
import { ItemsPage } from './pages/ItemsPage';
import { WarehousesPage } from './pages/WarehousesPage';
import { StockPage } from './pages/StockPage';
import { ReportsPage } from './pages/ReportsPage';
import { HealthPage } from './pages/HealthPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';

const { Header, Content, Sider } = Layout;

type View =
  | 'dashboard'
  | 'users'
  | 'branches'
  | 'accounts'
  | 'journal'
  | 'items'
  | 'warehouses'
  | 'stock'
  | 'reports'
  | 'fiscal'
  | 'settings'
  | 'health';

export function App() {
  const { t } = useTranslation();
  const { status, me, logout, switchTenant } = useAuth();
  const [view, setView] = useState<View>('dashboard');
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

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

  const menuItems = [
    { key: 'dashboard', icon: <DashboardOutlined />, label: t('nav.dashboard') },
    { key: 'users', icon: <TeamOutlined />, label: t('nav.users') },
    { key: 'branches', icon: <ShopOutlined />, label: t('nav.branches') },
    { key: 'accounts', icon: <AccountBookOutlined />, label: t('nav.accounts') },
    { key: 'journal', icon: <BankOutlined />, label: t('nav.journal') },
    { key: 'items', icon: <InboxOutlined />, label: t('nav.items') },
    { key: 'warehouses', icon: <DatabaseOutlined />, label: t('nav.warehouses') },
    { key: 'stock', icon: <DatabaseOutlined />, label: t('nav.stock') },
    { key: 'reports', icon: <ProfileOutlined />, label: t('nav.reports') },
    { key: 'fiscal', icon: <CalendarOutlined />, label: t('nav.fiscal') },
    { key: 'settings', icon: <SettingOutlined />, label: t('nav.settings') },
    { key: 'health', icon: <DashboardOutlined />, label: t('nav.health') },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider breakpoint="lg" collapsedWidth="0">
        <div style={{ color: '#fff', padding: 16, fontWeight: 700 }}>
          {t('app.title')}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[view]}
          items={menuItems}
          onClick={(e) => setView(e.key as View)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
            background: '#fff',
            paddingInline: 24,
          }}
        >
          <Typography.Text strong>{me?.currentTenant?.name ?? ''}</Typography.Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {me && me.tenants.length > 1 && (
              <Select
                size="small"
                style={{ minWidth: 180 }}
                value={me.currentTenant?.tenantId}
                onChange={(v) => void switchTenant(v)}
                options={me.tenants.map((tn) => ({
                  value: tn.tenantId,
                  label: tn.tenantName,
                }))}
              />
            )}
            <Typography.Text>{me?.user.email}</Typography.Text>
            <Button
              size="small"
              onClick={() => {
                void i18n.changeLanguage(SUPPORTED_LANGUAGES.includes(next) ? next : 'ar');
              }}
            >
              {t('language.switchTo')}
            </Button>
            <Button size="small" icon={<LogoutOutlined />} onClick={() => void logout()}>
              {t('auth.logout')}
            </Button>
          </div>
        </Header>
        <Content style={{ padding: 24 }}>
          {view === 'dashboard' && (
            <Card title={t('dashboard.title')}>
              <p>
                {t('dashboard.welcome', { name: me?.user.fullName ?? '' })}
              </p>
              <p>
                {t('dashboard.plan')}:{' '}
                {me?.currentTenant?.plan
                  ? me.currentTenant.plan.nameAr
                  : t('dashboard.noPlan')}
              </p>
              <p>
                {t('dashboard.status')}: {me?.currentTenant?.status}
              </p>
              <p>
                {t('dashboard.role')}: {me?.currentMembership?.roleCode}
              </p>
            </Card>
          )}
          {view === 'users' && <UsersPage />}
          {view === 'branches' && <BranchesPage />}
          {view === 'accounts' && <AccountsPage />}
          {view === 'journal' && <JournalPage />}
          {view === 'items' && <ItemsPage />}
          {view === 'warehouses' && <WarehousesPage />}
          {view === 'stock' && <StockPage />}
          {view === 'reports' && <ReportsPage />}
          {view === 'fiscal' && <FiscalPage />}
          {view === 'settings' && <SettingsPage />}
          {view === 'health' && <HealthPage />}
        </Content>
      </Layout>
    </Layout>
  );
}
