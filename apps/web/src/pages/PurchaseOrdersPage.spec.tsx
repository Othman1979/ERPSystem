// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** The signed-in member: a session the tests switch between an owner and an approver. */
const session = vi.hoisted(() => ({
  roleCode: 'ACCOUNTANT',
  approvalLimit: '1000' as string | null,
  permissions: ['purchase.manage', 'purchase.approve'] as string[],
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (permission: string) => session.permissions.includes(permission),
    me: {
      user: { id: 'u1' },
      currentMembership: {
        roleCode: session.roleCode,
        approvalLimit: session.approvalLimit,
        permissions: session.permissions,
      },
    },
  }),
}));
vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: false, rows: [], nameOf: () => undefined }),
}));

const supplier = { id: 's1', code: 'S1', nameAr: 'مورد الاختبار', nameEn: 'Test supplier' };
const warehouse = { id: 'w1', code: 'W1', nameAr: 'المستودع الرئيسي', nameEn: 'Main warehouse' };
const item = { id: 'it1', code: 'I1', nameAr: 'صنف اختبار', nameEn: 'Test item', itemKind: 'STOCK', purchasePrice: null };
const itemRef = { id: 'it1', code: 'I1', nameAr: 'صنف اختبار', nameEn: 'Test item', itemKind: 'STOCK', baseUnitId: 'u1' };

/** Orders as the list returns them. */
const LIST_ITEMS = [
  {
    id: '1',
    orderNo: 'PO-1',
    orderDate: '2026-11-10T00:00:00.000Z',
    supplier,
    request: null,
    status: 'APPROVED',
    grandTotal: '250.000',
  },
  {
    id: '2',
    orderNo: 'PO-2',
    orderDate: '2026-11-12T00:00:00.000Z',
    supplier,
    request: { id: 'r1', requestNo: 'REQ-7' },
    status: 'SUBMITTED',
    grandTotal: '1500.000',
  },
  {
    id: '3',
    orderNo: 'PO-3',
    orderDate: '2026-11-13T00:00:00.000Z',
    supplier,
    request: null,
    status: 'PARTIALLY_RECEIVED',
    grandTotal: '300.000',
  },
];

/** The submitted order over the approver's limit, created by someone else. */
const SUBMITTED_DETAIL = {
  id: '2',
  orderNo: 'PO-2',
  orderDate: '2026-11-12T00:00:00.000Z',
  expectedDate: null,
  supplierId: 's1',
  warehouseId: 'w1',
  costCenterId: null,
  requestId: null,
  pricesIncludeTax: false,
  status: 'SUBMITTED',
  notes: null,
  netTotal: '1300.000',
  taxTotal: '200.000',
  grandTotal: '1500.000',
  rejectReason: null,
  cancelReason: null,
  createdBy: 'u9',
  updatedBy: 'u9',
  submittedBy: 'u9',
  supplier,
  warehouse,
  costCenter: null,
  request: null,
  lines: [],
};

/** A draft with one priced line, saved by the signed-in member. */
const DRAFT_DETAIL = {
  ...SUBMITTED_DETAIL,
  id: '1',
  orderNo: null,
  status: 'DRAFT',
  createdBy: 'u1',
  updatedBy: 'u1',
  submittedBy: null,
  netTotal: '20.000',
  taxTotal: '0.000',
  grandTotal: '20.000',
  lines: [
    {
      id: 'l1',
      lineNo: 1,
      itemId: 'it1',
      item: itemRef,
      itemUnitId: null,
      itemUnit: null,
      qty: '2',
      unitPrice: '10',
      discountPct: null,
      requestLineId: null,
      netAmount: '20.000',
      taxAmount: '0.000',
      lineTotal: '20.000',
    },
  ],
};

let orderDetail: unknown = SUBMITTED_DETAIL;
/** Goods receipts the order's receipts list returns (ADR-026). */
let receiptItems: unknown[] = [];

