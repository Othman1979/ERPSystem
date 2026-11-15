// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no matchMedia; antd's responsive hooks ask for it.
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, headers: new Headers() });

const session = vi.hoisted(() => ({ permissions: ['company.manage', 'settings.manage'] as string[] }));
// `level: null` keeps the company query pending (the loading state).
const company = vi.hoisted(() => ({ level: 'FULL' as string | null }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: (p: string) => session.permissions.includes(p) }),
}));
const companyGet = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: (...args: unknown[]) => companyGet(...args),
}));

const { ProcurementLevelGate } = await import('./ProcurementLevelGate');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  companyGet.mockReset();
  companyGet.mockImplementation(() =>
    company.level === null ? new Promise(() => {}) : ok({ procurementLevel: company.level }),
  );
  company.level = 'FULL';
  session.permissions = ['company.manage', 'settings.manage'];
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 100) => act(() => new Promise((r) => setTimeout(r, ms)));
const CHILD = 'SCREEN CONTENT';

async function mount(min?: 'MEDIUM' | 'FULL') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ProcurementLevelGate min={min}>
            <div>{CHILD}</div>
          </ProcurementLevelGate>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const text = () => document.body.textContent ?? '';
const profileButton = () =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === i18n.t('procurement.shellUi.openCompanyProfile'),
  );

describe('ProcurementLevelGate (ADR-024 §2.3)', () => {
  it('renders the children at once for a route without a minimum, with no company request', async () => {
    await mount(undefined);
    expect(text()).toContain(CHILD);
    expect(companyGet).not.toHaveBeenCalled();
  });

  it('shows a spinner, not the screen or a no-access message, while the company loads', async () => {
    company.level = null;
    await mount('FULL');
    expect(document.querySelector('.ant-spin')).not.toBeNull();
    expect(text()).not.toContain(CHILD);
    expect(text()).not.toContain(i18n.t('procurement.shellUi.levelTooLowTitle'));
    expect(text()).not.toContain(i18n.t('access.title'));
  });

  it('explains the required level when the company is below it', async () => {
    company.level = 'MEDIUM';
    await mount('FULL');
    expect(text()).not.toContain(CHILD);
    expect(text()).toContain(i18n.t('procurement.shellUi.levelTooLowTitle'));
    expect(text()).toContain('“Full”');
    expect(text()).not.toContain(i18n.t('access.title'));
  });

  it('offers the company profile link to a company.manage holder who can open settings', async () => {
    company.level = 'SIMPLE';
    await mount('MEDIUM');
    expect(profileButton()).toBeDefined();
  });

  it('hides the profile link from a user without company.manage', async () => {
    company.level = 'SIMPLE';
    session.permissions = ['settings.manage'];
    await mount('MEDIUM');
    expect(text()).toContain(i18n.t('procurement.shellUi.levelTooLowTitle'));
    expect(profileButton()).toBeUndefined();
  });

  it('hides the profile link when the user cannot open settings', async () => {
    company.level = 'SIMPLE';
    session.permissions = ['company.manage'];
    await mount('MEDIUM');
    expect(profileButton()).toBeUndefined();
  });

  it('shows the children when the company is at or above the minimum', async () => {
    company.level = 'FULL';
    await mount('MEDIUM');
    expect(text()).toContain(CHILD);
    expect(text()).not.toContain(i18n.t('procurement.shellUi.levelTooLowTitle'));
  });
});
