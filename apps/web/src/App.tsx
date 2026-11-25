import { Component, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import {
  CloudServerOutlined,
  HomeOutlined,
  QuestionCircleOutlined,
  KeyOutlined,
  LogoutOutlined,
  MenuOutlined,
  TranslationOutlined,
  UserOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  Alert,
  Avatar,
  Badge,
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
import { useCompany } from './components/CompanyProfileForm';
import { CompanyBranding } from './components/CompanyBranding';
import { GlobalLoadingBar } from './components/GlobalLoadingBar';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { Ribbon } from './components/Ribbon';
import { useCostCenters } from './hooks/useCostCenters';
import { ServerUnreachable } from './components/ServerUnreachable';
import { NoAccess } from './components/NoAccess';
import { ProcurementLevelGate } from './components/ProcurementLevelGate';
import { useProcurementLevel } from './auth/procurementLevel';
import { lazyPage } from './lazyPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';
import { displayName } from './i18n/displayName';
import {
  ALL_ROUTES,
  allowedGroups,
  routeIsAvailable,
  APP_GROUPS,
  INVITATIONS_PATH,
  PLATFORM_PATH,
  routeForPath,
  SETUP_PATH,
  SETUP_PERMISSION,
} from './routes';
import { reportError } from './errorReporting';
import { installCssVariables, TOPBAR_HEIGHT } from './theme';

// The --c-* custom properties index.css uses, generated from the palette (UI-20).
installCssVariables();

/** Switches between Arabic and English (top bar, signed in or not). */
function toggleLanguage(): void {
  const next: AppLanguage = i18n.language === 'ar' ? 'en' : 'ar';
  void i18n.changeLanguage(SUPPORTED_LANGUAGES.includes(next) ? next : 'ar');
}

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
    <>
      <GlobalLoadingBar forceVisible />
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: full ? '20vh' : 64 }}>
        <Spin size="large" />
      </div>
    </>
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

