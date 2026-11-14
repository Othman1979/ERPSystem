import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, meControllerMe } from '@erp/api-client';
import { AuthProvider, ME_RELOAD_MIN_MS, useAuth } from './AuthContext';

// Cache size observed at the moment each new access token is installed.
const cacheSizeAtTokenSet: number[] = [];
let client: QueryClient;
// Tenant the mocked /me returns; reset before every test.
const session = vi.hoisted(() => ({
  tenant: 'A',
  permissions: null as string[] | null,
  // What GET /me says about the member's branches; undefined = an API that does not send it.
  allBranches: undefined as boolean | undefined,
}));

vi.mock('@erp/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@erp/api-client')>();
  const me = (tenantId: string) => ({
    data: {
      user: { id: 'u1', email: 'a@x.test', fullName: 'A', locale: 'ar', isPlatformAdmin: false },
      tenants: [],
      currentTenant: { tenantId, name: tenantId, status: 'ACTIVE', plan: null },
      currentMembership: {
        membershipId: 'm1',
        roleCode: tenantId === 'A' ? 'OWNER' : 'VIEWER',
        // Each tenant's own role permissions, as GET /me lists them.
        permissions: session.permissions ?? (tenantId === 'A' ? ['tenant.read', 'user.manage'] : ['tenant.read']),
        defaultBranchId: null,
        branches: [],
        allBranches: session.allBranches,
      },
    },
  });
  return {
    ...actual,
    meControllerMe: vi.fn(async () => me(session.tenant)),
    meControllerSwitchTenant: vi.fn(async ({ tenantId }: { tenantId: string }) => {
      session.tenant = tenantId;
      return { data: { accessToken: `token-${tenantId}` } };
    }),
    authControllerLogin: vi.fn(async () => ({ data: { accessToken: 'token-login' } })),
    authControllerRegister: vi.fn(async () => ({ data: { accessToken: 'token-register' } })),
    authControllerLogout: vi.fn(async () => ({ data: undefined })),
    setAccessToken: vi.fn((token: string | null) => {
      if (token) cacheSizeAtTokenSet.push(client.getQueryCache().getAll().length);
    }),
    setBranchId: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let auth: ReturnType<typeof useAuth> | null = null;
function Probe() {
  auth = useAuth();
  return null;
}

/** Puts tenant A's data in the cache, as a visited /items page would. */
function seedTenantAData() {
  client.setQueryData(['items'], [{ id: '1', code: 'A-ITEM' }]);
  client.setQueryData(['parties', 'CUSTOMER'], [{ id: '2', nameAr: 'A customer' }]);
  expect(client.getQueryCache().getAll()).toHaveLength(2);
}

describe('AuthProvider query cache (WEB-01)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    cacheSizeAtTokenSet.length = 0;
    session.tenant = 'A';
    client = new QueryClient();
    container = document.createElement('div');
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>,
      );
    });
    expect(auth?.status).toBe('authed');
  });

  afterEach(() => {
    act(() => root.unmount());
    auth = null;
  });

  it('is empty after logout', async () => {
    seedTenantAData();
    await act(() => auth!.logout());
    expect(auth?.status).toBe('guest');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('is empty after a tenant switch, before the new token is used', async () => {
    seedTenantAData();
    await act(() => auth!.switchTenant('B'));
    expect(auth?.me?.currentTenant?.tenantId).toBe('B');
    expect(cacheSizeAtTokenSet).toEqual([0]);
    expect(client.getQueryData(['items'])).toBeUndefined();
  });

  it('is empty before the token of a new login is used', async () => {
    seedTenantAData();
    await act(() => auth!.login('b@x.test', 'secret'));
    expect(cacheSizeAtTokenSet).toEqual([0]);
  });
});

describe('AuthProvider can() follows the current tenant role', () => {
  let root: Root;

  beforeEach(async () => {
    session.tenant = 'A';
    client = new QueryClient();
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>,
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    auth = null;
  });

  it('answers from the permissions GET /me listed for this tenant', () => {
    expect(auth!.can('user.manage')).toBe(true);
    expect(auth!.can('tenant.read')).toBe(true);
    expect(auth!.can('settings.manage')).toBe(false);
  });

  it("drops tenant A's permissions after switching to tenant B", async () => {
    await act(() => auth!.switchTenant('B'));
    expect(auth!.can('user.manage')).toBe(false);
    expect(auth!.can('tenant.read')).toBe(true);
  });

  it('allows nothing once signed out', async () => {
    await act(() => auth!.logout());
    expect(auth!.can('tenant.read')).toBe(false);
  });
});

