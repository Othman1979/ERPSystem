// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
window.requestAnimationFrame ??= (callback) => window.setTimeout(() => callback(Date.now()), 0);
window.cancelAnimationFrame ??= (handle) => window.clearTimeout(handle);

const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, headers: new Headers() });
const EXISTING_CUSTOMER = {
  id: 'customer-1',
  code: 'C-1',
  nameAr: 'عميل موجود',
  nameEn: 'Existing customer',
  partyType: 'CUSTOMER',
  isActive: true,
};
const NEW_CUSTOMER = {
  id: 'customer-2',
  code: 'C-2',
  nameAr: 'عميل جديد',
  nameEn: 'New customer',
  partyType: 'CUSTOMER',
  isActive: true,
};
const DRAFT_INVOICE = {
  id: 'invoice-1',
  invoiceNo: null,
  status: 'DRAFT',
  invoiceDate: '2026-01-01',
  dueDate: null,
  customerId: EXISTING_CUSTOMER.id,
  customer: EXISTING_CUSTOMER,
  warehouseId: 'warehouse-1',
  warehouse: { id: 'warehouse-1', code: 'W-1', nameAr: 'مستودع', nameEn: 'Warehouse' },
  paymentType: 'CREDIT',
  cashAccountId: null,
  grandTotal: '100.000',
  paidAmount: '0.000',
  netTotal: '100.000',
  invoiceDiscountAmount: '0.000',
  invoiceDiscountType: null,
  invoiceDiscountValue: null,
  costCenterId: null,
  lines: [],
  einvoice: null,
};
const liveRefreshMocks = vi.hoisted(() => ({
  holder: null as null | { userName: string; acquiredAt: string; expiresAt: string; mine: boolean },
  getInvoice: vi.fn(),
  acquire: vi.fn(),
  heartbeat: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerListAccounts: () => ok([]),
  catalogControllerListItems: () => ok({ items: [], total: 0, page: 1, pageSize: 20 }),
  companyControllerGet: () => ok({ costCentersEnabled: false }),
  partiesControllerList: (params: { q?: string }) =>
    ok({
      items: params.q?.toLowerCase().includes('missing') ? [] : [EXISTING_CUSTOMER],
      total: params.q?.toLowerCase().includes('missing') ? 0 : 1,
      page: 1,
      pageSize: 20,
    }),
  settingsControllerListTaxCategories: () => ok([]),
  warehousesControllerList: () =>
    ok([{ id: 'warehouse-1', code: 'W-1', nameAr: 'مستودع', nameEn: 'Warehouse', isActive: true }]),
  salesControllerListInvoices: () => ok({ items: [], total: 0, page: 1, pageSize: 25 }),
  salesControllerGetInvoice: liveRefreshMocks.getInvoice,
  documentLocksControllerAcquire: liveRefreshMocks.acquire,
  documentLocksControllerHeartbeat: liveRefreshMocks.heartbeat,
  documentLocksControllerRelease: liveRefreshMocks.release,
}));
vi.mock('../hooks/useDocumentLockStatus', () => ({
  useDocumentLockStatus: () => ({
    data: { holder: liveRefreshMocks.holder },
    refetch: vi.fn(),
  }),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    me: { user: { id: 'user-a' }, currentTenant: { tenantId: 'tenant-a' } },
    companyId: 'company-a',
  }),
}));
vi.mock('../components/CompanyProfileForm', () => ({
  useCompany: () => ({
    data: { costCentersEnabled: false },
    isSuccess: true,
  }),
}));
vi.mock('../hooks/useAccounts', () => ({
  selectCashBank: (rows: unknown[]) => rows,
  useAccounts: () => ({ data: [] }),
}));
vi.mock('../hooks/usePagedQuery', async (original) => ({
  ...(await original<typeof import('../hooks/usePagedQuery')>()),
  usePagedQuery: () => ({
    query: { isLoading: false, isError: false, isSuccess: true, data: { items: [], total: 0 } },
    rows: [],
    total: 0,
    search: '',
    setSearch: () => undefined,
    sortOrderOf: () => undefined,
    pagination: { current: 1, pageSize: 25, total: 0 },
    onTableChange: () => undefined,
  }),
}));
vi.mock('../components/PartyFormDialog', () => ({
  PartyFormDialog: (props: {
    open: boolean;
    initialValues?: { nameAr?: string };
    onSaved: (created: typeof NEW_CUSTOMER) => void;
  }) =>
    props.open ? (
      <div role="dialog">
        <span>{props.initialValues?.nameAr}</span>
        <button onClick={() => props.onSaved(NEW_CUSTOMER)}>Save mocked customer</button>
      </div>
    ) : null,
}));
vi.mock('../components/ItemFormDialog', () => ({ ItemFormDialog: () => null }));