function HomeScreen() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const canSetUp = can(SETUP_PERMISSION);
  const navigate = useNavigate();
  const company = useCompany();
  return (
    <>
      {company.data && !company.data.onboardingCompletedAt && (
        // Until the setup wizard is finished (§13.4). Roles that cannot run it are
        // told who can, instead of a button into a wizard that answers 403.
        <Alert
          type="info"
          showIcon
          message={canSetUp ? t('setup.bannerTitle') : t('setup.pendingTitle')}
          description={canSetUp ? t('setup.bannerText') : t('setup.askOwner')}
          action={
            canSetUp ? (
              <Button type="primary" onClick={() => navigate(SETUP_PATH)}>
                {t('setup.open')}
              </Button>
            ) : undefined
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
    </>
  );
}

function AppShell() {
  const { t } = useTranslation();
  const { me, logout, switchTenant, branchId, setBranch, companyId, setCompany, can, allBranches } = useAuth();
  const companies = me?.currentMembership?.companies ?? [];
  const branches = me?.currentMembership?.branches ?? [];
  const location = useLocation();
  const navigate = useNavigate();
  const screens = Grid.useBreakpoint();
  // Breakpoints are empty on the first render; assume desktop until measured.
  const isMobile = screens.md === false;
  // Tablets (768–991 px) get the ribbon's compact buttons (ADR-029 §1).
  const isTablet = screens.md === true && screens.lg === false;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // Signed in with invitations only (no company yet): the invitations page is the only tenant-free screen (ADR-012 §PLAT-10).
  const noCompany = !me?.currentTenant;
  const company = useCompany(!noCompany);
  const consignmentEnabled = company.data?.consignmentEnabled === true;
  const { enabled: costCentersEnabled } = useCostCenters();
  const pendingInvitations = me?.pendingInvitations ?? 0;
  // Cycle screens (phases 12–13) show from their procurement level up (ADR-024 §2.3).
  const procurementLevel = useProcurementLevel(!noCompany);

  const language = i18n.language as AppLanguage;
  const isRtl = language !== 'en';
  const current = routeForPath(location.pathname);

  useEffect(() => {
    document.title = current ? `${t(current.label)} — ${t('app.title')}` : t('app.title');
  }, [current, t, language]);

  // The platform owner's console (§13.3) — only for User.isPlatformAdmin.
  const isPlatformAdmin = !!me?.user.isPlatformAdmin;
  const menuItems: MenuProps['items'] = useMemo(
    () => {
      // A screen in two groups (parties: sales and purchases) is listed once: menu keys must be unique.
      const listed = new Set<string>();
      return [
      ...(noCompany ? [] : [{ key: '/', icon: <HomeOutlined />, label: t('nav.home') }]),
      // Screens the role cannot use are not offered (the API would answer 403).
      ...(noCompany
        ? APP_GROUPS.filter((g) => g.routes.some((r) => r.path === INVITATIONS_PATH))
        : allowedGroups(APP_GROUPS, can, procurementLevel, allBranches, consignmentEnabled)
      ).map((g) => ({
        type: 'group' as const,
        key: g.label,
        label: t(g.label),
        children: g.routes
          .filter((r) => (!noCompany || r.path === INVITATIONS_PATH) && !listed.has(r.path) && !!listed.add(r.path))
          .map((r) => ({
            key: r.path,
            icon: r.icon,
            label:
              r.badge === 'pendingInvitations' && pendingInvitations > 0 ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  {t(r.label)}
                  <Badge count={pendingInvitations} size="small" />
                </span>
              ) : (
                t(r.label)
              ),
          })),
      })),
      ...(isPlatformAdmin
        ? [{ key: PLATFORM_PATH, icon: <CloudServerOutlined />, label: t('platform.nav') }]
        : []),
      ];
    },
    // Labels depend on the language; t identity changes with it.
    [t, isPlatformAdmin, noCompany, pendingInvitations, can, procurementLevel, consignmentEnabled],
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

  // Phones open the menu drawer; on wider screens the ribbon is always there.
  const openMenu = () => setDrawerOpen(true);

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
        {isMobile && (
          <Tooltip title={t('nav.menu')}>
            <Button
              type="text"
              className="topbar-btn"
              icon={<MenuOutlined />}
              onClick={openMenu}
              aria-label={t('nav.menu')}
            />
          </Tooltip>
        )}
        {!isMobile && (
          <button type="button" className="topbar-brand" onClick={() => navigate('/')}>
            <CompanyBranding />
          </button>
        )}
        {current && !isMobile && !noCompany && (
          <Breadcrumb
            className="topbar-breadcrumb"
            items={[{ title: me?.currentTenant?.name ?? '' }, { title: t(current.label) }]}
          />
        )}
        {isMobile && <CompanyBranding mobile />}
        {isMobile && (
          <span className="topbar-title">{current ? t(current.label) : t('app.title')}</span>
        )}
        {!isMobile && <div style={{ flex: 1 }} />}
        <Space size={isMobile ? 4 : 12}>
          {companies.length > 1 && (
            <Select
              size="small"
              className="topbar-company"
              style={{ minWidth: isMobile ? 120 : 180 }}
              value={companyId ?? undefined}
              onChange={setCompany}
              options={companies.map((c) => ({
                value: c.id,
                label: (i18n.language === 'en' && c.legalNameEn) || c.legalNameAr,
              }))}
              popupMatchSelectWidth={false}
              aria-label={t('nav.company')}
              title={t('nav.company')}
            />
          )}
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

      {!isMobile && (
        <Ribbon
          can={can}
          procurementLevel={procurementLevel}
          allBranches={allBranches}
          consignmentEnabled={consignmentEnabled}
          costCentersEnabled={costCentersEnabled}
          noCompany={noCompany}
          isPlatformAdmin={isPlatformAdmin}
          pendingInvitations={pendingInvitations}
          compact={isTablet}
        />
      )}
      <GlobalLoadingBar />
      <Layout>
        <Layout.Content className="app-content" style={{ padding: isMobile ? 12 : 24 }}>
          <Suspense fallback={<PageSpinner />}>
            <Routes>
              {!noCompany && <Route path="/" element={<HomeScreen />} />}
              {ALL_ROUTES.filter((r) => !noCompany || r.path === INVITATIONS_PATH).map((r) => (
                <Route
                  key={r.key}
                  path={`${r.path}/*`}
                  element={
                    <ViewErrorBoundary key={r.key}>
                      {routeIsAvailable(r, can, consignmentEnabled) ? (
                        <ProcurementLevelGate min={r.minProcurementLevel}>{r.element}</ProcurementLevelGate>
                      ) : (
                        <NoAccess />
                      )}
                    </ViewErrorBoundary>
                  }
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
              {!noCompany && (
                <Route
                  path={SETUP_PATH}
                  element={
                    <ViewErrorBoundary key="setup">
                      {can(SETUP_PERMISSION) ? <SetupWizardPage /> : <NoAccess />}
                    </ViewErrorBoundary>
                  }
                />
              )}
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
              <Route path="*" element={<Navigate to={noCompany ? INVITATIONS_PATH : '/'} replace />} />
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

function AppGate() {
  const { status, me, refreshMe, logout } = useAuth();
  const location = useLocation();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // The privacy policy and terms are public: registration links to them.
  if (status === 'guest' && (location.pathname === '/privacy' || location.pathname === '/terms')) {
    return <LegalPage kind={location.pathname === '/privacy' ? 'privacy' : 'terms'} standalone />;
  }

  if (status === 'loading') return <PageSpinner full />;

  // The server did not answer: not the sign-in screen, the session is probably fine (WEB-04).
  // Signing out works offline too: the logout call may fail, the screen still returns to sign-in.
  if (status === 'unreachable') {
    return <ServerUnreachable onRetry={refreshMe} onSignOut={() => logout().catch(() => undefined)} />;
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

export function App() {
  return (
    <ViewErrorBoundary>
      <Suspense fallback={<PageSpinner full />}>
        <AppGate />
      </Suspense>
    </ViewErrorBoundary>
  );
}
