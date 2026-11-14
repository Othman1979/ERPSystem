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
const income = vi.fn();

/** Two centres and the "no centre" column; the net profit row is revenue less expenses per column. */
const REPORT = {
  from: '2026-01-01',
  to: '2026-12-31',
  fiscalYear: null,
  columns: [
    { costCenterId: 'c1', code: 'CC1', nameAr: 'مبيعات', nameEn: 'Sales' },
    { costCenterId: 'c2', code: 'CC2', nameAr: 'إدارة', nameEn: 'Admin' },
    { costCenterId: null, code: null, nameAr: null, nameEn: null },
  ],
  revenue: {
    rows: [
      {
        accountId: 'r1',
        code: '4101',
        nameAr: 'مبيعات',
        nameEn: 'Sales revenue',
        amounts: ['1200.000', '300.500', '50.000'],
        total: '1550.500',
      },
    ],
    totals: ['1200.000', '300.500', '50.000'],
    total: '1550.500',
  },
  expenses: {
    rows: [
      {
        accountId: 'e1',
        code: '5101',
        nameAr: 'رواتب',
        nameEn: 'Salaries',
        amounts: ['200.000', '100.000', '0.000'],
        total: '300.000',
      },
    ],
    totals: ['200.000', '100.000', '0.000'],
    total: '300.000',
  },
  netProfit: { amounts: ['1000.000', '200.500', '50.000'], total: '1250.500' },
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  reportsControllerIncomeStatementByCostCenter: (...args: unknown[]) => income(...args),
}));

const { IncomeByCostCenterTab } = await import('./IncomeByCostCenterTab');

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

/** Lets the query resolve and React commit the table. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  income.mockReset();
});

describe('IncomeByCostCenterTab', () => {
  it('renders a column per centre plus the no-centre column, the amounts and the net profit row', async () => {
    income.mockReturnValue(ok(REPORT));
    renderWithProviders(<IncomeByCostCenterTab />);
    await flush();

    const headers = [...(host?.querySelectorAll('th') ?? [])].map((th) => th.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['CC1 — Sales', 'CC2 — Admin', 'No centre', 'Total']));

    const text = host?.textContent ?? '';
    expect(text).toContain('Sales revenue');
    expect(text).toContain('1,200.000');
    expect(text).toContain('1,550.500');

    const net = host?.querySelector('tr.stmt-result');
    expect(net?.textContent).toContain('Net profit (loss)');
    expect(net?.textContent).toContain('1,000.000');
    expect(net?.textContent).toContain('200.500');
    expect(net?.textContent).toContain('50.000');
    expect(net?.textContent).toContain('1,250.500');
  });

  it('asks the company-wide report for the period the filters give', async () => {
    income.mockReturnValue(ok(REPORT));
    renderWithProviders(<IncomeByCostCenterTab />);
    await flush();
    expect(income).toHaveBeenCalledWith({ from: undefined, to: undefined }, expect.anything());
  });
});
