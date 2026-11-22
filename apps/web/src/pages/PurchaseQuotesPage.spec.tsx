// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@erp/api-client';
import i18n from '../i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// These interaction tests exercise the desktop table view.
window.matchMedia = (query: string) =>
  ({
    matches: query.includes('min-width: 768px'),
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

const offer = (quoteLineId: string, unitPrice: string, lowest: boolean, supplier = SUPPLIER('s2', 'S-2')) => ({
  quoteId: `Q-${quoteLineId}`,
  quoteNo: `RFQ-${quoteLineId}`,
  quoteLineId,
  supplier,
  qty: '10',
  unitPrice,
  discountPct: '0',
  netAmount: '0.000',
  taxAmount: '0.000',
  lineTotal: '0.000',
  pricesIncludeTax: false,
  unitTotal: unitPrice,
  lowest,
});

// Request R1: rl-1 is open with two offers, rl-2 has nothing left to order.
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
      offers: [offer('ql-1', '5.000', false, SUPPLIER('s1', 'S-1')), offer('ql-2', '4.500', true)],
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

// Two open lines: rl-1 (as above) and rl-3, which has a single lowest offer.
const TWO_OPEN = {
  ...COMPARISON,
  lines: [
    COMPARISON.lines[0],
    {
      requestLineId: 'rl-3',
      lineNo: 3,
      item: { ...ITEM, id: 'i3', code: 'P-3', nameAr: 'مشبك', nameEn: null },
      itemUnit: null,
      qty: '2',
      orderedQty: '0',
      remainingQty: '2',
      offers: [offer('ql-5', '1.000', true, SUPPLIER('s3', 'S-3'))],
    },
  ],
};

// The same request after its orders were created: nothing is left to order.
const CLOSED = {
  ...COMPARISON,
  lines: COMPARISON.lines.map((l) => ({ ...l, orderedQty: l.qty, remainingQty: '0' })),
};

const QUOTE_LINE = {
  id: 'ql-1',
  lineNo: 1,
  requestLineId: 'rl-1',
  itemId: 'i1',
  item: ITEM,
  itemUnit: null,
  qty: '10',
  unitPrice: null as string | null,
  discountPct: '0',
  netAmount: '0.000',
  taxAmount: '0.000',
  lineTotal: '0.000',
};

/** Quote Q1 for request R1; a SENT quote is waiting for its prices. */
const quoteDetail = (status: 'DRAFT' | 'SENT', unitPrice: string | null) => ({
  id: 'Q1',
  quoteNo: status === 'DRAFT' ? null : 'RFQ-1',
  status,
  quoteDate: '2026-11-02',
  validUntil: null,
  supplierId: 's1',
  supplier: SUPPLIER('s1', 'S-1'),
  requestId: 'R1',
  request: { id: 'R1', requestNo: 'PRQ-1', requestDate: '2026-11-01' },
  supplierRef: null,
  notes: null,
  cancelReason: null,
  pricesIncludeTax: false,
  netTotal: '0.000',
  taxTotal: '0.000',
  grandTotal: '0.000',
  lines: [{ ...QUOTE_LINE, unitPrice }],
});

const convert = vi.fn();
const sendQuote = vi.fn();
const receiveQuote = vi.fn();
const cancelQuote = vi.fn();

// What the mocked API answers now; tests replace these to change the data.
let comparisonResponse: () => Promise<unknown> = () => ok(COMPARISON);
let quoteResponse: () => Promise<unknown> = () => ok(quoteDetail('DRAFT', null));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  companyControllerGet: () => ok({ costCentersEnabled: false }),
  warehousesControllerList: () => ok([{ id: 'W1', code: 'MAIN', nameAr: 'المستودع الرئيسي', nameEn: null }]),
  partiesControllerList: () => ok({ items: [], page: 1, pageSize: 20, total: 0 }),
  procurementControllerListQuotes: () =>
    ok({
      items: [
        {
          id: 'Q1',
          quoteNo: 'RFQ-1',
          quoteDate: '2026-11-02',
          supplier: SUPPLIER('s1', 'S-1'),
          request: { id: 'R1', requestNo: 'PRQ-1' },
          status: 'SENT',
          grandTotal: '0.000',
        },
      ],
      page: 1,
      pageSize: 20,
      total: 1,
    }),
  procurementControllerListRequests: () =>
    ok({
      items: [{ id: 'R1', requestNo: 'PRQ-1', requestDate: '2026-11-01' }],
      page: 1,
      pageSize: 20,
      total: 1,
    }),
  procurementControllerGetRequest: () => ok({ id: 'R1', requestNo: 'PRQ-1', requestDate: '2026-11-01', lines: [] }),
  procurementControllerComparison: () => comparisonResponse(),
  procurementControllerConvertRequest: (...args: unknown[]) => convert(...args),
  procurementControllerGetQuote: () => quoteResponse(),
  procurementControllerSendQuote: (...args: unknown[]) => sendQuote(...args),
  procurementControllerReceiveQuote: (...args: unknown[]) => receiveQuote(...args),
  procurementControllerCancelQuote: (...args: unknown[]) => cancelQuote(...args),
}));

