import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
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
  TranslationOutlined,
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
  Dropdown,
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
import { PlatformAdminPage } from './pages/PlatformAdminPage';
import { SetupWizardPage } from './pages/SetupWizardPage';
import { HelpPage } from './pages/HelpPage';
import { LegalPage } from './pages/LegalPage';
import { useCompany } from './components/CompanyProfileForm';
import { RegisterPage } from './pages/RegisterPage';
import { ChangePasswordRequiredPage } from './pages/ChangePasswordRequiredPage';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';
import { displayName } from './i18n/displayName';
import { ALL_ROUTES, APP_GROUPS, routeForPath, type AppGroup, type AppRoute } from './routes';
import { reportError } from './errorReporting';
import { installCssVariables, palette, TOPBAR_HEIGHT } from './theme';

// The --c-* custom properties index.css uses, generated from the palette (UI-20).
installCssVariables();

/** Switches between Arabic and English (top bar, signed in or not). */
function toggleLanguage(): void {
  const next: AppLanguage = i18n.language === 'ar' ? 'en' : 'ar';
  void i18n.changeLanguage(SUPPORTED_LANGUAGES.includes(next) ? next : 'ar');
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
  // Tablets (768–991 px) start with the menu folded to icons, so the page
  // keeps its width (UI-01); the toggle opens it for this visit only.
  const isTablet = screens.md === true && screens.lg === false;
  const [collapsed, setCollapsed] = useState(readSiderCollapsed);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  const siderCollapsed = isTablet ? !tabletExpanded : collapsed;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  const language = i18n.language as AppLanguage;
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
        label: siderCollapsed && !isMobile ? null : t(g.label),
        children: g.routes.map((r) => ({ key: r.path, icon: r.icon, label: t(r.label) })),
      })),
      ...(isPlatformAdmin
        ? [{ key: PLATFORM_PATH, icon: <CloudServerOutlined />, label: t('platform.nav') }]
        : []),
    ],
    // Labels depend on the language; t identity changes with it.
    [t, siderCollapsed, isMobile, isPlatformAdmin],
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
    } else if (isTablet) {
      setTabletExpanded((x) => !x);
    } else {
      setCollapsed((c) => {
        writeSiderCollapsed(!c);
        return !c;
      });
    }
  };

  const logOut = () => {
    // Next sign-in starts on the home screen, not this user's last page.
    navigate('/');
    void logout();
  };
  const userName = me?.user.fullName ?? me?.user.email;

  // Phones: help, language, password and sign-out move into the avatar's menu,
  // so the page title keeps the top bar's width (UI-10).
  const userMenu: MenuProps = {
    items: [
      // A heading, not a disabled item: readable (text-2) and not announced as unavailable.
      {
        type: 'group',
        key: 'user',
        label: <span className="topbar-menu-user">{userName}</span>,
        children: [],
      },
      { type: 'divider' },
      { key: 'help', icon: <QuestionCircleOutlined />, label: t('help.title') },
      { key: 'language', icon: <TranslationOutlined />, label: t('language.switchTo') },
      { key: 'password', icon: <KeyOutlined />, label: t('auth.changePassword') },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: t('auth.logout') },
    ],
    onClick: ({ key }) => {
      if (key === 'help') navigate('/help');
      else if (key === 'language') toggleLanguage();
      else if (key === 'password') setPasswordOpen(true);
      else if (key === 'logout') logOut();
    },
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
        {!isMobile && (
          <button type="button" className="topbar-brand" onClick={() => navigate('/')}>
            {t('app.title')}
          </button>
        )}
        {current && !isMobile && (
          <Breadcrumb
            className="topbar-breadcrumb"
            items={[{ title: me?.currentTenant?.name ?? '' }, { title: t(current.label) }]}
          />
        )}
        {isMobile && (
          <span className="topbar-title">{current ? t(current.label) : t('app.title')}</span>
        )}
        {!isMobile && <div style={{ flex: 1 }} />}
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
              aria-label={t('ui.switchCompany')}
              title={t('ui.switchCompany')}
            />
          )}
          {isMobile ? (
            <Dropdown
              menu={userMenu}
              trigger={['click']}
              placement="bottomRight"
              open={userMenuOpen}
              onOpenChange={setUserMenuOpen}
            >
              <button
                type="button"
                className="topbar-user-menu"
                aria-label={t('ui.userMenu')}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
              >
                <Avatar size="small" icon={<UserOutlined />} />
              </button>
            </Dropdown>
          ) : (
            <>
              <Space size={6}>
                <Avatar size="small" icon={<UserOutlined />} />
                <span className="topbar-user">{userName}</span>
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
              <Button size="small" className="topbar-lang" onClick={toggleLanguage}>
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
                  onClick={logOut}
                  aria-label={t('auth.logout')}
                />
              </Tooltip>
            </>
          )}
        </Space>
      </header>

      <Layout hasSider={!isMobile}>
        {!isMobile && (
          <Layout.Sider
            className="app-sider"
            width={224}
            collapsedWidth={56}
            collapsed={siderCollapsed}
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
            <Route path="/help" element={<HelpPage />} />
            <Route path="/privacy" element={<LegalPage kind="privacy" />} />
            <Route path="/terms" element={<LegalPage kind="terms" />} />
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
        </Layout.Content>
      </Layout>

      {isMobile && (
        <Drawer
          title={t('nav.apps')}
          placement={isRtl ? 'right' : 'left'}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          width={268}
          rootClassName="app-drawer-menu"
          styles={{ body: { padding: 0 } }}
        >
          {menu}
        </Drawer>
      )}

      <ChangePasswordDialog open={passwordOpen} onClose={() => setPasswordOpen(false)} />
    </Layout>
  );
}

/** Brand and language switch above the sign-in and registration screens (UI-15). */
function GuestTopbar() {
  const { t } = useTranslation();
  return (
    <header className="guest-topbar app-topbar">
      <span className="topbar-brand">{t('app.title')}</span>
      <Button size="small" className="topbar-lang" onClick={toggleLanguage}>
        {t('language.switchTo')}
      </Button>
    </header>
  );
}

export function App() {
  const { status, me } = useAuth();
  const location = useLocation();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // The privacy policy and terms are public: registration links to them.
  if (status === 'guest' && (location.pathname === '/privacy' || location.pathname === '/terms')) {
    return <LegalPage kind={location.pathname === '/privacy' ? 'privacy' : 'terms'} standalone />;
  }

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '20vh' }}>
        <Spin size="large" />
      </div>
    );
  }

  // Guests see the sign-in screen on any URL and land back on it after signing in.
  if (status === 'guest') {
    return (
      <>
        <GuestTopbar />
        {authMode === 'login' ? (
          <LoginPage onSwitchToRegister={() => setAuthMode('register')} />
        ) : (
          <RegisterPage onSwitchToLogin={() => setAuthMode('login')} />
        )}
      </>
    );
  }

  // A temporary password must be replaced before anything else is reachable.
  if (me?.user.mustChangePassword) return <ChangePasswordRequiredPage />;

  return <AppShell />;
}
