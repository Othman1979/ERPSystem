import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { useAuth as UseAuth } from './auth/AuthContext';
import i18n from './i18n';
import { App } from './App';

type AuthState = ReturnType<typeof UseAuth>;

// The signed-in session each test renders; read by the mocked useAuth.
const session = vi.hoisted(() => ({ state: null as unknown }));
vi.mock('./auth/AuthContext', () => ({ useAuth: () => session.state }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Permission codes as GET /me lists them (apps/api/src/common/permissions/permissions.ts). */
const ACCOUNTANT = [
  'tenant.read', 'branch.manage', 'company.manage', 'settings.manage', 'account.manage', 'journal.manage',
  'journal.post', 'fiscal.manage', 'fiscal.close', 'parties.manage', 'sales.manage', 'sales.post',
  'sales.return', 'purchase.manage', 'purchase.post', 'purchase.return', 'treasury.manage',
  'einvoice.manage', 'reports.view', 'audit.view', 'import_export.manage', 'onboarding.manage',
];
const OWNER = [...ACCOUNTANT, 'user.manage', 'item.manage', 'warehouse.manage', 'stock.movement'];
const VIEWER = ['tenant.read', 'reports.view'];

function signedIn(roleCode: string, permissions: string[]): AuthState {
  return {
    status: 'authed',
    me: {
      user: { id: 'u1', email: 'rana@a.test', fullName: 'Rana Haddad', locale: 'ar', isPlatformAdmin: false },
      tenants: [
        {
          tenantId: 't1',
          tenantName: 'A Co',
          status: 'ACTIVE',
          roleCode,
          roleNameAr: roleCode === 'OWNER' ? 'مالك' : 'محاسب',
          roleNameEn: roleCode === 'OWNER' ? 'Owner' : 'Accountant',
          isCurrent: true,
        },
      ],
      currentTenant: { tenantId: 't1', name: 'A Co', status: 'ACTIVE', plan: null },
      currentMembership: { membershipId: 'm1', roleCode, permissions, defaultBranchId: null, branches: [] },
      pendingInvitations: 0,
    },
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(async () => undefined),
    switchTenant: vi.fn(),
    branchId: null,
    setBranch: vi.fn(),
    refreshMe: vi.fn(),
    can: (permission) => permissions.includes(permission),
  };
}

/** Viewport `width` px wide, as antd's Grid.useBreakpoint reads it through matchMedia. */
function setViewport(width: number): void {
  window.matchMedia = ((query: string) => {
    const min = /min-width:\s*(\d+)/.exec(query);
    const max = /max-width:\s*(\d+)/.exec(query);
    const matches = (!min || width >= Number(min[1])) && (!max || width <= Number(max[1]));
    return {
      matches,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    };
  }) as typeof window.matchMedia;
}

/** Every API call the screens made; none is answered, each fails only when aborted. */
const requested: string[] = [];
const signals = new Map<string, AbortSignal | null | undefined>();
function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      requested.push(url);
      signals.set(url, init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }),
  );
}

let pathname = '';
function LocationProbe() {
  pathname = useLocation().pathname;
  return null;
}

let root: Root;
let container: HTMLDivElement;

async function mount(path: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[path]}>
            <App />
            <LocationProbe />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
}

/** Lets lazy pages load and effects settle until `check` passes. */
async function until(check: () => void): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (err) {
      if (i > 100) throw err;
      await act(async () => new Promise((r) => setTimeout(r, 20)));
    }
  }
}

const text = () => document.body.textContent ?? '';
const sideMenu = () => [...container.querySelectorAll('.app-sider .ant-menu-item')].map((li) => li.textContent);
const homeLinks = () => [...container.querySelectorAll('.home-link')].map((b) => b.textContent);
const quickActions = () => [...container.querySelectorAll('.home-quick button')].map((b) => b.textContent);
const usersListRequested = () => requested.some((u) => /\/api\/v1\/users(\?|$)/.test(u));

