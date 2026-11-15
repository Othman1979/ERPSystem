// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import dayjs from 'dayjs';
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

// The write calls, mocked so each test can check its arguments and their order.
const api = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
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
  {
    id: 'r3',
    requestNo: null,
    requestDate: '2026-11-12',
    neededBy: null,
    status: 'DRAFT',
    _count: { lines: 1 },
  },
] as unknown as PurchaseRequestListItemDto[];

const ITEMS = [
  {
    id: 'i1',
    code: 'PAP-A4',
    nameAr: 'ورق A4',
    nameEn: 'A4 paper',
    isActive: true,
    itemKind: 'STOCK',
    baseUnitId: 'b1',
  },
];
const ITEM_DETAIL = {
  ...ITEMS[0],
  baseUnit: { id: 'b1', code: 'PCS', nameAr: 'قطعة', nameEn: 'Piece' },
  units: [],
};

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
    updatedBy: null,
    submittedBy: null,
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
  // A draft with one complete line, to edit and submit.
  r3: request({
    id: 'r3',
    requestNo: null,
    status: 'DRAFT',
    createdBy: 'u1',
    requestDate: '2026-11-12',
    neededBy: null,
    lines: [line({ id: 'l3', requestId: 'r3', lineNo: 1, qty: '4', orderedQty: '0', remainingQty: '4' })],
  }),
  r9: request({
    id: 'r9',
    requestNo: null,
    status: 'DRAFT',
    createdBy: 'u1',
    neededBy: null,
    lines: [line({ id: 'l9', requestId: 'r9', lineNo: 1, qty: '5', orderedQty: '0', remainingQty: '5' })],
  }),
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  procurementControllerListRequests: () =>
    ok({ items: LIST, page: 1, pageSize: 20, total: LIST.length }),
  procurementControllerGetRequest: (id: string) => ok(DETAILS[id]),
  procurementControllerCreateRequest: (...args: unknown[]) => api.create(...args),
  procurementControllerUpdateRequest: (...args: unknown[]) => api.update(...args),
  procurementControllerSubmitRequest: (...args: unknown[]) => api.submit(...args),
  procurementControllerApproveRequest: (...args: unknown[]) => api.approve(...args),
  procurementControllerRejectRequest: (...args: unknown[]) => api.reject(...args),
  catalogControllerListItems: () => ok({ items: ITEMS, page: 1, pageSize: 20, total: ITEMS.length }),
  catalogControllerGetItem: () => ok(ITEM_DETAIL),
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
  api.create.mockReset().mockImplementation(() => ok(DETAILS.r9));
  api.update.mockReset().mockImplementation(() => ok(DETAILS.r3));
  api.submit.mockReset().mockImplementation(() => ok(DETAILS.r3));
  api.approve.mockReset().mockImplementation(() => ok(DETAILS.r1));
  api.reject.mockReset().mockImplementation(() => ok(DETAILS.r1));
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
/** Button whose text contains `text`: for buttons that carry a shortcut hint. */
const buttonContaining = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
/** Confirms the open Popconfirm (rendered in the body, outside the host). */
const confirmPopconfirm = () =>
  act(() => document.querySelector<HTMLButtonElement>('.ant-popconfirm .ant-btn-primary')!.click());
/** Button in the open reason dialog's footer. */
const dialogButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
    (b) => b.textContent?.trim() === text,
  );
/** Sets an input's or textarea's value the way a user's typing does, so React sees the change. */
function typeIn(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const IDEM = { headers: { 'Idempotency-Key': expect.any(String) } };

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

  it('keeps Reject open to the author of a submitted request, while Approve stays disabled', async () => {
    session.userId = 'u2';
    session.roleCode = 'ACCOUNTANT';
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    const reject = buttonByText(i18n.t('procurement.reject'));
    expect(reject).toBeDefined();
    expect(reject!.disabled).toBe(false);
    expect(buttonByText(i18n.t('procurement.approve'))!.disabled).toBe(true);
    expect(host.textContent).toContain(i18n.t('procurement.ownDocument'));
  });

  it('saves a new request from the grid, with the body built from the lines', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE];
    await mount();
    act(() => buttonByText(i18n.t('procurement.newRequest'))!.click());
    await settle();

    // Pick the first line's item from the server search, then type its quantity.
    const itemInput = host.querySelector<HTMLInputElement>('td[data-cell="0-1"] input')!;
    act(() => {
      itemInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await settle(50);
    const option = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
      o.textContent?.includes('PAP-A4'),
    );
    act(() => option!.click());
    await settle(50);
    typeIn(host.querySelector<HTMLInputElement>('td[data-cell="0-3"] input')!, '5');
    await settle(50);

    act(() => buttonContaining(i18n.t('common.saveDraft'))!.click());
    await settle();

    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith({
      requestDate: dayjs().format('YYYY-MM-DD'),
      lines: [{ itemId: 'i1', qty: '5' }],
    });
    expect(api.update).not.toHaveBeenCalled();
  });

  it('saves the draft, then submits it with an Idempotency-Key', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE];
    await mount();
    act(() => rowOf(i18n.t('procurement.draftNo')).click());
    await settle();

    act(() => buttonByText(i18n.t('procurement.submit'))!.click());
    await settle(50);
    confirmPopconfirm();
    await settle();

    expect(api.update).toHaveBeenCalledWith('r3', {
      requestDate: '2026-11-12',
      lines: [{ itemId: 'i1', qty: '4' }],
    });
    expect(api.submit).toHaveBeenCalledWith('r3', IDEM);
    // The save happens first, so the submitted request is the saved one.
    expect(api.update.mock.invocationCallOrder[0]).toBeLessThan(api.submit.mock.invocationCallOrder[0]);
  });

  it('does not submit when the save fails', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE];
    api.update.mockReset().mockImplementation(() => Promise.reject(new Error('save failed')));
    await mount();
    act(() => rowOf(i18n.t('procurement.draftNo')).click());
    await settle();

    act(() => buttonByText(i18n.t('procurement.submit'))!.click());
    await settle(50);
    confirmPopconfirm();
    await settle();

    expect(api.update).toHaveBeenCalledTimes(1);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('approves with an Idempotency-Key', async () => {
    session.userId = 'u3';
    session.roleCode = 'ACCOUNTANT';
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    act(() => buttonByText(i18n.t('procurement.approve'))!.click());
    await settle(50);
    confirmPopconfirm();
    await settle();

    expect(api.approve).toHaveBeenCalledWith('r1', IDEM);
  });

  it('asks for a reason before rejecting, then sends it with an Idempotency-Key', async () => {
    session.userId = 'u2';
    session.roleCode = 'ACCOUNTANT';
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('PRQ-2026-000001').click());
    await settle();

    act(() => buttonByText(i18n.t('procurement.reject'))!.click());
    await settle();

    // Empty reason: nothing is sent, and the field says what is missing.
    act(() => dialogButton(i18n.t('procurement.reject'))!.click());
    await settle();
    expect(api.reject).not.toHaveBeenCalled();
    expect(document.querySelector('.ant-modal [role="alert"]')?.textContent).toBe(
      i18n.t('procurement.reasonRequired'),
    );

    typeIn(document.querySelector<HTMLTextAreaElement>('.ant-modal textarea')!, 'Duplicate order');
    act(() => dialogButton(i18n.t('procurement.reject'))!.click());
    await settle();

    expect(api.reject).toHaveBeenCalledWith('r1', { reason: 'Duplicate order' }, IDEM);
  });
});