const { PurchaseQuotesPage } = await import('./PurchaseQuotesPage');

let root: Root | undefined;
let host: HTMLDivElement;
let lastSearch = '';

/** Records the address bar, so a spec can check which one-off flags were removed. */
function SearchProbe() {
  lastSearch = useLocation().search;
  return null;
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  convert.mockReset();
  convert.mockImplementation(() => ok({ orders: [{ id: 'O1' }] }));
  sendQuote.mockReset();
  sendQuote.mockImplementation(() => ok({}));
  receiveQuote.mockReset();
  receiveQuote.mockImplementation(() => ok({}));
  cancelQuote.mockReset();
  cancelQuote.mockImplementation(() => ok({}));
  comparisonResponse = () => ok(COMPARISON);
  quoteResponse = () => ok(quoteDetail('DRAFT', null));
  lastSearch = '';
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
            <SearchProbe />
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
const inputLabelled = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

/** Types into a React-controlled input or textarea by way of its native value setter. */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The OK button of the open Popconfirm (antd renders it in the document body). */
const popconfirmOk = () => document.querySelector<HTMLButtonElement>('.ant-popover .ant-btn-primary')!;
/** A button in the open modal's footer, by its label. */
const modalButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find((b) =>
    b.textContent?.includes(label),
  )!;

/** Opens quote Q1 from the list: the screen shows the quote's view. */
async function openQuote(status: 'DRAFT' | 'SENT', unitPrice: string | null = null) {
  quoteResponse = () => ok(quoteDetail(status, unitPrice));
  await mount('/purchase-quotes');
  act(() => host.querySelector<HTMLElement>('tbody tr.ant-table-row')!.click());
  await settle();
}

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
    // Each offer radio names its line.
    expect(inputLabelled(i18n.t('procurement.quotesUi.offerFor', { item: 'P-1', line: 1 }))).toBeTruthy();
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

  it('leaves a line out when it is set to not order, and disables create once the orders are made', async () => {
    comparisonResponse = () => ok(TWO_OPEN);
    convert.mockImplementation(() => {
      // The server has now ordered both lines: the comparison refetched after the create shows nothing left.
      comparisonResponse = () => ok(CLOSED);
      return ok({ orders: [{ id: 'O1' }] });
    });
    await mount('/purchase-quotes?requestId=R1');
    act(() => tabNamed(i18n.t('procurement.comparison')).click());
    await settle();

    act(() =>
      inputLabelled(i18n.t('procurement.quotesUi.skipFor', { item: 'P-1', line: 1 })).click(),
    );
    await settle();

    act(() => buttonNamed(i18n.t('procurement.createOrders')).click());
    await settle();

    expect(convert).toHaveBeenCalledTimes(1);
    expect(convert.mock.calls[0][1]).toEqual(expect.objectContaining({ selections: [{ quoteLineId: 'ql-5' }] }));
    expect(buttonNamed(i18n.t('procurement.createOrders')).disabled).toBe(true);
  });

  it('shows that a line has no quote priced yet when it has no offer', async () => {
    comparisonResponse = () => ok({ ...COMPARISON, lines: [{ ...COMPARISON.lines[0], offers: [] }] });
    await mount('/purchase-quotes?requestId=R1');
    act(() => tabNamed(i18n.t('procurement.comparison')).click());
    await settle();

    expect(host.textContent).toContain(i18n.t('procurement.quotesUi.noOfferYet'));
  });
});