const { SalesPage } = await import('./SalesPage');
let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  localStorage.clear();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

beforeEach(() => {
  liveRefreshMocks.holder = null;
  liveRefreshMocks.getInvoice.mockReset().mockImplementation(() => ok(DRAFT_INVOICE));
  liveRefreshMocks.acquire.mockReset().mockResolvedValue({});
  liveRefreshMocks.heartbeat.mockReset().mockResolvedValue({});
  liveRefreshMocks.release.mockReset().mockResolvedValue({});
});

const settle = (ms = 400) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
async function renderPage(entry: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[entry]}>
            <SalesPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  return client;
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('SalesPage customer quick-create', () => {
  it('creates a customer from the invoice picker and selects it', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() =>
      root!.render(
        <QueryClientProvider client={client}>
          <AntApp>
            <MemoryRouter initialEntries={['/sales']}>
              <SalesPage />
            </MemoryRouter>
          </AntApp>
        </QueryClientProvider>,
      ),
    );
    await settle();
    const newInvoice = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(i18n.t('sales.newInvoice')),
    )!;
    act(() => newInvoice.click());
    await settle();

    const customerInput = host.querySelector<HTMLInputElement>('.ant-select input')!;
    act(() => customerInput.focus());
    act(() => customerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    type(customerInput, 'missing customer');
    await settle(450);
    const createAction = document.querySelector<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden):not([class*="-leave"]) .grid-select-create-new',
    )!;
    act(() => createAction.click());
    expect(document.body.textContent).toContain('missing customer');

    const save = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Save mocked customer'),
    )!;
    act(() => save.click());
    await settle(50);
    expect(host.querySelector('.ant-select')?.textContent).toContain('C-2');
    expect(host.querySelector('.ant-select')?.textContent).toContain('New customer');
  });
});

describe('SalesPage live document locks', () => {
  it('shows another editor and disables Post and Edit, but not for mine or null', async () => {
    liveRefreshMocks.holder = {
      userName: 'Another editor',
      acquiredAt: '2026-01-02T03:04:00.000Z',
      expiresAt: '2026-01-02T03:06:00.000Z',
      mine: false,
    };
    await renderPage('/sales?invoiceId=invoice-1');
    await settle();
    expect(document.body.textContent).toContain('Being edited now by Another editor');
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.find((button) => button.textContent?.trim() === 'Edit')?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes('Post'))?.disabled).toBe(true);

    act(() => root?.unmount());
    root = undefined;
    host.remove();
    document.body.innerHTML = '';

    liveRefreshMocks.holder = {
      userName: 'Current editor',
      acquiredAt: '2026-01-02T03:04:00.000Z',
      expiresAt: '2026-01-02T03:06:00.000Z',
      mine: true,
    };
    await renderPage('/sales?invoiceId=invoice-1');
    await settle();
    expect(document.body.textContent).not.toContain('Being edited now by');
    expect(
      [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Edit')?.disabled,
    ).toBe(false);

    act(() => root?.unmount());
    root = undefined;
    host.remove();
    document.body.innerHTML = '';

    liveRefreshMocks.holder = null;
    await renderPage('/sales?invoiceId=invoice-1');
    await settle();
    expect(document.body.textContent).not.toContain('Being edited now by');
  });

  it('does not poll invoice details while the form screen is open', async () => {
    vi.useFakeTimers();
    await renderPage('/sales?invoiceId=invoice-1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(liveRefreshMocks.getInvoice).toHaveBeenCalledTimes(1);
    const edit = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Edit')!;
    act(() => edit.click());
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    liveRefreshMocks.getInvoice.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(liveRefreshMocks.getInvoice).not.toHaveBeenCalled();
  });
});
