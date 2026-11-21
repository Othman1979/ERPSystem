// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
});

const settle = (ms = 400) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
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