describe('PurchaseQuotesPage quotes', () => {
  it('sends a draft quote with an idempotency key', async () => {
    await openQuote('DRAFT');

    act(() => buttonNamed(i18n.t('procurement.send')).click());
    await settle();
    act(() => popconfirmOk().click());
    await settle();

    expect(sendQuote).toHaveBeenCalledTimes(1);
    const [id, options] = sendQuote.mock.calls[0];
    expect(id).toBe('Q1');
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('shows the translated message when the API refuses an action from the view', async () => {
    sendQuote.mockImplementation(() => Promise.reject(new ApiError(409, 'PERIOD_CLOSED', 'raw server text')));
    await openQuote('DRAFT');

    act(() => buttonNamed(i18n.t('procurement.send')).click());
    await settle();
    act(() => popconfirmOk().click());
    await settle();

    expect(document.body.textContent).toContain(i18n.t('errors.PERIOD_CLOSED'));
    expect(document.body.textContent).not.toContain('raw server text');
  });

  it('records the prices of a sent quote with an idempotency key', async () => {
    await openQuote('SENT');

    act(() => buttonNamed(i18n.t('procurement.receive')).click());
    await settle();
    act(() => typeInto(inputLabelled(i18n.t('procurement.quotesUi.priceFor', { item: 'P-1', line: 1 })), '5.5'));
    act(() => buttonNamed(i18n.t('common.save')).click());
    await settle();

    expect(receiveQuote).toHaveBeenCalledTimes(1);
    const [id, body, options] = receiveQuote.mock.calls[0];
    expect(id).toBe('Q1');
    // The line's own discount (0) is sent as it was quoted; the price is the typed one.
    expect(body).toEqual({ lines: [{ lineId: 'ql-1', unitPrice: '5.5', discountPct: '0' }] });
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('does not record the prices while a line has no price, and shows why', async () => {
    await openQuote('SENT');

    act(() => buttonNamed(i18n.t('procurement.receive')).click());
    await settle();
    act(() => buttonNamed(i18n.t('common.save')).click());
    await settle();

    expect(receiveQuote).not.toHaveBeenCalled();
    expect(host.textContent).toContain(i18n.t('procurement.quotesUi.missingPrices'));
  });

  it('cancels only with a reason, and sends it with an idempotency key', async () => {
    await openQuote('SENT', '5.000');

    act(() => buttonNamed(i18n.t('procurement.cancel')).click());
    await settle();
    // Without a reason the call is not made.
    act(() => modalButton(i18n.t('procurement.cancel')).click());
    await settle();
    expect(cancelQuote).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(i18n.t('procurement.reasonRequired'));

    act(() => typeInto(document.querySelector<HTMLTextAreaElement>('.ant-modal textarea')!, 'Duplicate request'));
    act(() => modalButton(i18n.t('procurement.cancel')).click());
    await settle();

    expect(cancelQuote).toHaveBeenCalledTimes(1);
    const [id, body, options] = cancelQuote.mock.calls[0];
    expect(id).toBe('Q1');
    expect(body).toEqual({ reason: 'Duplicate request' });
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
  });

  it('removes the request and new-document flags from the address once they are read', async () => {
    await mount('/purchase-quotes?requestId=R1&new=1');

    // The flag opened the new quote form (its draft button is only on the form), and the address is clean.
    expect(buttonNamed(i18n.t('common.saveDraft'))).toBeTruthy();
    expect(lastSearch).toBe('');
  });
});
