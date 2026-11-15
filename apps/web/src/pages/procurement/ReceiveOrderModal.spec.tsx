// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import dayjs from 'dayjs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseOrderDetailDto } from '@erp/api-client';
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

const item = { id: 'it1', code: 'I1', nameAr: 'صنف', nameEn: 'Test item' };

/** An approved order with one line: 10 ordered, 4 already received, so 6 are left. */
const order = {
  id: 'o1',
  orderNo: 'PO-1',
  status: 'APPROVED',
  lines: [{ id: 'p1', lineNo: 1, itemId: 'it1', item, qtyBase: '10', receivedQty: '4' }],
} as unknown as PurchaseOrderDetailDto;

const receive = vi.fn((..._args: unknown[]) => ok({ id: 'g9', docNo: 'GRN-9', status: 'POSTED' }));
const post = vi.fn((..._args: unknown[]) => ok({ id: 'g9', status: 'POSTED' }));

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  receivingControllerReceive: (...args: unknown[]) => receive(...args),
  goodsNotesControllerPost: (...args: unknown[]) => post(...args),
}));

const { ReceiveOrderModal } = await import('./ReceiveOrderModal');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  receive.mockClear();
  post.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount(onDone = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <ReceiveOrderModal order={order} open onClose={() => {}} onDone={onDone} />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return onDone;
}

const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

/** The receive quantity input of the first order line. */
const qtyInput = () => document.querySelector<HTMLInputElement>('.ant-table-tbody input')!;

/** Types into a controlled antd input the way a user does. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('ReceiveOrderModal', () => {
  it('starts each line at what is still left to receive', async () => {
    await mount();
    expect(qtyInput().value).toBe('6');
  });

  it('receives in one call with the typed quantities and an idempotency key, and never posts a draft', async () => {
    const onDone = await mount();
    act(() => buttonNamed('Record receipt')!.click());
    await settle();

    expect(receive).toHaveBeenCalledTimes(1);
    const [id, body, options] = receive.mock.calls[0] as unknown as [
      string,
      { noteDate: string; lines: { poLineId: string; qty: string }[] },
      { headers: Record<string, string> },
    ];
    expect(id).toBe('o1');
    expect(body).toEqual({ noteDate: dayjs().format('YYYY-MM-DD'), lines: [{ poLineId: 'p1', qty: '6' }] });
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(post).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('refuses a quantity above what is left and does not call the API', async () => {
    const onDone = await mount();
    typeInto(qtyInput(), '7');
    await settle(50);
    expect(document.body.textContent).toContain('above what is left');

    act(() => buttonNamed('Record receipt')!.click());
    await settle();
    expect(receive).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });
});
