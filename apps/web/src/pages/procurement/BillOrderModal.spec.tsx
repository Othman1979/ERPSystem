// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseOrderBillableDto, PurchaseOrderDetailDto } from '@erp/api-client';
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

/** Two receipt lines: the first priced at the order, the second below it. */
const BILLABLE: PurchaseOrderBillableDto = {
  orderId: 'o1',
  orderNo: 'PO-1',
  status: 'PARTIALLY_RECEIVED',
  supplierId: 's1',
  warehouseId: 'w1',
  costCenterId: null,
  orderPricesIncludeTax: false,
  pricesIncludeTax: false,
  lines: [
    {
      grnLineId: 'g1',
      grnId: 'grn1',
      grnDocNo: 'GRN-1',
      item,
      poLineId: 'p1',
      poLineNo: 1,
      receivedQty: '10',
      billedQty: '4',
      unbilledQty: '6',
      receiptUnitCost: '9',
      orderUnitPrice: '10',
      orderDiscountPct: '0',
      orderNetUnitPrice: '10.000000',
      defaultUnitCost: '10',
      defaultDiscountPct: '0',
      taxCategoryId: null,
      taxRate: '0',
    },
    {
      grnLineId: 'g2',
      grnId: 'grn1',
      grnDocNo: 'GRN-1',
      item: { ...item, id: 'it2', code: 'I2' },
      poLineId: 'p2',
      poLineNo: 2,
      receivedQty: '5',
      billedQty: '0',
      unbilledQty: '5',
      receiptUnitCost: '4',
      orderUnitPrice: '5',
      orderDiscountPct: '0',
      orderNetUnitPrice: '5.000000',
      defaultUnitCost: '5',
      defaultDiscountPct: '0',
      taxCategoryId: null,
      taxRate: '0',
    },
  ],
};

const order = { id: 'o1', orderNo: 'PO-1' } as unknown as PurchaseOrderDetailDto;

const billable = vi.fn((..._args: unknown[]) => ok(BILLABLE));
const bill = vi.fn((..._args: unknown[]) => ok({ id: '77' }));

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  purchasesControllerBillable: (...args: unknown[]) => billable(...args),
  purchasesControllerBill: (...args: unknown[]) => bill(...args),
}));
vi.mock('../../hooks/useAccounts', () => ({
  selectCashBank: (rows: unknown[]) => rows,
  useAccounts: () => ({ data: [] }),
}));

const { BillOrderModal } = await import('./BillOrderModal');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  billable.mockClear();
  bill.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount(onBilled = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <BillOrderModal order={order} open onClose={() => {}} onBilled={onBilled} />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return onBilled;
}

const buttonNamed = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);

/** Types into a controlled antd input the way a user does. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** The unit-cost input of the row showing the given receipt number and item code. */
function unitCostInput(itemCode: string): HTMLInputElement {
  const row = [...document.body.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(itemCode))!;
  return row.querySelectorAll<HTMLInputElement>('input[aria-label]')[2];
}

describe('BillOrderModal', () => {
  it('loads the billable lines and shows the receipt match', async () => {
    await mount();
    expect(billable).toHaveBeenCalledWith('o1', expect.anything());
    const text = document.body.textContent ?? '';
    expect(text).toContain('GRN-1');
    expect(text).toContain('I1');
    expect(text).toContain('I2');
    expect(text).not.toContain('priced above the purchase order');
  });

  it('warns when an edited invoice price is above the order price', async () => {
    await mount();
    typeInto(unitCostInput('I2'), '5.5');
    await settle(50);
    expect(document.body.textContent).toContain('1 line(s) priced above the purchase order');
    expect(document.body.textContent).toContain('Above order price');
  });

  it('posts the selected lines and reports the new invoice', async () => {
    const onBilled = await mount();
    const submit = buttonNamed('Save draft invoice')!;
    act(() => submit.click());
    await settle();
    expect(bill).toHaveBeenCalledTimes(1);
    const [id, body, options] = bill.mock.calls[0] as unknown as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(id).toBe('o1');
    expect(body.lines).toEqual([
      { grnLineId: 'g1', qty: '6', unitCost: '10', discountPct: '0' },
      { grnLineId: 'g2', qty: '5', unitCost: '5', discountPct: '0' },
    ]);
    expect(options.headers['Idempotency-Key']).toEqual(expect.any(String));
    expect(onBilled).toHaveBeenCalledWith('77');
  });
});
