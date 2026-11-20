// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserMembershipDto } from '@erp/api-client';
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
const member = (id: string, roleCode: string, purchasePermissions: UserMembershipDto['purchasePermissions']): UserMembershipDto => ({
  membershipId: id,
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  user: { id: `u${id}`, email: `m${id}@a.test`, fullName: `Member ${id}`, isActive: true },
  role: { code: roleCode, nameAr: roleCode, nameEn: roleCode },
  customRole: null,
  defaultBranch: null,
  branches: [],
  purchasePermissions,
});
const ALL = [
  { code: 'purchase.direct', amountLimit: null },
  { code: 'purchase.approve', amountLimit: null },
  { code: 'stock.issue_without_request', amountLimit: null },
] as const;
const MEMBERS = [
  member('1', 'OWNER', [...ALL]),
  member('2', 'ACCOUNTANT', [{ code: 'purchase.approve', amountLimit: '1500.500' }]),
  member('3', 'CASHIER', []),
];

const session = vi.hoisted(() => ({ roleCode: 'OWNER' }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    me: { user: { id: 'u1' }, currentMembership: { roleCode: session.roleCode } },
    can: () => true,
  }),
}));
const update = vi.fn();
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  usersControllerList: () => ok(MEMBERS),
  usersControllerRoles: () => ok([]),
  usersControllerUpdatePurchasePermissions: (...args: unknown[]) => update(...args),
}));

const { UsersPage } = await import('./UsersPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  update.mockReset();
  update.mockImplementation(() => ok(MEMBERS[1]));
  session.roleCode = 'OWNER';
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
          <UsersPage />
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const rowOf = (email: string) => [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes(email))!;
const editButtons = () => [...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${i18n.t('users.purchaseEdit')}"]`)];
const dialog = () => document.querySelector<HTMLElement>('.ant-modal')!;
const checkbox = (key: string) =>
  [...dialog().querySelectorAll<HTMLLabelElement>('label.ant-checkbox-wrapper')]
    .find((l) => l.textContent?.includes(i18n.t(`users.purchaseCodes.${key}`)))!
    .querySelector<HTMLInputElement>('input')!;
const limitInput = () => dialog().querySelector<HTMLInputElement>('input[inputmode="decimal"]');
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const save = async () => {
  const button = [...dialog().querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t('common.save')))!;
  act(() => button.click());
  await settle();
};

describe('UsersPage purchase permissions (ADR-024 §3)', () => {
  it('shows each member’s permissions and limit; the owner holds all', async () => {
    await mount();
    expect(rowOf('m1@a.test').textContent).toContain(i18n.t('users.purchaseOwnerAll'));
    expect(rowOf('m2@a.test').textContent).toContain(i18n.t('users.purchaseCodes.approve'));
    expect(rowOf('m2@a.test').textContent).toContain(i18n.t('users.limitUpTo', { amount: '1,500.500' }));
    expect(rowOf('m3@a.test').textContent).toContain(i18n.t('users.purchaseNone'));
  });

  it('offers the editor to an owner, for members that are not owners', async () => {
    await mount();
    expect(editButtons()).toHaveLength(2);
    expect(rowOf('m1@a.test').querySelector(`button[aria-label="${i18n.t('users.purchaseEdit')}"]`)).toBeNull();
  });

  it('offers no editor to a non-owner', async () => {
    session.roleCode = 'ACCOUNTANT';
    await mount();
    expect(editButtons()).toHaveLength(0);
  });

  it('opens with the member’s permissions and saves the whole set with the typed limit', async () => {
    await mount();
    act(() => rowOf('m2@a.test').querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('users.purchaseEdit')}"]`)!.click());
    await settle();
    expect(checkbox('approve').checked).toBe(true);
    expect(checkbox('direct').checked).toBe(false);
    expect(limitInput()!.value).toBe('1500.500');

    act(() => checkbox('issueWithoutRequest').click());
    type(limitInput()!, '2000.25');
    await save();
    expect(update).toHaveBeenCalledWith('2', {
      permissions: [{ code: 'purchase.approve', amountLimit: '2000.25' }, { code: 'stock.issue_without_request' }],
    });
  });

  it('refuses an invalid limit before calling the API, and hides the limit without purchase.approve', async () => {
    await mount();
    act(() => rowOf('m2@a.test').querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('users.purchaseEdit')}"]`)!.click());
    await settle();
    type(limitInput()!, '1.2345');
    await save();
    expect(update).not.toHaveBeenCalled();
    // The limit field is marked in error (antd animates the message itself in, which jsdom does not run).
    expect(limitInput()!.closest('.ant-form-item')!.className).toContain('ant-form-item-has-error');

    act(() => checkbox('approve').click());
    await settle(50);
    expect(limitInput()).toBeNull();
    await save();
    expect(update).toHaveBeenCalledWith('2', { permissions: [] });
  });
});
