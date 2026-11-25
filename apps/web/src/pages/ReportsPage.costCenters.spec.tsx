// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ribbon } from '../components/Ribbon';
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
const api = vi.hoisted(() => ({
  accounts: vi.fn(),
  trialBalance: vi.fn(),
  generalLedger: vi.fn(),
}));

vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: state.enabled, ready: true, rows: [], list: {}, nameOf: () => undefined }),
}));
vi.mock('../auth/AuthContext', async (original) => ({
  ...(await original<typeof import('../auth/AuthContext')>()),
  useAuth: () => ({ allBranches: state.allBranches }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerListAccounts: () => api.accounts(),
  fiscalControllerListYears: () => ok([]),
  journalControllerTrialBalance: () => api.trialBalance(),
  journalControllerGeneralLedger: api.generalLedger,
}));

const { ReportsPage } = await import('./ReportsPage');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function ReportsHistoryControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location-search">{location.search}</output>
      <button data-testid="go-back" onClick={() => navigate(-1)}>Back</button>
    </>
  );
}

async function renderPage(path = '/reports', withRibbon = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[path]}>
            {withRibbon && (
              <Ribbon
                can={() => true}
                allBranches
                noCompany={false}
                isPlatformAdmin={false}
                pendingInvitations={0}
                compact={false}
              />
            )}
            {withRibbon && <ReportsHistoryControls />}
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

async function until(check: () => void) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      check();
      return;
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
  check();
}

/** Whether a tab with this label is in the tab bar. */
function hasTab(label: string): boolean {
  return [...(host?.querySelectorAll('[role="tab"]') ?? [])].some((tab) => tab.textContent?.includes(label));
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  api.accounts.mockReset().mockResolvedValue(ok([]));
  api.trialBalance.mockReset().mockResolvedValue(ok({
    rows: [],
    nominalFrom: null,
    totals: {
      debit: '0', credit: '0', openingDebit: '0', openingCredit: '0', periodDebit: '0',
      periodCredit: '0', closingDebit: '0', closingCredit: '0',
    },
    balanced: true,
  }));
  api.generalLedger.mockReset().mockResolvedValue(ok({
    items: [],
    nextCursor: null,
    summary: {
      openingBalance: '0', openingDebit: '0', openingCredit: '0', totalDebit: '0', totalCredit: '0',
      closingBalance: '0', closingDebit: '0', closingCredit: '0',
    },
  }));
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

describe('ReportsPage account URL history', () => {
  it('restores the prior ledger account after Back from a trial-balance shortcut', async () => {
    window.localStorage.setItem('erp.ribbonFolded', '0');
    api.accounts.mockResolvedValue(ok([
      { id: 'A', code: '1000', nameAr: 'الحساب A', nameEn: 'Account A' },
      { id: 'B', code: '2000', nameAr: 'الحساب B', nameEn: 'Account B' },
    ]));
    api.trialBalance.mockResolvedValue(ok({
      rows: [{
        accountId: 'B',
        kind: null,
        code: '2000',
        nameAr: 'الحساب B',
        nameEn: 'Account B',
        accountType: 'ASSET',
        normalBalance: 'DEBIT',
        totalDebit: '1',
        totalCredit: '0',
        balance: '1',
        openingDebit: '0',
        openingCredit: '0',
        periodDebit: '1',
        periodCredit: '0',
        closingDebit: '1',
        closingCredit: '0',
      }],
      nominalFrom: null,
      totals: {
        debit: '1', credit: '0', openingDebit: '0', openingCredit: '0', periodDebit: '1',
        periodCredit: '0', closingDebit: '1', closingCredit: '0',
      },
      balanced: true,
    }));

    await renderPage('/reports?tab=gl&accountId=A', true);
    await until(() => expect(api.generalLedger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'A' }),
      expect.anything(),
    ));

    const trialBalanceLink = host?.querySelector<HTMLAnchorElement>('a[href="/reports?tab=tb"]');
    expect(trialBalanceLink).toBeTruthy();
    act(() => trialBalanceLink!.click());
    await until(() => expect(host?.querySelector('[data-testid="location-search"]')?.textContent).toBe('?tab=tb'));

    const accountBRow = [...(host?.querySelectorAll<HTMLElement>('.ant-table-tbody tr') ?? [])]
      .find((row) => row.textContent?.includes('Account B'));
    expect(accountBRow).toBeTruthy();
    act(() => accountBRow!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await until(() => expect(host?.querySelector('[data-testid="location-search"]')?.textContent).toBe('?tab=gl&accountId=B'));
    await until(() => expect(api.generalLedger).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'B' }),
      expect.anything(),
    ));

    act(() => host!.querySelector<HTMLButtonElement>('[data-testid="go-back"]')!.click());
    await until(() => expect(host?.querySelector('[data-testid="location-search"]')?.textContent).toBe('?tab=gl&accountId=A'));
    await until(() => expect(host?.querySelector('.report-meta strong')?.textContent).toContain('Account A'));
  });
});
