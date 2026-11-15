// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueRequestDetailDto, IssueRequestListItemDto } from '@erp/api-client';
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
  userId: 'u3',
  roleCode: 'ACCOUNTANT',
  perms: [] as string[],
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    me: { user: { id: session.userId }, currentMembership: { roleCode: session.roleCode } },
    can: (permission: string) => session.perms.includes(permission),
  }),
}));

// Cost centres stay off here: the page shows the field only when the company has them.
vi.mock('../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: false, ready: true, list: {}, rows: [], nameOf: () => undefined }),
}));

// The write calls, mocked so each test can check its arguments.
const api = vi.hoisted(() => ({
  create: vi.fn(),
  approve: vi.fn(),
  issue: vi.fn(),
  post: vi.fn(),
}));

const LIST = [
  {
    id: 'r1',
    requestNo: 'IRQ-2026-000001',
    requestDate: '2026-11-10',
    status: 'SUBMITTED',
    warehouse: { id: 'w1', code: 'MAIN', nameAr: 'المستودع الرئيسي' },
    costCenter: null,
    _count: { lines: 1 },
  },
  {
    id: 'r2',
    requestNo: 'IRQ-2026-000002',
    requestDate: '2026-11-11',
    status: 'APPROVED',
    warehouse: { id: 'w1', code: 'MAIN', nameAr: 'المستودع الرئيسي' },
    costCenter: null,
    _count: { lines: 1 },
  },
] as unknown as IssueRequestListItemDto[];

const line = (overrides: Record<string, unknown>) => ({
  id: 'l2',
  tenantId: 't1',
  requestId: 'r2',
  lineNo: 1,
  itemId: 'i1',
  qty: '10',
  issuedQty: '7.5',
  remainingQty: '2.5',
  note: null,
  createdAt: '2026-11-11T00:00:00Z',
  item: { id: 'i1', code: 'PAP-A4', nameAr: 'ورق A4', nameEn: 'A4 paper', itemKind: 'STOCK', baseUnitId: 'b1' },
  ...overrides,
});

const request = (overrides: Record<string, unknown>) =>
  ({
    id: 'r2',
    tenantId: 't1',
    companyId: 'c1',
    branchId: null,
    requestNo: 'IRQ-2026-000002',
    requestDate: '2026-11-11',
    warehouseId: 'w1',
    warehouse: { id: 'w1', code: 'MAIN', nameAr: 'المستودع الرئيسي' },
    costCenter: null,
    expenseAccount: null,
    costCenterId: null,
    expenseAccountId: null,
    status: 'APPROVED',
    notes: null,
    createdBy: 'u2',
    updatedBy: null,
    submittedBy: null,
    rejectReason: null,
    cancelReason: null,
    lines: [line({})],
    ...overrides,
  }) as unknown as IssueRequestDetailDto;

const DETAILS: Record<string, IssueRequestDetailDto> = {
  r1: request({
    id: 'r1',
    requestNo: 'IRQ-2026-000001',
    status: 'SUBMITTED',
    lines: [line({ id: 'l1', requestId: 'r1', remainingQty: '4', issuedQty: '0', qty: '4' })],
  }),
  r2: request({}),
};

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  issueRequestsControllerList: () => ok({ items: LIST, page: 1, pageSize: 20, total: LIST.length }),
  issueRequestsControllerGet: (id: string) => ok(DETAILS[id]),
  issueRequestsControllerCreate: (...args: unknown[]) => api.create(...args),
  issueRequestsControllerApprove: (...args: unknown[]) => api.approve(...args),
  receivingControllerIssue: (...args: unknown[]) => api.issue(...args),
  goodsNotesControllerPost: (...args: unknown[]) => api.post(...args),
  warehousesControllerList: () => ok([{ id: 'w1', code: 'MAIN', nameAr: 'المستودع الرئيسي', isActive: true }]),
  accountingControllerListAccounts: () => ok([]),
  catalogControllerListItems: () => ok({ items: [], page: 1, pageSize: 20, total: 0 }),
}));

