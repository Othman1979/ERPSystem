// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

const state = vi.hoisted(() => ({
  companyId: 'company-a',
  company: { legalNameAr: 'شركة أ', legalNameEn: 'Company A', logo: null as { id: string } | null },
  logo: vi.fn(async (..._args: unknown[]) => ({ data: { mimeType: 'image/png', base64: 'abc' } })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ companyId: state.companyId }) }));
vi.mock('./CompanyProfileForm', () => ({ useCompany: () => ({ data: state.company }) }));
vi.mock('@erp/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@erp/api-client')>()),
  companyControllerLogo: (...args: unknown[]) => state.logo(...args),
}));
vi.mock('../branding/lastBranding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../branding/lastBranding')>()),
  shrinkLogo: vi.fn(async (logo: string) => logo),
}));

const { CompanyBranding } = await import('./CompanyBranding');
let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={client}><CompanyBranding /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  state.companyId = 'company-a';
  state.company = { legalNameAr: 'شركة أ', legalNameEn: 'Company A', logo: null };
  state.logo.mockClear();
  localStorage.clear();
});

beforeEach(async () => {
  await i18n.changeLanguage('ar');
});

describe('CompanyBranding', () => {
  it('renders the company logo and display name', async () => {
    state.company = { ...state.company, logo: { id: 'logo-a' } };
    await mount();
    expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,abc');
    expect(host.textContent).toContain('شركة أ');
  });

  it('falls back to ERP Cloud and the company name without a logo', async () => {
    state.company = { ...state.company, logo: null };
    await mount();
    expect(host.textContent).toContain('ERP Cloud');
    expect(host.textContent).toContain('شركة أ');
    expect(JSON.parse(localStorage.getItem('erp.lastBranding') ?? 'null')).toEqual({
      nameAr: 'شركة أ',
      nameEn: 'Company A',
      logo: null,
    });
  });

  it('updates the stored name when company data changes', async () => {
    await mount();
    state.company = { ...state.company, logo: null, legalNameAr: 'شركة جديدة' };
    await act(async () => {
      root!.render(<QueryClientProvider client={client}><CompanyBranding /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(JSON.parse(localStorage.getItem('erp.lastBranding') ?? 'null')).toEqual({
      nameAr: 'شركة جديدة',
      nameEn: 'Company A',
      logo: null,
    });
  });

  it('fetches the logo again when the company changes', async () => {
    state.company = { ...state.company, logo: { id: 'logo-a' } };
    await mount();
    expect(state.logo).toHaveBeenCalledTimes(1);
    state.companyId = 'company-b';
    await act(async () => {
      root!.render(<QueryClientProvider client={client}><CompanyBranding /></QueryClientProvider>);
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(state.logo).toHaveBeenCalledTimes(2);
  });
});