const listOrders = vi.fn(() =>
  ok({ items: LIST_ITEMS, page: 1, pageSize: 20, total: LIST_ITEMS.length }),
);
const getOrder = vi.fn((..._args: unknown[]) => ok(orderDetail));
const createOrder = vi.fn((..._args: unknown[]) => ok({ id: '9' }));
const updateOrder = vi.fn((..._args: unknown[]) => ok({ id: '1' }));
const submitOrder = vi.fn((..._args: unknown[]) => ok({ id: '1' }));
const approveOrder = vi.fn((..._args: unknown[]) => ok({ id: '2' }));
const rejectOrder = vi.fn((..._args: unknown[]) => ok({ id: '2' }));
const cancelOrder = vi.fn((..._args: unknown[]) => ok({ id: '1' }));
const closeOrder = vi.fn((..._args: unknown[]) => ok({ id: '1' }));
const goodsNotesList = vi.fn((..._args: unknown[]) =>
  ok({ items: receiptItems, page: 1, pageSize: 50, total: receiptItems.length }),
);
const invoicesList = vi.fn((..._args: unknown[]) => ok({ items: [], page: 1, pageSize: 50, total: 0 }));

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  procurementControllerListOrders: () => listOrders(),
  procurementControllerGetOrder: (...args: unknown[]) => getOrder(...args),
  procurementControllerCreateOrder: (...args: unknown[]) => createOrder(...args),
  procurementControllerUpdateOrder: (...args: unknown[]) => updateOrder(...args),
  procurementControllerSubmitOrder: (...args: unknown[]) => submitOrder(...args),
  procurementControllerApproveOrder: (...args: unknown[]) => approveOrder(...args),
  procurementControllerRejectOrder: (...args: unknown[]) => rejectOrder(...args),
  procurementControllerCancelOrder: (...args: unknown[]) => cancelOrder(...args),
  procurementControllerCloseOrder: (...args: unknown[]) => closeOrder(...args),
  goodsNotesControllerList: (...args: unknown[]) => goodsNotesList(...args),
  purchasesControllerListInvoices: (...args: unknown[]) => invoicesList(...args),
  // The editor's pickers: a supplier, a warehouse and an item, one of each.
  partiesControllerList: () => ok({ items: [supplier], total: 1, page: 1, pageSize: 20 }),
  warehousesControllerList: () => ok([warehouse]),
  catalogControllerListItems: () => ok({ items: [item], total: 1, page: 1, pageSize: 20 }),
  catalogControllerGetItem: () =>
    ok({ ...item, baseUnit: { id: 'u1', code: 'PCS', nameAr: 'قطعة', nameEn: 'Piece' }, units: [] }),
}));

const { PurchaseOrdersPage } = await import('./PurchaseOrdersPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  session.roleCode = 'ACCOUNTANT';
  session.approvalLimit = '1000';
  session.permissions = ['purchase.manage', 'purchase.approve'];
  session.permissions = ['purchase.manage', 'purchase.approve'];
  orderDetail = SUBMITTED_DETAIL;
  receiptItems = [];
  for (const mock of [
    listOrders,
    getOrder,
    createOrder,
    updateOrder,
    submitOrder,
    approveOrder,
    rejectOrder,
    cancelOrder,
    closeOrder,
    goodsNotesList,
    invoicesList,
  ]) {
    mock.mockClear();
  }
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount(path = '/purchase-orders') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={[path]}>
            <PurchaseOrdersPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const rowOf = (text: string) => [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(text))!;
const buttonNamed = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const buttonStartingWith = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label));
const bodyText = () => document.body.textContent ?? '';

/** The OK button of the confirmation that is open (Popconfirm). */
function confirmOk() {
  const open = [...document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')].filter(
    (p) => !/-leave/.test(p.className),
  );
  const button = open[open.length - 1]?.querySelector<HTMLButtonElement>('.ant-btn-primary');
  if (!button) throw new Error('no open confirmation');
  return button;
}

/** The OK button of the open modal. */
const modalOk = () => document.querySelector<HTMLButtonElement>('.ant-modal-footer .ant-btn-primary')!;

/** The grid cell labelled as the page labels it (`ui.cellLabel`). */
const cellInput = (column: string, row: number) =>
  host.querySelector<HTMLInputElement>(
    `input[aria-label="${i18n.t('ui.cellLabel', { column: i18n.t(column), line: row + 1 })}"]`,
  );

/** Types into an antd InputNumber or Input (React reads the native value setter). */
function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Opens a select and clicks the option whose text contains `text`. */
async function pick(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await settle(50);
  const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden):not([class*="-leave"])');
  expect(open).toHaveLength(1);
  const option = [...open[0].querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
    o.textContent?.includes(text),
  );
  if (!option) throw new Error(`no option "${text}"`);
  act(() => option.click());
  await settle(50);
}

describe('PurchaseOrdersPage list', () => {
  it('renders the orders with their translated status', async () => {
    await mount();
    expect(listOrders).toHaveBeenCalled();
    expect(rowOf('PO-1').textContent).toContain(i18n.t('procurement.statuses.APPROVED'));
    expect(rowOf('PO-2').textContent).toContain(i18n.t('procurement.statuses.SUBMITTED'));
    expect(rowOf('REQ-7')).toBeDefined();
  });
});