const { IssueRequestsPage } = await import('./IssueRequestsPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  session.userId = 'u3';
  session.roleCode = 'ACCOUNTANT';
  session.perms = [];
  api.create.mockReset().mockImplementation(() => ok(DETAILS.r2));
  api.approve.mockReset().mockImplementation(() => ok(DETAILS.r1));
  api.issue.mockReset().mockImplementation(() => ok({ id: 'n1', docNo: null, status: 'DRAFT' }));
  api.post.mockReset().mockImplementation(() => ok({ id: 'n1', status: 'POSTED' }));
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
            <IssueRequestsPage />
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
/** Confirms the open Popconfirm (rendered in the body, outside the host). */
const confirmPopconfirm = () =>
  act(() => document.querySelector<HTMLButtonElement>('.ant-popconfirm .ant-btn-primary')!.click());
/** Button in the open dialog's footer. */
const dialogButton = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
    (b) => b.textContent?.trim() === text,
  );
const IDEM = { headers: { 'Idempotency-Key': expect.any(String) } };

describe('IssueRequestsPage', () => {
  it('lists the issue requests with their status', async () => {
    session.perms = [PERMISSIONS.PURCHASE_REQUEST_MANAGE];
    await mount();
    expect(host.textContent).toContain(i18n.t('nav.issueRequests'));
    expect(rowOf('IRQ-2026-000001').textContent).toContain(i18n.t('issueRequests.statuses.SUBMITTED'));
    expect(rowOf('IRQ-2026-000002').textContent).toContain(i18n.t('issueRequests.statuses.APPROVED'));
  });

  it('approves a submitted request with an Idempotency-Key, for an approver who did not touch it', async () => {
    session.perms = [PERMISSIONS.PURCHASE_APPROVE];
    await mount();
    act(() => rowOf('IRQ-2026-000001').click());
    await settle();

    const approve = buttonByText(i18n.t('procurement.approve'));
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(false);
    act(() => approve!.click());
    await settle(50);
    confirmPopconfirm();
    await settle();

    expect(api.approve).toHaveBeenCalledWith('r1', IDEM);
  });

  it('shows the Issue action on an approved request to a stock.movement holder', async () => {
    session.perms = [PERMISSIONS.STOCK_MOVEMENT];
    await mount();
    act(() => rowOf('IRQ-2026-000002').click());
    await settle();

    expect(buttonByText(i18n.t('issueRequests.issueAction'))).toBeDefined();
    // Approve belongs to the approver, not to the issuer.
    expect(buttonByText(i18n.t('procurement.approve'))).toBeUndefined();
  });

  it('creates a draft issue note for the remaining quantity, then posts it on request', async () => {
    session.perms = [PERMISSIONS.STOCK_MOVEMENT];
    await mount();
    act(() => rowOf('IRQ-2026-000002').click());
    await settle();

    act(() => buttonByText(i18n.t('issueRequests.issueAction'))!.click());
    await settle();
    // The line's quantity starts at what remains (2.5), not at the requested 10.
    expect(document.querySelector<HTMLInputElement>('.ant-modal input[aria-label]')?.value).toBe('2.5');

    act(() => dialogButton(i18n.t('issueRequests.createIssue'))!.click());
    await settle();

    expect(api.issue).toHaveBeenCalledTimes(1);
    expect(api.issue).toHaveBeenCalledWith(
      'r2',
      { noteDate: expect.any(String), lines: [{ issueRequestLineId: 'l2', qty: '2.5' }] },
      IDEM,
    );

    act(() => dialogButton(i18n.t('issueRequests.postIssue'))!.click());
    await settle(50);
    confirmPopconfirm();
    await settle();

    expect(api.post).toHaveBeenCalledWith('n1', IDEM);
    expect(api.issue.mock.invocationCallOrder[0]).toBeLessThan(api.post.mock.invocationCallOrder[0]);
  });
});
