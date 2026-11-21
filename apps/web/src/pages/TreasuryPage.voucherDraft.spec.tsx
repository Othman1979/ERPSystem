// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Modal } from 'antd';
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

const { createReceipt } = vi.hoisted(() => ({ createReceipt: vi.fn() }));
const party = {
  id: 'party-1',
  code: 'C-1',
  nameAr: 'Customer',
  nameEn: 'Customer',
  partyType: 'CUSTOMER',
  isActive: true,
};
const account = {
  id: 'cash-1',
  code: '101',
  nameAr: 'Cash',
  nameEn: 'Cash',
  controlType: 'CASH',
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  partiesControllerList: () =>
    Promise.resolve({ data: { items: [party], total: 1, page: 1, pageSize: 20 } }),
  salesControllerListInvoices: () =>
    Promise.resolve({ data: { items: [], total: 0, page: 1, pageSize: 100 } }),
  treasuryControllerCreateReceipt: (...args: unknown[]) => createReceipt(...args),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    me: { user: { id: 'user-a' }, currentTenant: { tenantId: 'tenant-a' } },
    companyId: 'company-a',
  }),
}));
vi.mock('../hooks/useAccounts', () => ({
  selectCashBank: (rows: unknown[]) => rows,
  useAccounts: () => ({ data: [account] }),
}));
vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: false, rows: [], nameOf: () => undefined }),
}));
vi.mock('../hooks/usePagedQuery', () => ({
  usePagedQuery: () => ({
    query: { isLoading: false, isError: false, isSuccess: true, data: { items: [], total: 0 } },
    rows: [],
    total: 0,
    search: '',
    setSearch: vi.fn(),
    sortOrderOf: () => undefined,
    pagination: { current: 1, pageSize: 25, total: 0 },
    onTableChange: vi.fn(),
  }),
}));

const { TreasuryPage } = await import('./TreasuryPage');

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
  vi.restoreAllMocks();
});

const settle = (ms = 50) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe('TreasuryPage voucher draft', () => {
  it('reuses the stored idempotency key when a restored voucher is resubmitted', async () => {
    const key = 'persisted-voucher-idempotency-key';
    localStorage.setItem(
      'erp:entry-draft:v1:user-a:tenant-a:company-a:receipt:new',
      JSON.stringify({
        savedAt: Date.now(),
        data: {
          idemKey: key,
          voucherDate: '2026-11-14',
          partyType: 'CUSTOMER',
          partyId: party.id,
          partyOption: { value: party.id, label: 'C-1 — Customer' },
          cashAccountId: account.id,
          cashAccountLabel: '101 — Cash',
          amount: '12.000',
          referenceNo: '',
          description: '',
          method: 'CASH',
          chequeNo: '',
          bankName: '',
          dueDate: null,
          allocations: [],
          autoAllocate: false,
          costCenterId: null,
        },
      }),
    );
    createReceipt.mockRejectedValue(new Error('network lost'));
    const restorePrompt = vi.spyOn(Modal, 'confirm').mockImplementation((options) => {
      options.onOk?.();
      return { destroy: vi.fn() } as unknown as ReturnType<typeof Modal.confirm>;
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <AntApp>
            <MemoryRouter initialEntries={['/treasury?tab=receipts']}>
              <TreasuryPage />
            </MemoryRouter>
          </AntApp>
        </QueryClientProvider>,
      ),
    );
    await settle();

    const newReceipt = [...host.querySelectorAll('button')].find((button) =>
      button.textContent?.includes(i18n.t('treasury.newReceipt')),
    )!;
    act(() => newReceipt.click());
    await settle();
    expect(restorePrompt).toHaveBeenCalled();

    const save = () => host.querySelector<HTMLButtonElement>('.doc-toolbar-actions button')!;
    act(() => save().click());
    await settle();
    act(() => save().click());
    await settle();

    expect(createReceipt).toHaveBeenCalledTimes(2);
    const options = createReceipt.mock.calls.map((call) => call[1]);
    expect(options).toEqual([
      { headers: { 'Idempotency-Key': key } },
      { headers: { 'Idempotency-Key': key } },
    ]);
  });
});
