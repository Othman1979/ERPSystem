import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import {
  CloudServerOutlined,
  ExportOutlined,
  HomeOutlined,
  QuestionCircleOutlined,
  ImportOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuOutlined,
  ProfileOutlined,
  ShoppingCartOutlined,
  ShoppingOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  Alert,
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
import { useCompany } from './components/CompanyProfileForm';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { ServerUnreachable } from './components/ServerUnreachable';
import { lazyPage } from './lazyPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';
import { displayName } from './i18n/displayName';
import { ALL_ROUTES, APP_GROUPS, routeForPath, type AppGroup, type AppRoute } from './routes';
import { reportError } from './errorReporting';
import { palette, TOPBAR_HEIGHT } from './theme';

// The sign-in screen and the home screen ship with the app; the rest load when opened (WEB-10).
const PlatformAdminPage = lazyPage(() => import('./pages/PlatformAdminPage').then((m) => m.PlatformAdminPage));
const SetupWizardPage = lazyPage(() => import('./pages/SetupWizardPage').then((m) => m.SetupWizardPage));
const HelpPage = lazyPage(() => import('./pages/HelpPage').then((m) => m.HelpPage));
const LegalPage = lazyPage(() => import('./pages/LegalPage').then((m) => m.LegalPage));
const RegisterPage = lazyPage(() => import('./pages/RegisterPage').then((m) => m.RegisterPage));
const ChangePasswordRequiredPage = lazyPage(() =>
  import('./pages/ChangePasswordRequiredPage').then((m) => m.ChangePasswordRequiredPage),
);

/** Shown while a page's chunk loads. */
function PageSpinner({ full }: { full?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', marginTop: full ? '20vh' : 64 }}>
      <Spin size="large" />
    </div>
  );
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ViewErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  // A view that crashed is an error worth knowing about (ADR-010 §10.3).
  componentDidCatch(error: Error): void {
    reportError(error);
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

/** Platform owner console (outside the tenant modules of routes.tsx). */
const PLATFORM_PATH = '/platform';

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
  const company = useCompany();
  return (
    <>
      {company.data && !company.data.onboardingCompletedAt && (
        // Until the setup wizard is finished (§13.4).
        <Alert
          type="info"
          showIcon
          message={t('setup.bannerTitle')}
          description={t('setup.bannerText')}
          action={
            <Button type="primary" onClick={() => navigate('/setup')}>
              {t('setup.open')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}
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
  const [passwordOpen, setPasswordOpen] = useState(false);

  const language = i18n.language as AppLanguage;
  const nextLanguage = language === 'ar' ? 'en' : 'ar';
  const isRtl = language !== 'en';
  const current = routeForPath(location.pathname);

  useEffect(() => {
    document.title = current ? `${t(current.label)} — ${t('app.title')}` : t('app.title');
  }, [current, t, language]);

  // The platform owner's console (§13.3) — only for User.isPlatformAdmin.
  const isPlatformAdmin = !!me?.user.isPlatformAdmin;
  const menuItems: MenuProps['items'] = useMemo(
    () => [
      { key: '/', icon: <HomeOutlined />, label: t('nav.home') },
      ...APP_GROUPS.map((g) => ({
        type: 'group' as const,
        key: g.label,
        label: collapsed && !isMobile ? null : t(g.label),
        children: g.routes.map((r) => ({ key: r.path, icon: r.icon, label: t(r.label) })),
      })),
      ...(isPlatformAdmin
        ? [{ key: PLATFORM_PATH, icon: <CloudServerOutlined />, label: t('platform.nav') }]
        : []),
    ],
    // Labels depend on the language; t identity changes with it.
    [t, collapsed, isMobile, isPlatformAdmin],
  );

  const menu = (
    <Menu
      mode="inline"
      selectedKeys={[current?.path ?? (location.pathname.startsWith(PLATFORM_PATH) ? PLATFORM_PATH : '/')]}
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
          <Tooltip title={t('help.title')}>
            <Button
              size="small"
              type="text"
              className="topbar-btn"
              icon={<QuestionCircleOutlined />}
              aria-label={t('help.title')}
              onClick={() => navigate('/help')}
            />
          </Tooltip>
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
          <Tooltip title={t('auth.changePassword')}>
            <Button
              size="small"
              type="text"
              className="topbar-btn"
              icon={<KeyOutlined />}
              aria-label={t('auth.changePassword')}
              onClick={() => setPasswordOpen(true)}
            />
          </Tooltip>
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
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              <Route path="/" element={<HomeScreen />} />
              {ALL_ROUTES.map((r) => (
                <Route
                  key={r.key}
                  path={`${r.path}/*`}
                  element={<ViewErrorBoundary key={r.key}>{r.element}</ViewErrorBoundary>}
                />
              ))}
              <Route
                path="/help"
                element={
                  <ViewErrorBoundary key="help">
                    <HelpPage />
                  </ViewErrorBoundary>
                }
              />
              <Route
                path="/privacy"
                element={
                  <ViewErrorBoundary key="privacy">
                    <LegalPage kind="privacy" />
                  </ViewErrorBoundary>
                }
              />
              <Route
                path="/terms"
                element={
                  <ViewErrorBoundary key="terms">
                    <LegalPage kind="terms" />
                  </ViewErrorBoundary>
                }
              />
              <Route
                path="/setup"
                element={
                  <ViewErrorBoundary key="setup">
                    <SetupWizardPage />
                  </ViewErrorBoundary>
                }
              />
              {isPlatformAdmin && (
                <Route
                  path={`${PLATFORM_PATH}/*`}
                  element={
                    <ViewErrorBoundary key="platform">
                      <PlatformAdminPage />
                    </ViewErrorBoundary>
                  }
                />
              )}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
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

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </Layout>
  );
}

function AppGate() {
  const { status, me, refreshMe } = useAuth();
  const location = useLocation();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // The privacy policy and terms are public: registration links to them.
  if (status === 'guest' && (location.pathname === '/privacy' || location.pathname === '/terms')) {
    return <LegalPage kind={location.pathname === '/privacy' ? 'privacy' : 'terms'} standalone />;
  }

  if (status === 'loading') return <PageSpinner full />;

  // The server did not answer: not the sign-in screen, the session is probably fine (WEB-04).
  if (status === 'unreachable') return <ServerUnreachable onRetry={refreshMe} />;

  // Guests see the sign-in screen on any URL and land back on it after signing in.
  if (status === 'guest') {
    return authMode === 'login' ? (
      <LoginPage onSwitchToRegister={() => setAuthMode('register')} />
    ) : (
      <RegisterPage onSwitchToLogin={() => setAuthMode('login')} />
    );
  }

  // A temporary password must be replaced before anything else is reachable.
  if (me?.user.mustChangePassword) return <ChangePasswordRequiredPage />;

  return <AppShell />;
}

export function App() {
  return (
    <ViewErrorBoundary>
      <Suspense fallback={<PageSpinner full />}>
        <AppGate />
      </Suspense>
    </ViewErrorBoundary>
  );
}
