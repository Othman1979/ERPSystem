import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, CLIENT_ERROR, meControllerMe } from '@erp/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('@erp/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@erp/api-client')>();
  return {
    ...actual,
    meControllerMe: vi.fn(async () => ({
      data: {
        user: { id: 'u1', email: 'a@x.test', fullName: 'A', locale: 'ar', isPlatformAdmin: false },
        tenants: [],
        currentTenant: { tenantId: 'A', name: 'A', status: 'ACTIVE', plan: null },
        currentMembership: { membershipId: 'm1', roleCode: 'OWNER', defaultBranchId: null, branches: [] },
      },
    })),
    setAccessToken: vi.fn(),
    setBranchId: vi.fn(),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const seen: ReturnType<typeof useAuth>[] = [];
let rerenderParent: (() => void) | null = null;

function Probe() {
  seen.push(useAuth());
  return null;
}

/** Re-renders AuthProvider itself (as a language switch above it would). */
function Parent() {
  const [, setTick] = useState(0);
  rerenderParent = () => setTick((n) => n + 1);
  return (
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
}

describe('AuthProvider when the server does not answer (WEB-04, WEB-18)', () => {
  let root: Root;

  beforeEach(() => {
    seen.length = 0;
    vi.mocked(meControllerMe).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  async function mount() {
    root = createRoot(document.createElement('div'));
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <Parent />
        </QueryClientProvider>,
      );
    });
  }

  const last = () => seen[seen.length - 1];

  it.each([
    ['a network failure', new ApiError(0, CLIENT_ERROR.NETWORK_ERROR, 'Failed to fetch')],
    ['a timeout', new ApiError(0, CLIENT_ERROR.NETWORK_TIMEOUT, 'timed out')],
    ['a proxy 502 page', new ApiError(502, CLIENT_ERROR.SERVER_UNAVAILABLE, 'Bad Gateway')],
  ])('is unreachable, not guest, after %s on /me', async (_case, error) => {
    vi.mocked(meControllerMe).mockRejectedValueOnce(error);
    await mount();
    expect(last().status).toBe('unreachable');
  });

  it('is guest after a 401 on /me', async () => {
    vi.mocked(meControllerMe).mockRejectedValueOnce(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    await mount();
    expect(last().status).toBe('guest');
  });

  it('becomes authed when a retry reaches the server', async () => {
    vi.mocked(meControllerMe).mockRejectedValueOnce(new ApiError(0, CLIENT_ERROR.NETWORK_ERROR, 'down'));
    await mount();
    expect(last().status).toBe('unreachable');
    await act(() => last().refreshMe());
    expect(last().status).toBe('authed');
    expect(last().me?.currentTenant?.tenantId).toBe('A');
  });

  it('keeps a signed-in user signed in when a later /me cannot reach the server', async () => {
    await mount();
    expect(last().status).toBe('authed');
    vi.mocked(meControllerMe).mockRejectedValueOnce(new ApiError(0, CLIENT_ERROR.NETWORK_ERROR, 'down'));
    await act(() => last().refreshMe());
    expect(last().status).toBe('authed');
  });

  it('keeps the same context value when the provider re-renders with nothing changed', async () => {
    await mount();
    const before = last();
    act(() => rerenderParent!());
    expect(seen.length).toBeGreaterThan(1);
    expect(last()).toBe(before);
  });
});
