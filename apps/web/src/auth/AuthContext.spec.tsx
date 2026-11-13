import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

// Cache size observed at the moment each new access token is installed.
const cacheSizeAtTokenSet: number[] = [];
let client: QueryClient;
// Tenant the mocked /me returns; reset before every test.
const session = vi.hoisted(() => ({ tenant: 'A' }));

vi.mock('@erp/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@erp/api-client')>();
  const me = (tenantId: string) => ({
    data: {
      user: { id: 'u1', email: 'a@x.test', fullName: 'A', locale: 'ar', isPlatformAdmin: false },
      tenants: [],
      currentTenant: { tenantId, name: tenantId, status: 'ACTIVE', plan: null },
      currentMembership: { membershipId: 'm1', roleCode: 'OWNER', defaultBranchId: null, branches: [] },
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