describe('AuthProvider reloads /me when the role may have changed', () => {
  let root: Root;
  const meCalls = () => vi.mocked(meControllerMe).mock.calls.length;
  const settle = (ms = 0) => act(async () => vi.advanceTimersByTimeAsync(ms));

  /** A query that the API refuses with `status` / `code`, as a page's list would be. */
  async function refusedQuery(key: string, status = 403, code = 'FORBIDDEN') {
    await client
      .fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(new ApiError(status, code, 'refused')), retry: false })
      .catch(() => undefined);
    await settle();
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    session.tenant = 'A';
    session.permissions = null;
    client = new QueryClient();
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    expect(auth?.status).toBe('authed');
  });

  afterEach(() => {
    act(() => root.unmount());
    auth = null;
    session.permissions = null;
    vi.useRealTimers();
  });

  it('picks up a downgrade after a 403 for a missing permission', async () => {
    expect(auth!.can('user.manage')).toBe(true);
    // An admin takes user.manage away; the next call to /users answers 403.
    session.permissions = ['tenant.read'];
    await settle(ME_RELOAD_MIN_MS);
    const before = meCalls();
    await refusedQuery('users');
    expect(meCalls()).toBe(before + 1);
    expect(auth!.can('user.manage')).toBe(false);
    expect(auth!.status).toBe('authed');
  });

  it('reloads at most once per window, once more at its end, however many 403s arrive', async () => {
    await settle(ME_RELOAD_MIN_MS);
    const before = meCalls();
    await refusedQuery('a');
    await refusedQuery('b');
    await refusedQuery('c');
    // The first reloads at once; b and c fall inside its window.
    expect(meCalls()).toBe(before + 1);
    // They are served by one reload at the end of the window, not one each.
    await settle(ME_RELOAD_MIN_MS);
    expect(meCalls()).toBe(before + 2);
    await settle(ME_RELOAD_MIN_MS);
    expect(meCalls()).toBe(before + 2);
  });

  it('waits out the window when a 403 comes right after sign-in', async () => {
    const before = meCalls();
    session.permissions = ['tenant.read'];
    await refusedQuery('users');
    expect(meCalls()).toBe(before);
    await settle(ME_RELOAD_MIN_MS);
    expect(meCalls()).toBe(before + 1);
    expect(auth!.can('user.manage')).toBe(false);
  });

  it('ignores refusals that are not about permissions', async () => {
    await settle(ME_RELOAD_MIN_MS);
    const before = meCalls();
    await refusedQuery('posting', 403, 'TENANT_READ_ONLY');
    await refusedQuery('missing', 404, 'NOT_FOUND');
    expect(meCalls()).toBe(before);
  });

  it('picks up an upgrade when the tab comes back into focus', async () => {
    session.permissions = ['tenant.read', 'user.manage', 'settings.manage'];
    await settle(ME_RELOAD_MIN_MS);
    const before = meCalls();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await settle();
    expect(meCalls()).toBe(before + 1);
    expect(auth!.can('settings.manage')).toBe(true);
  });

  it('keeps the session when the reload fails on a server error', async () => {
    await settle(ME_RELOAD_MIN_MS);
    vi.mocked(meControllerMe).mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'boom'));
    await refusedQuery('users');
    expect(auth!.status).toBe('authed');
    expect(auth!.can('user.manage')).toBe(true);
  });
});

describe('AuthProvider allBranches (company-wide reports, fails closed)', () => {
  let root: Root;

  async function mountAs(allBranches: boolean | undefined) {
    session.allBranches = allBranches;
    client = new QueryClient();
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AuthProvider>
            <Probe />
          </AuthProvider>
        </QueryClientProvider>,
      );
    });
    expect(auth?.status).toBe('authed');
  }

  beforeEach(() => {
    session.tenant = 'A';
  });

  afterEach(() => {
    act(() => root.unmount());
    auth = null;
    session.allBranches = undefined;
  });

  it('is true only when GET /me says the member sees every branch', async () => {
    await mountAs(true);
    expect(auth!.allBranches).toBe(true);
  });

  it('is false for a branch-scoped member', async () => {
    await mountAs(false);
    expect(auth!.allBranches).toBe(false);
  });

  it('is false for an API that does not send the flag (fails closed)', async () => {
    await mountAs(undefined);
    expect(auth!.allBranches).toBe(false);
  });

  it('is false on the first render, before /me has answered, even for an all-branch member', () => {
    session.allBranches = true;
    // The first render happens before /me resolves: no company-wide report may show then.
    const seen: boolean[] = [];
    function Early() {
      seen.push(useAuth().allBranches);
      return null;
    }
    const early = createRoot(document.createElement('div'));
    act(() => {
      early.render(
        <QueryClientProvider client={new QueryClient()}>
          <AuthProvider>
            <Early />
          </AuthProvider>
        </QueryClientProvider>,
      );
    });
    expect(seen[0]).toBe(false);
    act(() => early.unmount());
  });
});