describe('PurchaseOrdersPage approval of a submitted order', () => {
  it('disables approve and shows the needs-owner hint above the member limit', async () => {
    await mount();
    act(() => rowOf('PO-2').click());
    await settle();

    expect(host.textContent).toContain(i18n.t('procurement.needsOwner'));
    expect(buttonNamed(i18n.t('procurement.approve'))?.disabled).toBe(true);
    // Rejecting does not depend on the limit, so it stays available.
    expect(buttonNamed(i18n.t('procurement.reject'))?.disabled).toBe(false);
  });

  it('enables approve for the owner, whatever the limit', async () => {
    session.roleCode = 'OWNER';
    session.approvalLimit = null;
    session.permissions = ['purchase.manage', 'purchase.approve', 'purchase.direct'];
    await mount();
    act(() => rowOf('PO-2').click());
    await settle();

    expect(host.textContent).not.toContain(i18n.t('procurement.needsOwner'));
    expect(buttonNamed(i18n.t('procurement.approve'))?.disabled).toBe(false);
  });

  it('approves with an Idempotency-Key header once the approver confirms', async () => {
    session.approvalLimit = null;
    await mount();
    act(() => rowOf('PO-2').click());
    await settle();

    act(() => buttonNamed(i18n.t('procurement.approve'))!.click());
    await settle(50);
    act(() => confirmOk().click());
    await settle();

    expect(approveOrder).toHaveBeenCalledTimes(1);
    expect(approveOrder).toHaveBeenCalledWith('2', { headers: { 'Idempotency-Key': expect.any(String) } });
  });

  it('keeps Reject enabled for the member who created the order, and Approve disabled', async () => {
    orderDetail = { ...SUBMITTED_DETAIL, createdBy: 'u1' };
    await mount();
    act(() => rowOf('PO-2').click());
    await settle();

    expect(host.textContent).toContain(i18n.t('procurement.ownDocument'));
    expect(buttonNamed(i18n.t('procurement.approve'))?.disabled).toBe(true);
    expect(buttonNamed(i18n.t('procurement.reject'))?.disabled).toBe(false);
  });

  it('keeps Approve disabled for a member who last edited the order', async () => {
    session.approvalLimit = null;
    orderDetail = { ...SUBMITTED_DETAIL, createdBy: 'u9', updatedBy: 'u1' };
    await mount();
    act(() => rowOf('PO-2').click());
    await settle();

    expect(buttonNamed(i18n.t('procurement.approve'))?.disabled).toBe(true);
  });
});

describe('PurchaseOrdersPage cancel of an approved order', () => {
  it('cannot be confirmed with an empty reason, then cancels with the reason and an Idempotency-Key', async () => {
    orderDetail = { ...SUBMITTED_DETAIL, id: '1', orderNo: 'PO-1', status: 'APPROVED', submittedBy: 'u9' };
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    act(() => buttonNamed(i18n.t('procurement.cancel'))!.click());
    await settle(50);
    act(() => modalOk().click());
    await settle(50);

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(bodyText()).toContain(i18n.t('procurement.reasonRequired'));

    const reason = document.querySelector<HTMLTextAreaElement>('.ant-modal textarea')!;
    type(reason, 'Duplicate order');
    act(() => modalOk().click());
    await settle();

    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith(
      '1',
      { reason: 'Duplicate order' },
      { headers: { 'Idempotency-Key': expect.any(String) } },
    );
  });
});

/** An approved order with one line: 5 ordered, 2 received (base units). */
const APPROVED_LINE = {
  id: 'l1',
  lineNo: 1,
  itemId: 'it1',
  item: itemRef,
  itemUnitId: null,
  itemUnit: null,
  qty: '5',
  qtyBase: '5',
  receivedQty: '2',
  unitPrice: '10',
  discountPct: '0',
  netAmount: '50.000',
  taxAmount: '0.000',
  lineTotal: '50.000',
};

const APPROVED_DETAIL = {
  ...SUBMITTED_DETAIL,
  id: '1',
  orderNo: 'PO-1',
  status: 'APPROVED',
  submittedBy: 'u9',
  lines: [APPROVED_LINE],
};

