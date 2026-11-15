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

/** The signed-in member: a session the tests switch between an owner and an approver, and between users. */
const session = vi.hoisted(() => ({
  userId: 'u1',
  roleCode: 'ACCOUNTANT',
  permissions: ['purchase.manage', 'purchase.approve'] as string[],
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (permission: string) => session.permissions.includes(permission),
    me: {
      user: { id: session.userId },
      currentMembership: { roleCode: session.roleCode, approvalLimit: null, permissions: session.permissions },
    },
  }),
}));
vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: false, rows: [], nameOf: () => undefined }),
}));

const supplier = { id: 's1', code: 'S1', nameAr: 'مورد الاختبار', nameEn: 'Test supplier' };

/** A draft bill made from purchase order PO-7, one line priced above the order. */
const ORDER_DRAFT = {
  id: 'inv-1',
  invoiceNo: 'PI-1',
  invoiceDate: '2026-11-14T00:00:00.000Z',
  dueDate: null,
  supplierId: 's1',
  supplierInvoiceNo: 'SUP-9',
  supplierInvoiceDate: null,
  warehouseId: 'w1',
  paymentType: 'CREDIT',
  pricesIncludeTax: false,
  cashAccountId: null,
  costCenterId: null,
  status: 'DRAFT',
  description: null,
  netTotal: '120.000',
  taxTotal: '0.000',
  grandTotal: '120.000',
  paidAmount: '0.000',
  journalEntryId: null,
  receivedGrnId: null,
  purchaseOrderId: 'po-7',
  purchaseOrder: { id: 'po-7', orderNo: 'PO-7' },
  priceApprovedAt: null,
  priceApprovedBy: null,
  postedAt: null,
  postedBy: null,
  createdAt: '2026-11-14T08:00:00.000Z',
  updatedAt: '2026-11-14T08:00:00.000Z',
  createdBy: 'u9',
  updatedBy: 'u9',
  supplier,
  lines: [],
  priceAboveOrderLines: [
    { lineNo: 1, grnLineId: 'grn-l1', invoiceNetUnitPrice: '12.000000', orderNetUnitPrice: '10.000000' },
  ],
};

/** A draft typed by hand, not billed from an order. */
const PLAIN_DRAFT = {
  ...ORDER_DRAFT,
  id: 'inv-2',
  invoiceNo: 'PI-2',
  purchaseOrderId: null,
  purchaseOrder: null,
  priceAboveOrderLines: [],
  createdBy: 'u1',
  updatedBy: 'u1',
};

let invoiceDetail: unknown = ORDER_DRAFT;
const LIST_ITEMS = [
  {
    id: 'inv-1',
    invoiceNo: 'PI-1',
    invoiceDate: '2026-11-14T00:00:00.000Z',
    supplier,
    paymentType: 'CREDIT',
    grandTotal: '120.000',
    paidAmount: '0.000',
    status: 'DRAFT',
  },
  {
    id: 'inv-2',
    invoiceNo: 'PI-2',
    invoiceDate: '2026-11-14T00:00:00.000Z',
    supplier,
    paymentType: 'CREDIT',
    grandTotal: '60.000',
    paidAmount: '0.000',
    status: 'DRAFT',
  },
];

const listInvoices = vi.fn((..._args: unknown[]) =>
  ok({ items: LIST_ITEMS, page: 1, pageSize: 20, total: LIST_ITEMS.length }),
);
/** The order-billed draft (PI-1) is `invoiceDetail`; PI-2 is the plain draft. */
const getInvoice = vi.fn((...args: unknown[]) => ok(args[0] === 'inv-2' ? PLAIN_DRAFT : invoiceDetail));
const approvePrice = vi.fn((..._args: unknown[]) => ok({ id: 'inv-1' }));
const emptyList = () => ok({ items: [], page: 1, pageSize: 50, total: 0 });

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  purchasesControllerListInvoices: (...args: unknown[]) => listInvoices(...args),
  purchasesControllerGetInvoice: (...args: unknown[]) => getInvoice(...args),
  purchasesControllerApprovePrice: (...args: unknown[]) => approvePrice(...args),
  purchasesControllerListReturns: () => emptyList(),
  warehousesControllerList: () => ok([]),
  settingsControllerListTaxCategories: () => ok([]),
  accountingControllerListAccounts: () => ok([]),
  partiesControllerList: () => emptyList(),
  catalogControllerListItems: () => emptyList(),
}));

