import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import {
  ExportOutlined,
  HomeOutlined,
  ImportOutlined,
  LogoutOutlined,
  MenuOutlined,
  ProfileOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  Avatar,
  Breadcrumb,
  Button,
  Card,
  Drawer,
  Grid,
  Layout,
  Menu,
  Select,
  Space,
  Spin,
  Tooltip,
  Typography,
  type MenuProps,
} from 'antd';
import { useAuth } from './auth/AuthContext';
import { HomeDashboard } from './pages/HomeDashboard';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';
import { displayName } from './i18n/displayName';
import { ALL_ROUTES, APP_GROUPS, routeForPath, type AppGroup, type AppRoute } from './routes';
import { palette, TOPBAR_HEIGHT } from './theme';

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
      // Class components can't use hooks, so read translations from the i18n instance.
      return (
        <Card style={{ maxWidth: 560, margin: '40px auto' }}>
          <Typography.Title level={4} type="danger">
            {i18n.t('common.viewCrashed')}
          </Typography.Title>
          <Typography.Paragraph>
            <Typography.Text code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
              {this.state.error.message}
            </Typography.Text>
          </Typography.Paragraph>
          <Button type="primary" onClick={() => window.location.reload()}>
            {i18n.t('common.reload')}
          </Button>
        </Card>
      );
    }
    return this.props.children;
  }
}

const SIDER_STORAGE_KEY = 'erp.siderCollapsed';

function readSiderCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDER_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSiderCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDER_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Not critical: the menu just opens expanded next time.
  }
}

/** Home-screen module group: a titled panel listing its screens as links. */
function HomeGroup({ group, onOpen }: { group: AppGroup; onOpen: (route: AppRoute) => void }) {
  const { t } = useTranslation();
  return (
    <section className="home-group">
      <div className="home-group-head">
        <span className="home-group-dot" style={{ background: palette.tone[group.tone] }} />
        {t(group.label)}
      </div>
      {group.routes.map((r) => (
        <button key={r.key} type="button" className="home-link" onClick={() => onOpen(r)}>
          <span className="home-link-icon" style={{ color: palette.tone[group.tone] }}>
            {r.icon}
          </span>
          {t(r.label)}
        </button>
      ))}
    </section>
  );
}

/** Everyday documents, opened straight into a new form (pages read `?new=1`). */
const QUICK_ACTIONS = [
  { key: 'sale', label: 'sales.newInvoice', path: '/sales?new=1', icon: <ShoppingCartOutlined /> },
  { key: 'purchase', label: 'purchases.newInvoice', path: '/purchases?new=1', icon: <ShoppingOutlined /> },
  { key: 'receipt', label: 'treasury.newReceipt', path: '/treasury?tab=receipts&new=1', icon: <ImportOutlined /> },
  { key: 'payment', label: 'treasury.newPayment', path: '/treasury?tab=payments&new=1', icon: <ExportOutlined /> },
  { key: 'journal', label: 'journal.newEntry', path: '/journal?new=1', icon: <ProfileOutlined /> },
] as const;

function HomeScreen() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <div className="home-head">
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {me?.currentTenant?.name ?? t('app.title')}
          </Typography.Title>
          <Typography.Text type="secondary">
            {displayName(me?.currentTenant?.plan) ?? t('dashboard.noPlan')} —{' '}
            {dayjs().format('dddd D MMMM YYYY')}
          </Typography.Text>
        </div>
      </div>
      <HomeDashboard />
      <div className="home-quick">
        <span className="home-quick-title">{t('dashboard.quickActions')}</span>
        {QUICK_ACTIONS.map((a) => (
          <Button key={a.key} icon={a.icon} onClick={() => navigate(a.path)}>
            {t(a.label)}
          </Button>
        ))}
      </div>
      <div className="home-groups">
        {APP_GROUPS.map((g) => (
          <HomeGroup key={g.label} group={g} onOpen={(r) => navigate(r.path)} />
        ))}
      </div>
    </>
  );
}

