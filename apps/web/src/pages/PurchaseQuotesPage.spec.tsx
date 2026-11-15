// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const ITEM = { id: 'i1', code: 'P-1', nameAr: 'ورق A4', nameEn: 'A4 paper', itemKind: 'STOCK', baseUnitId: 'u1' };
const SUPPLIER = (id: string, code: string) => ({ id, code, nameAr: `مورد ${code}`, nameEn: null });

// Request R1 has two open lines and one closed line (nothing left to order).
const COMPARISON = {
  request: { id: 'R1', requestNo: 'PRQ-1', status: 'APPROVED', requestDate: '2026-11-01' },
  lines: [
    {
      requestLineId: 'rl-1',
      lineNo: 1,
      item: ITEM,
      itemUnit: null,
      qty: '10',
      orderedQty: '0',
      remainingQty: '10',
      offers: [
        {
          quoteId: 'Q1',
          quoteNo: 'RFQ-1',
          quoteLineId: 'ql-1',
          supplier: SUPPLIER('s1', 'S-1'),
          qty: '10',
          unitPrice: '5.000',
          discountPct: '0',
          netAmount: '50.000',
          taxAmount: '0.000',
          lineTotal: '50.000',
          pricesIncludeTax: false,
          unitTotal: '5.000',
          lowest: false,
        },
        {
          quoteId: 'Q2',
          quoteNo: 'RFQ-2',
          quoteLineId: 'ql-2',
          supplier: SUPPLIER('s2', 'S-2'),
          qty: '10',
          unitPrice: '4.500',
          discountPct: '0',
          netAmount: '45.000',
          taxAmount: '0.000',
          lineTotal: '45.000',
          pricesIncludeTax: false,
          unitTotal: '4.500',
          lowest: true,
        },
      ],
    },
    {
      requestLineId: 'rl-2',
      lineNo: 2,
      item: { ...ITEM, id: 'i2', code: 'P-2', nameAr: 'حبر', nameEn: null },
      itemUnit: null,
      qty: '4',
      orderedQty: '4',
      remainingQty: '0',
      offers: [],
    },
  ],
};

const convert = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () => ok({ costCentersEnabled: false }),
  warehousesControllerList: () => ok([{ id: 'W1', code: 'MAIN', nameAr: 'المستودع الرئيسي', nameEn: null }]),
  procurementControllerListQuotes: () => ok({ items: [], page: 1, pageSize: 20, total: 0 }),
  procurementControllerListRequests: () =>
    ok({
      items: [{ id: 'R1', requestNo: 'PRQ-1', requestDate: '2026-11-01' }],
      page: 1,
      pageSize: 20,
      total: 1,
    }),
  procurementControllerGetRequest: () => ok({ id: 'R1', requestNo: 'PRQ-1', requestDate: '2026-11-01', lines: [] }),
  procurementControllerComparison: () => ok(COMPARISON),
  procurementControllerConvertRequest: (...args: unknown[]) => convert(...args),
}));

const { PurchaseQuotesPage } = await import('./PurchaseQuotesPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  convert.mockReset();
  convert.mockImplementation(() => ok({ orders: [{ id: 'O1' }] }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount(url: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[url]}>
            <PurchaseQuotesPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const tabNamed = (label: string) =>
  [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent?.includes(label))!;
const buttonNamed = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label))!;

describe('PurchaseQuotesPage comparison', () => {
  it('marks the lowest offer of each line and sends the default picks with an idempotency key', async () => {
    await mount('/purchase-quotes?requestId=R1');
    act(() => tabNamed(i18n.t('procurement.comparison')).click());
    await settle();

    // Only the lowest offer carries the badge, and it is the one picked by default.
    const badges = host.textContent!.split(i18n.t('procurement.lowest')).length - 1;
    expect(badges).toBe(1);
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="ql-2"]')!.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[type="radio"][value="ql-1"]')!.checked).toBe(false);
    // The line with nothing left to order is shown as closed.
    expect(host.textContent).toContain(i18n.t('procurement.noLinesLeft'));

    act(() => buttonNamed(i18n.t('procurement.createOrders')).click());
    await settle();

    expect(convert).toHaveBeenCalledTimes(1);
    const [requestId, body, options] = convert.mock.calls[0];
    expect(requestId).toBe('R1');
    expect(body).toEqual(
      expect.objectContaining({
        warehouseId: 'W1',
        selections: [{ quoteLineId: 'ql-2' }],
      }),
    );
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
  });
});
