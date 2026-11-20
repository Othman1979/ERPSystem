// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, type ReactNode } from 'react';
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
/** Per-test switch: the company's cost-centre flag. */
const state = vi.hoisted(() => ({ enabled: true }));

vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: state.enabled, ready: true, rows: [], list: {}, nameOf: () => undefined }),
}));
vi.mock('../auth/AuthContext', async (original) => ({
  ...(await original<typeof import('../auth/AuthContext')>()),
  useAuth: () => ({ allBranches: true }),
}));

const account = (
  id: string,
  code: string,
  accountType: 'ASSET' | 'REVENUE' | 'EXPENSE',
  costCenterRequired: boolean,
) => ({
  id,
  tenantId: '1',
  companyId: '1',
  code,
  nameAr: `حساب ${code}`,
  nameEn: `Account ${code}`,
  parentId: null,
  level: 1,
  accountType,
  normalBalance: accountType === 'REVENUE' ? 'CREDIT' : 'DEBIT',
  isPostable: true,
  isControl: false,
  controlType: null,
  costCenterRequired,
  cashFlowActivity: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
});

const ACCOUNTS = [
  account('a1', '1101', 'ASSET', false),
  account('r1', '4101', 'REVENUE', true),
  account('x1', '5101', 'EXPENSE', false),
];

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerListAccounts: () => ok(ACCOUNTS),
  journalControllerTrialBalance: () => ok({ rows: [], totals: {}, balanced: true }),
}));

const { AccountsPage } = await import('./AccountsPage');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderWithProviders(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>{node}</MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
}

/** Lets the queries resolve and React commit the table. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The table row of an account code. */
const rowOf = (code: string) => [...(host?.querySelectorAll('tr') ?? [])].find((tr) => tr.textContent?.includes(code));

/** Opens the edit dialog of an account from its row. */
function openEdit(code: string) {
  const edit = [...(rowOf(code)?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (b) => b.textContent?.trim() === i18n.t('common.edit'),
  );
  if (!edit) throw new Error(`no edit button for ${code}`);
  act(() => edit.click());
}

/** Whether the open dialog shows the "centre required" switch. */
const switchShown = () =>
  [...document.querySelectorAll('label')].some((l) => l.textContent === i18n.t('costCenters.required'));

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  root = undefined;
  host = undefined;
  state.enabled = true;
});

describe('AccountsPage centre-required switch', () => {
  it('shows the switch for a revenue account when cost centres are on', async () => {
    renderWithProviders(<AccountsPage />);
    await flush();
    openEdit('4101');
    await flush();
    expect(switchShown()).toBe(true);
  });

  it('shows the switch for an expense account when cost centres are on', async () => {
    renderWithProviders(<AccountsPage />);
    await flush();
    openEdit('5101');
    await flush();
    expect(switchShown()).toBe(true);
  });

  it('hides the switch for a balance-sheet account even when cost centres are on', async () => {
    renderWithProviders(<AccountsPage />);
    await flush();
    openEdit('1101');
    await flush();
    expect(switchShown()).toBe(false);
  });

  it('hides the switch for a revenue account while cost centres are off', async () => {
    state.enabled = false;
    renderWithProviders(<AccountsPage />);
    await flush();
    openEdit('4101');
    await flush();
    expect(switchShown()).toBe(false);
  });

  it('shows the centre-required tag only on flagged accounts while cost centres are on', async () => {
    renderWithProviders(<AccountsPage />);
    await flush();
    expect(rowOf('4101')?.textContent).toContain(i18n.t('costCenters.requiredTag'));
    expect(rowOf('5101')?.textContent).not.toContain(i18n.t('costCenters.requiredTag'));
  });

  it('hides the centre-required tag while cost centres are off', async () => {
    state.enabled = false;
    renderWithProviders(<AccountsPage />);
    await flush();
    expect(rowOf('4101')?.textContent).not.toContain(i18n.t('costCenters.requiredTag'));
  });
});