const { PurchasesPage } = await import('./PurchasesPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  session.userId = 'u1';
  session.roleCode = 'ACCOUNTANT';
  session.permissions = ['purchase.manage', 'purchase.approve'];
  invoiceDetail = ORDER_DRAFT;
  for (const mock of [listInvoices, getInvoice, approvePrice]) mock.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={['/purchases']}>
            <PurchasesPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

/** Opens the invoice's view from the list. */
async function openInvoice(invoiceNo: string) {
  const row = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(invoiceNo))!;
  act(() => row.click());
  await settle();
}

const buttonNamed = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label);
const bodyText = () => document.body.textContent ?? '';
const approveLabel = () => i18n.t('billing.approvePrice');

/** The OK button of the confirmation that is open (Popconfirm). */
function confirmOk() {
  const open = [...document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)')].filter(
    (p) => !/-leave/.test(p.className),
  );
  const button = open[open.length - 1]?.querySelector<HTMLButtonElement>('.ant-btn-primary');
  if (!button) throw new Error('no open confirmation');
  return button;
}

describe('PurchasesPage: approve the price difference of a bill', () => {
  it('shows the approve button to an approver on a draft with lines above the order', async () => {
    await mount();
    await openInvoice('PI-1');
    const button = buttonNamed(approveLabel());
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(false);
  });

  it('approving confirms, calls the API with an Idempotency-Key, and refetches the invoice', async () => {
    await mount();
    await openInvoice('PI-1');
    act(() => buttonNamed(approveLabel())!.click());
    await settle(100);
    act(() => confirmOk().click());
    await settle();
    expect(approvePrice).toHaveBeenCalledTimes(1);
    const [id, options] = approvePrice.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(id).toBe('inv-1');
    expect(options.headers['Idempotency-Key']).toBeTruthy();
  });

  it('hides the approve button when no line is priced above the order', async () => {
    invoiceDetail = { ...ORDER_DRAFT, priceAboveOrderLines: [] };
    await mount();
    await openInvoice('PI-1');
    expect(buttonNamed(approveLabel())).toBeUndefined();
    expect(bodyText()).not.toContain(i18n.t('billing.needsApproval', { count: 1 }));
  });

  it('disables the approve button for the creator who is not the owner, with the reason', async () => {
    session.userId = 'u9';
    await mount();
    await openInvoice('PI-1');
    const button = buttonNamed(approveLabel());
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    expect(bodyText()).toContain(i18n.t('procurement.ownDocument'));
  });

  it('keeps the approve button enabled for the owner even when the owner created the bill', async () => {
    session.userId = 'u9';
    session.roleCode = 'OWNER';
    await mount();
    await openInvoice('PI-1');
    expect(buttonNamed(approveLabel())!.disabled).toBe(false);
  });

  it('hides the approve button from a user without the approve permission', async () => {
    session.permissions = ['purchase.manage'];
    await mount();
    await openInvoice('PI-1');
    expect(buttonNamed(approveLabel())).toBeUndefined();
  });

  it('shows the post-blocked warning with each line, and the order-billed hint', async () => {
    await mount();
    await openInvoice('PI-1');
    expect(bodyText()).toContain(i18n.t('billing.needsApproval', { count: 1 }));
    expect(bodyText()).toContain(
      i18n.t('billing.priceLineDetail', { lineNo: 1, invoicePrice: '12.000000', orderPrice: '10.000000' }),
    );
    expect(bodyText()).toContain(i18n.t('billing.editFromOrderHint'));
  });

  it('hides the Edit button of a draft billed from an order, and shows it for a plain draft', async () => {
    await mount();
    await openInvoice('PI-1');
    expect(buttonNamed(i18n.t('common.edit'))).toBeUndefined();
    expect(bodyText()).toContain(i18n.t('billing.editFromOrderHint'));
  });

  it('shows the Edit button of a plain draft and no order hint', async () => {
    await mount();
    await openInvoice('PI-2');
    expect(buttonNamed(i18n.t('common.edit'))).toBeDefined();
    expect(bodyText()).not.toContain(i18n.t('billing.editFromOrderHint'));
  });
});
