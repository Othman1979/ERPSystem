import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  ApiError,
  authControllerLogin,
  authControllerLogout,
  authControllerRegister,
  meControllerMe,
  meControllerSwitchTenant,
  setAccessToken,
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

export interface MeData {
  user: {
    id: string;
    email: string;
    fullName: string;
    locale: string;
    isPlatformAdmin: boolean;
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
  } | null;
}

interface AuthState {
  status: 'loading' | 'authed' | 'guest';
  me: MeData | null;
  login: (email: string, password: string) => Promise<void>;
  register: (dto: RegisterDto) => Promise<void>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  const [me, setMe] = useState<MeData | null>(null);

  const refreshMe = useCallback(async () => {
    try {
      const res = await meControllerMe();
      setMe(res.data as unknown as MeData);
      setStatus('authed');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setAccessToken(null);
        setMe(null);
        setStatus('guest');
      } else {
        // Network/server error — treat as guest but keep it simple.
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
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe]);

  const register = useCallback(async (dto: RegisterDto) => {
    const res = await authControllerRegister(dto);
    const data = res.data as unknown as { accessToken: string };
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe]);

  const logout = useCallback(async () => {
    try {
      await authControllerLogout();
    } finally {
      setAccessToken(null);
      setMe(null);
      setStatus('guest');
    }
  }, []);

  const switchTenant = useCallback(async (tenantId: string) => {
    const res = await meControllerSwitchTenant({ tenantId });
    const data = res.data as unknown as { accessToken: string };
    setAccessToken(data.accessToken);
    await refreshMe();
  }, [refreshMe]);

  return (
    <AuthContext.Provider value={{ status, me, login, register, logout, switchTenant, refreshMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
