// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PurchaseRequestDetailDto, PurchaseRequestListItemDto } from '@erp/api-client';
import i18n from '../i18n';
import { PERMISSIONS } from '../auth/permissions';

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

const session = vi.hoisted(() => ({
  userId: 'u1',
  roleCode: 'OWNER',
  perms: [] as string[],
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    me: { user: { id: session.userId }, currentMembership: { roleCode: session.roleCode } },
    can: (permission: string) => session.perms.includes(permission),
  }),
}));

const LIST = [
  {
    id: 'r1',
    requestNo: 'PRQ-2026-000001',
    requestDate: '2026-11-10',
    neededBy: null,
    status: 'SUBMITTED',
    _count: { lines: 2 },
  },
  {
    id: 'r2',
    requestNo: 'PRQ-2026-000002',
    requestDate: '2026-11-11',
    neededBy: '2026-11-30',
    status: 'APPROVED',
    _count: { lines: 1 },
  },
] as unknown as PurchaseRequestListItemDto[];

const line = (overrides: Record<string, unknown>) => ({
  id: 'l1',
  tenantId: 't1',
  requestId: 'r2',
  lineNo: 1,
  itemId: 'i1',
  itemUnitId: null,
  qty: '10',
  qtyBase: '10',
  estimatedPrice: null,
  note: null,
  orderedQty: '7.5',
  remainingQty: '2.5',
  createdAt: '2026-11-11T00:00:00Z',
  item: { id: 'i1', code: 'PAP-A4', nameAr: 'ورق A4', nameEn: 'A4 paper', itemKind: 'STOCK', baseUnitId: 'b1' },
  itemUnit: null,
  ...overrides,
});

const request = (overrides: Record<string, unknown>) =>
  ({
    id: 'r2',
    tenantId: 't1',
    companyId: 'c1',
    branchId: null,
    requestNo: 'PRQ-2026-000002',
    requestDate: '2026-11-11',
    neededBy: '2026-11-30',
    status: 'APPROVED',
    notes: null,
    createdBy: 'u2',
    rejectReason: null,
    cancelReason: null,
    lines: [line({})],
    quotes: [],
    orders: [],
    ...overrides,
  }) as unknown as PurchaseRequestDetailDto;

const DETAILS: Record<string, PurchaseRequestDetailDto> = {
  r1: request({ id: 'r1', requestNo: 'PRQ-2026-000001', status: 'SUBMITTED', neededBy: null, lines: [] }),
  r2: request({}),
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  procurementControllerListRequests: () =>
    ok({ items: LIST, page: 1, pageSize: 20, total: LIST.length }),
  procurementControllerGetRequest: (id: string) => ok(DETAILS[id]),
}));

const { PurchaseRequestsPage } = await import('./PurchaseRequestsPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  session.userId = 'u1';
  session.roleCode = 'OWNER';
  session.perms = [];
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  document.body.innerHTML = '';
});
afterAll(() => {
  session.perms = [];
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
          <MemoryRouter>
            <PurchaseRequestsPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const rowOf = (requestNo: string) =>
  [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(requestNo))!;
const buttonByText = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

describe('PurchaseRequestsPage', () => {
  it('lists the requests with their status', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE];
    await mount();
    expect(host.textContent).toContain(i18n.t('nav.purchaseRequests'));
    expect(rowOf('PRQ-2026-000001').textContent).toContain(i18n.t('procurement.statuses.SUBMITTED'));
    expect(rowOf('PRQ-2026-000002').textContent).toContain(i18n.t('procurement.statuses.APPROVED'));
  });

  it('shows each line’s remaining quantity and the order action to a purchase.manage holder', async () => {
    session.perms = [PERMISSIONS.PURCHASE_MANAGE];
    await mount();
    act(() => rowOf('PRQ-2026-000002').click());
    await settle();

    expect(host.textContent).toContain('PAP-A4');
    expect(host.textContent).toContain('2.5');
    expect(buttonByText(i18n.t('procurement.orderFromRequest'))).toBeDefined();
    expect(buttonByText(i18n.t('procurement.quoteFromRequest'))).toBeDefined();
  });

  it('shows no approve button to a member without purchase.approve', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE, PERMISSIONS.PURCHASE_MANAGE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    expect(buttonByText(i18n.t('procurement.approve'))).toBeUndefined();
    expect(buttonByText(i18n.t('procurement.reject'))).toBeUndefined();
    // Cancel stays: it needs purchase.manage only.
    expect(buttonByText(i18n.t('procurement.cancel'))).toBeDefined();
  });

  it('disables approve on a request the approver created, and says why', async () => {
    // Request r1 is created by u2 (the request fixture default).
    session.userId = 'u2';
    session.roleCode = 'ACCOUNTANT';
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    const approve = buttonByText(i18n.t('procurement.approve'));
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(true);
    expect(host.textContent).toContain(i18n.t('procurement.ownDocument'));
  });

  it('lets an approver approve a request someone else created', async () => {
    session.userId = 'u3';
    session.roleCode = 'ACCOUNTANT';
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    const approve = buttonByText(i18n.t('procurement.approve'));
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(false);
    expect(host.textContent).not.toContain(i18n.t('procurement.ownDocument'));
  });
});
