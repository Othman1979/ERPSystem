import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  authControllerLogin,
  authControllerLogout,
  authControllerRegister,
  isConnectionError,
  meControllerMe,
  meControllerSwitchTenant,
  setAccessToken,
  setBranchId,
  type RegisterDto,
} from '@erp/api-client';

export interface TenantSummary {
  tenantId: string;
  tenantName: string;
  status: string;
  roleCode: string;
  roleNameAr: string;
  roleNameEn: string | null;
  isCurrent: boolean;
}

export interface BranchSummary {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

export interface MeData {
  user: {
    id: string;
    email: string;
    fullName: string;
    locale: string;
    isPlatformAdmin: boolean;
    /** True while the account still uses a temporary password (ADR-012). */
    mustChangePassword?: boolean;
  };
  tenants: TenantSummary[];
  currentTenant: {
    tenantId: string;
    name: string;
    status: string;
    plan: { code: string; nameAr: string; nameEn: string | null } | null;
  } | null;
  currentMembership: {
    membershipId: string;
    roleCode: string;
    defaultBranchId: string | null;
    /** Branches this member may switch to (all active ones when none are assigned). */
    branches: BranchSummary[];
  } | null;
}

interface AuthState {
  /**
   * `unreachable`: the session could not be checked because the server did not
   * answer (WEB-04). The session may well be valid, so this is not `guest`.
   */
  status: 'loading' | 'authed' | 'guest' | 'unreachable';
  me: MeData | null;
  login: (email: string, password: string) => Promise<void>;
  register: (dto: RegisterDto) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  /** Branch of every request (X-Branch-Id), chosen in the top bar — ADR-003. */
  branchId: string | null;
  setBranch: (branchId: string) => void;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

const branchStorageKey = (tenantId: string) => `erp.branch.${tenantId}`;

function readStoredBranch(tenantId: string): string | null {
  try {
    return window.localStorage.getItem(branchStorageKey(tenantId));
  } catch {
    return null;
  }
}

function storeBranch(tenantId: string, branchId: string): void {
  try {
    window.localStorage.setItem(branchStorageKey(tenantId), branchId);
  } catch {
    // Not critical: the default branch is used next time.
  }
}

/** Last branch picked on this browser if still allowed, else the default, else the first allowed. */
function pickBranch(me: MeData): string | null {
  const m = me.currentMembership;
  const tenantId = me.currentTenant?.tenantId;
  if (!m || !tenantId) return null;
  const allowed = new Set(m.branches.map((b) => b.id));
  const stored = readStoredBranch(tenantId);
  if (stored && allowed.has(stored)) return stored;
  if (m.defaultBranchId && allowed.has(m.defaultBranchId)) return m.defaultBranchId;
  return m.branches[0]?.id ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<MeData | null>(null);
  const [branchId, setBranchState] = useState<string | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const res = await meControllerMe();
      const data = res.data as unknown as MeData;
      const branch = pickBranch(data);
      setBranchId(branch);
      setBranchState(branch);
      setMe(data);
      setStatus('authed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAccessToken(null);
        setMe(null);
        setStatus('guest');
      } else if (isConnectionError(err) || (err instanceof ApiError && err.status >= 500)) {
        // No answer about the session. A signed-in user stays signed in (the
        // lists show their own errors); otherwise say the server is unreachable.
        setStatus((s) => (s === 'authed' ? s : 'unreachable'));
      } else {
        setStatus('guest');
      }
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await authControllerLogin({ email, password });
    const data = res.data as unknown as { accessToken: string };
    // Drop every cached query of the previous user/tenant before the new token is used (WEB-01).
    queryClient.clear();
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe, queryClient]);

  const register = useCallback(async (dto: RegisterDto) => {
    const res = await authControllerRegister(dto);
    const data = res.data as unknown as { accessToken: string };
    // Drop every cached query of the previous user/tenant before the new token is used (WEB-01).
    queryClient.clear();
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe, queryClient]);

  const logout = useCallback(async () => {
    try {
      await authControllerLogout();
    } finally {
      setAccessToken(null);
      setBranchId(null);
      setBranchState(null);
      setMe(null);
      setStatus('guest');
      // The next user on this device must not see this tenant's cached data (WEB-01).
      queryClient.clear();
    }
  }, [queryClient]);

  const setBranch = useCallback(
    (id: string) => {
      const tenantId = me?.currentTenant?.tenantId;
      if (!tenantId || !me?.currentMembership?.branches.some((b) => b.id === id)) return;
      storeBranch(tenantId, id);
      setBranchId(id);
      setBranchState(id);
      // Every list and lookup is branch-scoped from now on: refetch them.
      void queryClient.invalidateQueries();
    },
    [me, queryClient],
  );

  const switchTenant = useCallback(async (tenantId: string) => {
    const res = await meControllerSwitchTenant({ tenantId });
    const data = res.data as unknown as { accessToken: string };
    // Unmount the tenant-A pages first (App shows a spinner while loading), so none of
    // them refetches with the new token and the old branch before /me answers.
    setBranchId(null);
    setBranchState(null);
    setStatus('loading');
    // Drop every cached query of the previous user/tenant before the new token is used (WEB-01).
    queryClient.clear();
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe, queryClient]);

  // A new object only when something in it changes, so useAuth() consumers do
  // not re-render on every provider render (WEB-18).
  const value = useMemo<AuthState>(
    () => ({ status, me, login, register, logout, switchTenant, refreshMe, branchId, setBranch }),
    [status, me, login, register, logout, switchTenant, refreshMe, branchId, setBranch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/**
 * Remounts everything below it when the signed-in user or tenant changes, so
 * no component keeps local state (filters, open drawers, selected rows) from
 * the previous session (WEB-01). The query cache itself is cleared by AuthProvider.
 */
export function SessionBoundary({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const key = `${me?.user.id ?? 'guest'}:${me?.currentTenant?.tenantId ?? 'none'}`;
  return <Fragment key={key}>{children}</Fragment>;
}
