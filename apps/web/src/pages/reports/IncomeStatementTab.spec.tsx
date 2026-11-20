// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';

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
const plain = vi.fn();
const byCentre = vi.fn();

vi.mock('../../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: state.enabled, ready: true, rows: [], list: {}, nameOf: () => undefined }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  reportsControllerIncomeStatement: (...args: unknown[]) => plain(...args),
  reportsControllerIncomeStatementByCostCenter: (...args: unknown[]) => byCentre(...args),
}));

const EMPTY_SECTION = { rows: [], totals: [], total: '0.000' };
const PLAIN_REPORT = {
  from: '2026-03-01',
  to: '2026-12-31',
  fiscalYear: null,
  revenue: EMPTY_SECTION,
  costOfSales: { rows: [], total: '0.000' },
  grossProfit: '0.000',
  expenses: EMPTY_SECTION,
  netProfit: '0.000',
};
const BY_CENTRE_REPORT = {
  from: '2026-03-01',
  to: '2026-12-31',
  fiscalYear: null,
  columns: [{ costCenterId: null, code: null, nameAr: null, nameEn: null }],
  revenue: { rows: [], totals: ['0.000'], total: '0.000' },
  expenses: { rows: [], totals: ['0.000'], total: '0.000' },
  netProfit: { amounts: ['0.000'], total: '0.000' },
};

const { IncomeStatementTab } = await import('./IncomeStatementTab');

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

/** Lets the queries resolve and React commit the tables. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Types a day's digits (DDMMYYYY) into a masked period picker and commits it with Enter, as a user does. */
function typeDay(label: string, digits: string) {
  const input = host?.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no picker "${label}"`);
  const key = (k: string) =>
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  act(() => input.focus());
  for (const d of digits) key(d);
  key('Enter');
}

/** The option of the view switch with this label. */
function viewOption(label: string): HTMLInputElement | undefined {
  const items = [...(host?.querySelectorAll<HTMLLabelElement>('.ant-segmented-item') ?? [])];
  return items.find((item) => item.textContent?.trim() === label)?.querySelector('input') ?? undefined;
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
  plain.mockReset();
  byCentre.mockReset();
});

describe('IncomeStatementTab', () => {
  it('shows one toolbar with the view switch when cost centres are on', async () => {
    plain.mockReturnValue(ok(PLAIN_REPORT));
    byCentre.mockReturnValue(ok(BY_CENTRE_REPORT));
    renderWithProviders(<IncomeStatementTab />);
    await flush();

    expect(host?.querySelectorAll('.list-toolbar')).toHaveLength(1);
    expect(host?.querySelectorAll('.ant-segmented-item')).toHaveLength(2);
    const prints = [...(host?.querySelectorAll('button') ?? [])].filter(
      (b) => b.textContent?.trim() === i18n.t('common.print'),
    );
    expect(prints).toHaveLength(1);
  });

  it('has no view switch while cost centres are off', async () => {
    state.enabled = false;
    plain.mockReturnValue(ok(PLAIN_REPORT));
    renderWithProviders(<IncomeStatementTab />);
    await flush();

    expect(host?.querySelector('.ant-segmented')).toBeNull();
    expect(byCentre).not.toHaveBeenCalled();
  });

  it('keeps the period when toggling to by centre and back', async () => {
    plain.mockReturnValue(ok(PLAIN_REPORT));
    byCentre.mockReturnValue(ok(BY_CENTRE_REPORT));
    renderWithProviders(<IncomeStatementTab />);
    await flush();

    typeDay(i18n.t('reports.from'), '01032026');
    await flush();
    expect(plain).toHaveBeenLastCalledWith({ from: '2026-03-01', to: undefined }, expect.anything());

    act(() => viewOption(i18n.t('costCenters.byCentre'))!.click());
    await flush();
    expect(byCentre).toHaveBeenLastCalledWith({ from: '2026-03-01', to: undefined }, expect.anything());
    expect(host?.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t('reports.from')}"]`)?.value).toBe(
      '01/03/2026',
    );

    act(() => viewOption(i18n.t('reports.incomeStatement'))!.click());
    await flush();
    expect(plain).toHaveBeenLastCalledWith({ from: '2026-03-01', to: undefined }, expect.anything());
    expect(host?.querySelector<HTMLInputElement>(`input[aria-label="${i18n.t('reports.from')}"]`)?.value).toBe(
      '01/03/2026',
    );
  });
});