beforeEach(async () => {
  await i18n.changeLanguage('en');
  requested.length = 0;
  signals.clear();
  stubFetch();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('screens follow the role permissions from GET /me', () => {
  beforeEach(() => setViewport(1280));

  it('offers Users to the owner and opens the page', async () => {
    session.state = signedIn('OWNER', OWNER);
    await mount('/users');
    expect(sideMenu()).toContain(i18n.t('nav.users'));
    await until(() => expect(usersListRequested()).toBe(true));
    expect(text()).not.toContain(i18n.t('access.title'));
  });

  it('hides Users from the accountant, in the menu and on the home screen', async () => {
    session.state = signedIn('ACCOUNTANT', ACCOUNTANT);
    await mount('/');
    await until(() => expect(homeLinks().length).toBeGreaterThan(0));
    expect(sideMenu()).not.toContain(i18n.t('nav.users'));
    expect(homeLinks()).not.toContain(i18n.t('nav.users'));
    // Everything else of the admin group is still there.
    expect(sideMenu()).toEqual(expect.arrayContaining([i18n.t('nav.branches'), i18n.t('nav.settings')]));
  });

  it('shows the accountant "no access" on /users, without asking the API', async () => {
    session.state = signedIn('ACCOUNTANT', ACCOUNTANT);
    await mount('/users');
    await until(() => expect(text()).toContain(i18n.t('access.title')));
    expect(text()).toContain('Accountant');
    expect(usersListRequested()).toBe(false);

    const home = [...container.querySelectorAll('button')].find((b) => b.textContent === i18n.t('access.home'))!;
    await act(async () => home.click());
    expect(pathname).toBe('/');
  });

  it('offers a viewer neither settings nor the quick "new document" buttons', async () => {
    session.state = signedIn('VIEWER', VIEWER);
    await mount('/');
    await until(() => expect(homeLinks().length).toBeGreaterThan(0));
    expect(sideMenu()).not.toContain(i18n.t('nav.settings'));
    expect(quickActions()).toEqual([]);
    expect(sideMenu()).toContain(i18n.t('nav.reports'));
  });

  it('offers the accountant the quick buttons the role can use', async () => {
    session.state = signedIn('ACCOUNTANT', ACCOUNTANT);
    await mount('/');
    await until(() => expect(quickActions().length).toBe(5));
    expect(quickActions()).toContain(i18n.t('sales.newInvoice'));
  });
});

describe('leaving a screen cancels its requests (WEB-05)', () => {
  beforeEach(() => setViewport(1280));

  it('aborts the branches list when the user goes home before it answers', async () => {
    session.state = signedIn('OWNER', OWNER);
    await mount('/branches');
    const url = '/api/v1/branches';
    await until(() => expect(signals.get(url)).toBeInstanceOf(AbortSignal));
    const signal = signals.get(url)!;
    expect(signal.aborted).toBe(false);

    const home = [...container.querySelectorAll<HTMLElement>('.app-sider .ant-menu-item')].find(
      (li) => li.textContent === i18n.t('nav.home'),
    )!;
    await act(async () => home.click());
    expect(pathname).toBe('/');
    await until(() => expect(signal.aborted).toBe(true));
  });

  it('aborts a request when its page unmounts', async () => {
    session.state = signedIn('OWNER', OWNER);
    await mount('/accounts');
    const url = '/api/v1/accounts';
    await until(() => expect(signals.get(url)).toBeInstanceOf(AbortSignal));
    const signal = signals.get(url)!;
    act(() => root.unmount());
    await until(() => expect(signal.aborted).toBe(true));
    // afterEach unmounts again; give it a fresh root to unmount.
    root = createRoot(container);
  });
});

describe('phone user menu (UI-10)', () => {
  beforeEach(() => setViewport(375));

  const trigger = () => container.querySelector<HTMLButtonElement>('button.topbar-user-menu')!;
  const menuItem = (label: string) =>
    [...document.body.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find((li) => li.textContent === label);

  async function openMenu(): Promise<void> {
    await act(async () => trigger().click());
    await until(() => expect(menuItem(i18n.t('auth.logout'))).toBeDefined());
  }

  beforeEach(async () => {
    session.state = signedIn('OWNER', OWNER);
    await mount('/accounts');
    await until(() => expect(trigger()).not.toBeNull());
  });

  it('is a labelled menu button whose expanded state follows the menu', async () => {
    expect(container.querySelector('.topbar-user')).toBeNull();
    expect(trigger().getAttribute('aria-label')).toBe(i18n.t('ui.userMenu'));
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    await openMenu();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it("heads the menu with the user's name, not as a disabled item", async () => {
    await openMenu();
    const heading = document.body.querySelector('.topbar-menu-user');
    expect(heading?.textContent).toBe('Rana Haddad');
    expect(heading?.closest('.ant-dropdown-menu-item-disabled')).toBeNull();
    const labels = [...document.body.querySelectorAll('.ant-dropdown-menu-item')].map((li) => li.textContent);
    expect(labels).toEqual([
      i18n.t('help.title'),
      i18n.t('language.switchTo'),
      i18n.t('auth.changePassword'),
      i18n.t('auth.logout'),
    ]);
  });

  it('opens help', async () => {
    await openMenu();
    await act(async () => menuItem(i18n.t('help.title'))!.click());
    expect(pathname).toBe('/help');
  });

  it('switches the language', async () => {
    await openMenu();
    await act(async () => menuItem(i18n.t('language.switchTo'))!.click());
    expect(i18n.language).toBe('ar');
  });

  it('opens the change-password dialog', async () => {
    await openMenu();
    await act(async () => menuItem(i18n.t('auth.changePassword'))!.click());
    await until(() => expect(document.body.querySelector('.ant-modal')).not.toBeNull());
  });

  it('signs out and returns to the home path', async () => {
    await openMenu();
    await act(async () => menuItem(i18n.t('auth.logout'))!.click());
    expect((session.state as AuthState).logout).toHaveBeenCalledTimes(1);
    expect(pathname).toBe('/');
  });
});