function AppShell() {
  const { t } = useTranslation();
  const { me, logout, switchTenant, branchId, setBranch } = useAuth();
  const branches = me?.currentMembership?.branches ?? [];
  const location = useLocation();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  // Breakpoints are empty on the first render; assume desktop until measured.
  const isMobile = screens.md === false;
  const [collapsed, setCollapsed] = useState(readSiderCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const language = i18n.language as AppLanguage;
  const nextLanguage = language === 'ar' ? 'en' : 'ar';
  const isRtl = language !== 'en';
  const current = routeForPath(location.pathname);

  useEffect(() => {
    document.title = current ? `${t(current.label)} — ${t('app.title')}` : t('app.title');
  }, [current, t, language]);

  const menuItems: MenuProps['items'] = useMemo(
    () => [
      { key: '/', icon: <HomeOutlined />, label: t('nav.home') },
      ...APP_GROUPS.map((g) => ({
        type: 'group' as const,
        key: g.label,
        label: collapsed && !isMobile ? null : t(g.label),
        children: g.routes.map((r) => ({ key: r.path, icon: r.icon, label: t(r.label) })),
      })),
    ],
    // Labels depend on the language; t identity changes with it.
    [t, collapsed, isMobile],
  );

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[current?.path ?? '/']}
      items={menuItems}
      onClick={({ key }) => {
        navigate(key);
        setDrawerOpen(false);
      }}
      style={{ borderInlineEnd: 'none' }}
    />
  );

  const toggleMenu = () => {
    if (isMobile) {
      setDrawerOpen(true);
    } else {
      setCollapsed((c) => {
        writeSiderCollapsed(!c);
        return !c;
      });
    }
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <header className="app-topbar" style={{ height: TOPBAR_HEIGHT }}>
        <Tooltip title={t('nav.menu')}>
          <Button
            type="text"
            className="topbar-btn"
            icon={<MenuOutlined />}
            onClick={toggleMenu}
            aria-label={t('nav.menu')}
          />
        </Tooltip>
        <button type="button" className="topbar-brand" onClick={() => navigate('/')}>
          {t('app.title')}
        </button>
        {current && !isMobile && (
          <Breadcrumb
            className="topbar-breadcrumb"
            items={[{ title: me?.currentTenant?.name ?? '' }, { title: t(current.label) }]}
          />
        )}
        {current && isMobile && <span className="topbar-title">{t(current.label)}</span>}
        <div style={{ flex: 1 }} />
        <Space size={isMobile ? 4 : 12}>
          {branches.length > 1 && (
            <Select
              size="small"
              className="topbar-branch"
              style={{ minWidth: isMobile ? 110 : 150 }}
              value={branchId ?? undefined}
              onChange={setBranch}
              options={branches.map((b) => ({ value: b.id, label: displayName(b) }))}
              popupMatchSelectWidth={false}
              aria-label={t('nav.branch')}
              title={t('nav.branch')}
            />
          )}
          {me && me.tenants.length > 1 && !isMobile && (
            <Select
              size="small"
              style={{ minWidth: 160 }}
              value={me.currentTenant?.tenantId}
              onChange={(v) => void switchTenant(v)}
              options={me.tenants.map((tn) => ({ value: tn.tenantId, label: tn.tenantName }))}
              popupMatchSelectWidth={false}
            />
          )}
          <Space size={6}>
            <Avatar size="small" icon={<UserOutlined />} />
            {!isMobile && (
              <span className="topbar-user">{me?.user.fullName ?? me?.user.email}</span>
            )}
          </Space>
          <Button
            size="small"
            onClick={() => {
              void i18n.changeLanguage(
                SUPPORTED_LANGUAGES.includes(nextLanguage) ? nextLanguage : 'ar',
              );
            }}
          >
            {t('language.switchTo')}
          </Button>
          <Tooltip title={t('auth.logout')}>
            <Button
              size="small"
              type="text"
              className="topbar-btn"
              icon={<LogoutOutlined />}
              onClick={() => {
                // Next sign-in starts on the home screen, not this user's last page.
                navigate('/');
                void logout();
              }}
              aria-label={t('auth.logout')}
            />
          </Tooltip>
        </Space>
      </header>

      <Layout hasSider={!isMobile}>
        {!isMobile && (
          <Layout.Sider
            className="app-sider"
            width={224}
            collapsedWidth={56}
            collapsed={collapsed}
            trigger={null}
            theme="light"
            style={{ top: TOPBAR_HEIGHT, height: `calc(100vh - ${TOPBAR_HEIGHT}px)` }}
          >
            {menu}
          </Layout.Sider>
        )}
        <Layout.Content className="app-content" style={{ padding: isMobile ? 12 : 24 }}>
          <Routes>
            <Route path="/" element={<HomeScreen />} />
            {ALL_ROUTES.map((r) => (
              <Route
                key={r.key}
                path={`${r.path}/*`}
                element={<ViewErrorBoundary key={r.key}>{r.element}</ViewErrorBoundary>}
              />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>

      {isMobile && (
        <Drawer
          title={t('nav.apps')}
          placement={isRtl ? 'right' : 'left'}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={268}
          styles={{ body: { padding: 0 } }}
        >
          {menu}
        </Drawer>
      )}
    </Layout>
  );
}

export function App() {
  const { status } = useAuth();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  // Guests see the sign-in screen on any URL and land back on it after signing in.
  if (status === 'guest') {
    return authMode === 'login' ? (
      <LoginPage onSwitchToRegister={() => setAuthMode('register')} />
    ) : (
      <RegisterPage onSwitchToLogin={() => setAuthMode('login')} />
    );
  }

  return <AppShell />;
}