describe('PurchaseOrdersPage receiving and closing', () => {
  it('offers receive and close on an approved order to a member with the permissions', async () => {
    session.permissions = ['purchase.manage', 'stock.movement'];
    orderDetail = APPROVED_DETAIL;
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    expect(buttonNamed(i18n.t('procurement.receiveGoods'))).toBeDefined();
    expect(buttonNamed(i18n.t('procurement.close'))).toBeDefined();
    // Billing starts only once goods were received.
    expect(buttonNamed(i18n.t('procurement.billOrderButton'))).toBeUndefined();
    expect(host.textContent).toContain(i18n.t('procurement.receivedQty'));
  });

  it('hides receive without the stock movement permission but keeps close', async () => {
    session.permissions = ['purchase.manage'];
    orderDetail = APPROVED_DETAIL;
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    expect(buttonNamed(i18n.t('procurement.receiveGoods'))).toBeUndefined();
    expect(buttonNamed(i18n.t('procurement.close'))).toBeDefined();
  });

  it('closes with a reason, cannot be confirmed empty, then sends the reason with an Idempotency-Key', async () => {
    session.permissions = ['purchase.manage'];
    orderDetail = APPROVED_DETAIL;
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    act(() => buttonNamed(i18n.t('procurement.close'))!.click());
    await settle(50);
    act(() => modalOk().click());
    await settle(50);

    expect(closeOrder).not.toHaveBeenCalled();
    expect(bodyText()).toContain(i18n.t('procurement.reasonRequired'));

    type(document.querySelector<HTMLTextAreaElement>('.ant-modal textarea')!, 'Supplier short-shipped');
    act(() => modalOk().click());
    await settle();

    expect(closeOrder).toHaveBeenCalledTimes(1);
    expect(closeOrder).toHaveBeenCalledWith(
      '1',
      { reason: 'Supplier short-shipped' },
      { headers: { 'Idempotency-Key': expect.any(String) } },
    );
  });

  it('shows the receipts of a partially received order and the bill action', async () => {
    session.permissions = ['purchase.manage', 'stock.movement'];
    receiptItems = [{ id: 'g1', docNo: 'GRN-1', noteDate: '2026-11-13', status: 'POSTED' }];
    orderDetail = { ...APPROVED_DETAIL, status: 'PARTIALLY_RECEIVED' };
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    expect(goodsNotesList).toHaveBeenCalledWith(
      expect.objectContaining({ purchaseOrderId: '1' }),
      expect.anything(),
    );
    expect(host.textContent).toContain(i18n.t('procurement.receiptsAndInvoices'));
    expect(host.textContent).toContain('GRN-1');
    expect(buttonNamed(i18n.t('procurement.billOrderButton'))).toBeDefined();
    expect(buttonNamed(i18n.t('procurement.receiveGoods'))).toBeDefined();
  });

  it('labels the partially received, received and closed statuses', async () => {
    await mount();

    expect(rowOf('PO-3').textContent).toContain(i18n.t('procurement.statuses.PARTIALLY_RECEIVED'));
    expect(i18n.t('procurement.statuses.PARTIALLY_RECEIVED')).toBe('Partially received');
    expect(i18n.t('procurement.statuses.RECEIVED')).toBe('Received');
    expect(i18n.t('procurement.statuses.CLOSED')).toBe('Closed');
  });
});

describe('PurchaseOrdersPage order editor', () => {
  it('submits a draft: saves it, then sends submit with an Idempotency-Key header', async () => {
    orderDetail = DRAFT_DETAIL;
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    act(() => buttonNamed(i18n.t('procurement.submit'))!.click());
    await settle(50);
    act(() => confirmOk().click());
    await settle();

    expect(updateOrder).toHaveBeenCalledWith('1', expect.objectContaining({ lines: [expect.objectContaining({ unitPrice: '10' })] }));
    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(submitOrder).toHaveBeenCalledWith('1', { headers: { 'Idempotency-Key': expect.any(String) } });
  });

  it('refuses a new order whose line has an item and no price: marks the cell and does not create', async () => {
    await mount('/purchase-orders?new=1');
    await pick(host.querySelector<HTMLInputElement>('[data-field="supplier"] input')!, 'Test supplier');
    await pick(host.querySelector<HTMLInputElement>('[data-field="warehouse"] input')!, 'Main warehouse');
    await pick(cellInput('procurement.item', 0)!, 'Test item');
    type(cellInput('procurement.qty', 0)!, '2');

    act(() => buttonStartingWith(i18n.t('common.saveDraft'))!.click());
    await settle();

    expect(createOrder).not.toHaveBeenCalled();
    expect(updateOrder).not.toHaveBeenCalled();
    expect(cellInput('procurement.unitPrice', 0)!.closest('.ant-input-number-status-error')).not.toBeNull();
    expect(bodyText()).toContain(i18n.t('procurement.ordersUi.priceRequired'));
  });

  it('refuses a draft whose line has no price, and does not send it', async () => {
    orderDetail = { ...DRAFT_DETAIL, lines: [{ ...DRAFT_DETAIL.lines[0], unitPrice: null }] };
    await mount();
    act(() => rowOf('PO-1').click());
    await settle();

    act(() => buttonStartingWith(i18n.t('common.save'))!.click());
    await settle();

    expect(updateOrder).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
    expect(cellInput('procurement.unitPrice', 0)!.closest('.ant-input-number-status-error')).not.toBeNull();
    expect(bodyText()).toContain(i18n.t('procurement.ordersUi.priceRequired'));
  });
});
