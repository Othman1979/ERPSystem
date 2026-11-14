import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  authControllerLogin,
  authControllerLogout,
  authControllerRegister,
  isConnectionError,
  meControllerMe,
  meControllerSwitchTenant,
  onSessionChange,
  setAccessToken,
  setBranchId,
  type RegisterDto,
} from '@erp/api-client';
import type { Permission } from './permissions';

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
    /** Permission codes of this role in the current tenant (GET /me); see `can`. */
    permissions: string[];
    defaultBranchId: string | null;
    /** Branches this member may switch to (all active ones when none are assigned). */
    branches: BranchSummary[];
    /** No branch assigned: may open the company-wide reports (ADR-003 §13–§14). */
    allBranches?: boolean;
  } | null;
  /** Company invitations waiting for this user's acceptance (ADR-012 §PLAT-10). */
  pendingInvitations?: number;
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
  /**
   * True when the user's role has `permission` in the current tenant. The web
   * hides what this is false for; the API still enforces every permission.
   */
  can: (permission: Permission) => boolean;
  /**
   * True when the member has every branch (no branch assigned, ADR-003 §13).
   * The company-wide reports (trial balance, account statement, income
   * statement, balance sheet) are hidden from others; the API refuses them.
   */
  allBranches: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

/** Least time between two /me reloads triggered by a 403 or by the tab coming back into view. */
export const ME_RELOAD_MIN_MS = 5_000;

/** A 403 for a missing permission or branch scope (not read-only mode or another refusal with its own code). */
function isPermissionRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 403 &&
    (error.code === 'FORBIDDEN' || error.code === 'ALL_BRANCHES_REQUIRED')
  );
}

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
  // For the /me reloads below: when /me last loaded, a reload waiting for its turn, and the current status.
  const lastMeReload = useRef(0);
  const pendingMeReload = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef(status);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const refreshMe = useCallback(async () => {
    lastMeReload.current = Date.now();
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
      } else if (isConnectionError(err)) {
        // The API could not be reached, so nothing is known about the session.
        // A signed-in user stays signed in (the lists show their own errors);
        // otherwise say the server is unreachable. Any answer the server did
        // give (its own 5xx included) falls through to the sign-in screen.
        setStatus((s) => (s === 'authed' ? s : 'unreachable'));
      } else {
        setStatus('guest');
      }
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // Roles change while people work: an admin downgrades someone (their menus
  // now answer 403) or upgrades them (they still see "no access"). Reload /me
  // when the API refuses a permission and when the tab comes back into view,
  // at most once per ME_RELOAD_MIN_MS; a call inside that window runs once at
  // its end. A failed reload keeps the session as it is, except on 401.
  const reloadMe = useCallback(async () => {
    try {
      const res = await meControllerMe();
      const data = res.data as unknown as MeData;
      setMe(data);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAccessToken(null);
        setMe(null);
        setStatus('guest');
      }
    }
  }, []);

  const reloadMeSoon = useCallback(() => {
    if (statusRef.current !== 'authed' || pendingMeReload.current) return;
    const wait = lastMeReload.current + ME_RELOAD_MIN_MS - Date.now();
    const run = () => {
      pendingMeReload.current = null;
      if (statusRef.current !== 'authed') return;
      lastMeReload.current = Date.now();
      void reloadMe();
    };
    if (wait <= 0) run();
    else pendingMeReload.current = setTimeout(run, wait);
  }, [reloadMe]);

  useEffect(() => {
    const onError = (error: unknown) => {
      if (isPermissionRefusal(error)) reloadMeSoon();
    };
    const offQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const offMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadMeSoon();
    };
    window.addEventListener('focus', reloadMeSoon);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offQueries();
      offMutations();
      window.removeEventListener('focus', reloadMeSoon);
      document.removeEventListener('visibilitychange', onVisible);
      if (pendingMeReload.current) clearTimeout(pendingMeReload.current);
      pendingMeReload.current = null;
    };
  }, [queryClient, reloadMeSoon]);

  // Another tab switched tenant or signed in as someone else, and this tab's
  // token refresh followed the shared cookie into that session: drop this
  // tab's cache (reference data stays fresh for 5 minutes) and reload /me,
  // as a switch in this tab does (WEB-01, WEB-13).
  useEffect(
    () =>
      onSessionChange(() => {
        setBranchId(null);
        setBranchState(null);
        setStatus('loading');
        queryClient.clear();
        void refreshMe();
      }),
    [queryClient, refreshMe],
  );

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

  const permissions = useMemo(() => new Set(me?.currentMembership?.permissions ?? []), [me]);
  const can = useCallback((permission: Permission) => permissions.has(permission), [permissions]);
  // Fails closed: until /me has loaded, and for an API that does not send the
  // flag, the member is treated as branch-scoped. Company-wide reports (trial
  // balance, statements, income statement, balance sheet) are shown only when
  // /me says so; the API refuses them to a branch-scoped member anyway.
  const allBranches = me?.currentMembership?.allBranches === true;

  // A new object only when something in it changes, so useAuth() consumers do
  // not re-render on every provider render (WEB-18).
  const value = useMemo<AuthState>(
    () => ({ status, me, login, register, logout, switchTenant, refreshMe, branchId, setBranch, can, allBranches }),
    [status, me, login, register, logout, switchTenant, refreshMe, branchId, setBranch, can, allBranches],
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
