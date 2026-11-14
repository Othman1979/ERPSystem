// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
/** Per-test switches: the company's cost-centre flag and whether the member sees every branch. */
const state = vi.hoisted(() => ({ enabled: true, allBranches: true }));

vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: state.enabled, ready: true, rows: [], list: {}, nameOf: () => undefined }),
}));
vi.mock('../auth/AuthContext', async (original) => ({
  ...(await original<typeof import('../auth/AuthContext')>()),
  useAuth: () => ({ allBranches: state.allBranches }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerListAccounts: () => ok([]),
  fiscalControllerListYears: () => ok([]),
  journalControllerTrialBalance: () => ok({ rows: [], totals: {}, balanced: true }),
}));

const { ReportsPage } = await import('./ReportsPage');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>
            <ReportsPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Whether a tab with this label is in the tab bar. */
function hasTab(label: string): boolean {
  return [...(host?.querySelectorAll('[role="tab"]') ?? [])].some((tab) => tab.textContent?.includes(label));
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  state.enabled = true;
  state.allBranches = true;
});

describe('ReportsPage cost centre statement tab', () => {
  it('is offered when cost centres are on and the member sees every branch', async () => {
    await renderPage();
    expect(hasTab('Cost centre statement')).toBe(true);
  });

  it('is absent while cost centres are switched off for the company', async () => {
    state.enabled = false;
    await renderPage();
    expect(hasTab('Cost centre statement')).toBe(false);
  });

  it('is hidden from a branch-scoped member (company-wide report)', async () => {
    state.allBranches = false;
    await renderPage();
    expect(hasTab('Cost centre statement')).toBe(false);
  });
});
