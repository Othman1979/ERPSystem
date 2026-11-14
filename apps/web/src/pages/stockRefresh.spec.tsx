// @vitest-environment jsdom
/**
 * Posting from a screen refreshes stock (Wave 5A): the page is rendered with
 * a real QueryClient, a draft row's Post button is clicked and confirmed, and
 * the post mutation's onSuccess must invalidate every stock key
 * (STOCK_QUERY_KEYS) and the screen's own lists, so the cached stock queries
 * other screens hold go stale.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import i18n from '../i18n';
import { STOCK_QUERY_KEYS } from '../stockQueries';

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
const page = <T,>(items: T[]) => ok({ items, total: items.length, page: 1, pageSize: 25 });
const postGoodsNote = vi.fn();
const postSalesReturn = vi.fn();

const WAREHOUSE = { id: '5', code: 'W1', nameAr: 'مستودع', nameEn: 'Warehouse' };
const DRAFT_NOTE = {
  id: '31',
  docNo: null,
  noteType: 'GRN',
  noteDate: '2025-03-01',
  status: 'DRAFT',
  description: null,
  warehouse: WAREHOUSE,
  branch: null,
  _count: { lines: 1 },
};
const DRAFT_RETURN = {
  id: '41',
  returnNo: null,
  returnDate: '2025-03-02',
  originalInvoiceId: '9',
  originalInvoice: { id: '9', invoiceNo: 'SI-9' },
  customer: { id: '7', code: 'C-7', nameAr: 'عميل', nameEn: 'Customer' },
  refundType: 'CREDIT',
  grandTotal: '10.000',
  status: 'DRAFT',
  _count: { lines: 1 },
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  goodsNotesControllerList: () => page([DRAFT_NOTE]),
  goodsNotesControllerPost: (...args: unknown[]) => postGoodsNote(...args),
  salesControllerListInvoices: () => page([]),
  salesControllerListReturns: () => page([DRAFT_RETURN]),
  salesControllerPostReturn: (...args: unknown[]) => postSalesReturn(...args),
  warehousesControllerList: () => ok([WAREHOUSE]),
  catalogControllerListItems: () => page([]),
  partiesControllerList: () => page([]),
  settingsControllerListTaxCategories: () => ok([]),
}));

const { GoodsNotesSection } = await import('./GoodsNotesPage');
const { SalesPage } = await import('./SalesPage');

let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  for (const post of [postGoodsNote, postSalesReturn]) {
    post.mockReset();
    post.mockImplementation(() => ok({}));
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
  client.clear();
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>{ui}</MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const buttonNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

/** Clicks the row's Post button, then the confirmation's OK. */
async function postFirstDraft() {
  const post = buttonNamed(host, i18n.t('common.post'));
  if (!post) throw new Error('no Post button');
  act(() => post.click());
  await settle(100);
  const popover = document.querySelector('.ant-popover:not(.ant-popover-hidden)');
  if (!popover) throw new Error('no confirmation');
  const confirm = [...popover.querySelectorAll<HTMLButtonElement>('button')].at(-1)!;
  act(() => confirm.click());
  await settle();
}

/** Stock queries other screens hold, built as those screens build their keys. */
const OTHER_SCREENS = [
  ['stock-balances', '5', false],
  ['stock-balances', 'items-page', ['1']],
  ['stock-movements', { itemId: '1' }],
  ['stock-valuation'],
  ['item-ledger', '1', undefined, '2025-01-01', '2025-12-31'],
  ['report-item-balances', undefined, '2025-01-01', '2025-12-31'],
  ['dashboard-summary'],
];

function seedOtherScreens() {
  for (const queryKey of OTHER_SCREENS) client.setQueryData(queryKey, { seeded: true });
}

type InvalidateSpy = MockInstance<QueryClient['invalidateQueries']>;

/** The query keys invalidateQueries was called with. */
const invalidatedKeys = (spy: InvalidateSpy) =>
  spy.mock.calls.map(([filters]) => filters?.queryKey);

function expectStockRefreshed(spy: InvalidateSpy, ownKeys: unknown[][]) {
  const keys = invalidatedKeys(spy);
  for (const k of [...STOCK_QUERY_KEYS, ...ownKeys]) expect(keys).toContainEqual(k);
  for (const queryKey of OTHER_SCREENS) {
    const state = client.getQueryCache().find({ queryKey, exact: true })?.state;
    expect({ queryKey, invalidated: state?.isInvalidated }).toEqual({ queryKey, invalidated: true });
  }
}

describe('posting refreshes stock on every screen', () => {
  it('goods notes: posting a draft from the list', async () => {
    await render(<GoodsNotesSection />);
    seedOtherScreens();
    const spy = vi.spyOn(client, 'invalidateQueries');

    await postFirstDraft();

    expect(postGoodsNote).toHaveBeenCalledTimes(1);
    expect(postGoodsNote.mock.calls[0][0]).toBe('31');
    expectStockRefreshed(spy, [['goods-notes']]);
  });

  it('sales returns: posting a draft from the list', async () => {
    await render(<SalesPage />);
    const tab = [...host.querySelectorAll<HTMLElement>('.ant-tabs-tab')].find(
      (el) => el.textContent?.trim() === i18n.t('sales.returns'),
    );
    if (!tab) throw new Error('no returns tab');
    act(() => tab.querySelector<HTMLElement>('.ant-tabs-tab-btn')!.click());
    await settle();
    seedOtherScreens();
    const spy = vi.spyOn(client, 'invalidateQueries');

    await postFirstDraft();

    expect(postSalesReturn).toHaveBeenCalledTimes(1);
    expect(postSalesReturn.mock.calls[0][0]).toBe('41');
    expectStockRefreshed(spy, [['sales-returns'], ['sales-invoices']]);
  });
});
