import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DashboardSummaryDto } from '@erp/api-client';
import i18n from '../i18n';
import { HomeDashboard, MonthlyBars } from './HomeDashboard';

const mocks = vi.hoisted(() => ({ tenantRead: true, summary: null as unknown }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (permission: string) => permission === 'reports.view' || (permission === 'tenant.read' && mocks.tenantRead),
  }),
}));

vi.mock('@erp/api-client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number) {
      super();
      this.status = status;
    }
  },
  reportsControllerDashboardSummary: vi.fn(async () => ({ data: mocks.summary })),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary: DashboardSummaryDto = {
  date: '2026-03-15',
  salesToday: { from: '2026-03-15', to: '2026-03-15', count: 1, returnCount: 0, net: '10.000', tax: '0.000', grand: '10.000' },
  salesMonth: { from: '2026-03-01', to: '2026-03-15', count: 1, returnCount: 0, net: '10.000', tax: '0.000', grand: '10.000' },
  receivables: { total: '20.000', overdue: '0.000' },
  belowMinimum: { count: 0, items: [] },
  monthly: [
    { month: '2026-01', sales: '12.000', expenses: '3.000' },
    { month: '2026-02', sales: '8.000', expenses: '4.000' },
  ],
  cashBank: [{ accountId: '1', code: '1101', nameAr: 'الصندوق', nameEn: 'Cash', balance: '50.000' }],
  cashBankTotal: '50.000',
  receivablesAging: { current: '20.000', d1_30: '0.000', d31_60: '0.000', d61_90: '0.000', d90plus: '0.000' },
  chequesDue: {
    incoming: { count: 1, amount: '30.000' },
    outgoing: { count: 0, amount: '0.000' },
  },
  drafts: { journalEntries: 1, salesInvoices: 0, purchaseInvoices: 0, receipts: 0, payments: 0 },
};

let root: Root;
let container: HTMLDivElement;

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>{node}</MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
}

async function until(check: () => void): Promise<void> {
  for (let index = 0; ; index++) {
    try {
      check();
      return;
    } catch (error) {
      if (index > 50) throw error;
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
  }
}

beforeEach(async () => {
  await i18n.changeLanguage('en');
  mocks.tenantRead = true;
  mocks.summary = summary;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

describe('home dashboard blocks', () => {
  it('renders monthly sales and expense bars with their legend and amount tooltips', async () => {
    await mount(<MonthlyBars monthly={summary.monthly} />);
    expect(container.querySelectorAll('.home-monthly-bar')).toHaveLength(4);
    expect(container.textContent).toContain(i18n.t('dashboard.monthlySales'));
    expect(container.textContent).toContain(i18n.t('dashboard.monthlyExpenses'));
    expect([...container.querySelectorAll<HTMLElement>('.home-monthly-bar')].every((bar) => !!bar.title)).toBe(true);
  });

  it('hides module blocks when tenant.read is unavailable', async () => {
    mocks.tenantRead = false;
    await mount(<HomeDashboard />);
    await until(() => expect(container.textContent).toContain(i18n.t('dashboard.monthlySales')));
    expect(container.textContent).not.toContain(i18n.t('dashboard.cashBank'));
    expect(container.textContent).not.toContain(i18n.t('dashboard.receivablesAging'));
    expect(container.textContent).not.toContain(i18n.t('dashboard.chequesDue'));
    expect(container.textContent).not.toContain(i18n.t('dashboard.pendingDrafts'));
  });
});
