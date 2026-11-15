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
const warehouse = { id: 'w1', code: 'W1', nameAr: 'المستودع الرئيسي' };

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
  supplier,
  warehouse,
  costCenter: null,
  request: null,
  lines: [],
};

const listOrders = vi.fn(() =>
  ok({ items: LIST_ITEMS, page: 1, pageSize: 20, total: LIST_ITEMS.length }),
);
const getOrder = vi.fn(() => ok(SUBMITTED_DETAIL));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  procurementControllerListOrders: () => listOrders(),
  procurementControllerGetOrder: () => getOrder(),
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
  listOrders.mockClear();
  getOrder.mockClear();
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
          <MemoryRouter initialEntries={['/purchase-orders']}>
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
});
