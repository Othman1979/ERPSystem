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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    me: { user: { id: 'u1' }, currentMembership: { roleCode: 'OWNER', approvalLimit: null, permissions: [] } },
  }),
}));

// Cost centres are enabled for the company: the GIN form shows its centre field.
const costCentre = { id: 'cc-1', code: 'CC1', nameAr: 'قسم المبيعات', nameEn: 'Sales dept', parentId: null, isPostable: true, isActive: true };
vi.mock('../hooks/useCostCenters', async (original) => ({
  ...(await original<typeof import('../hooks/useCostCenters')>()),
  useCostCenters: () => ({ enabled: true, rows: [costCentre], nameOf: () => undefined }),
}));

const warehouse = { id: 'w1', code: 'W1', nameAr: 'المستودع الرئيسي', nameEn: 'Main warehouse' };
const item = { id: 'it1', code: 'I1', nameAr: 'صنف اختبار', nameEn: 'Test item', itemKind: 'STOCK', purchasePrice: null };
const expenseAccount = {
  id: 'acc-exp',
  code: '5100',
  nameAr: 'مصروف الشحن',
  nameEn: 'Freight expense',
  accountType: 'EXPENSE',
  isPostable: true,
  isActive: true,
};

const goodsNotesCreate = vi.fn((..._args: unknown[]) => ok({ id: 'gn-1' }));

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  goodsNotesControllerList: () => ok({ items: [], page: 1, pageSize: 50, total: 0 }),
  goodsNotesControllerCreate: (...args: unknown[]) => goodsNotesCreate(...args),
  warehousesControllerList: () => ok([warehouse]),
  catalogControllerListItems: () => ok({ items: [item], total: 1, page: 1, pageSize: 20 }),
  accountingControllerListAccounts: () => ok([expenseAccount]),
}));

const { GoodsNotesSection } = await import('./GoodsNotesPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  goodsNotesCreate.mockClear();
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

/** Opens the new-voucher form of the given type, as the list's "new" menu does. */
async function mountNew(noteType: 'GRN' | 'GIN') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter initialEntries={['/goods-notes']}>
            <GoodsNotesSection requestVoucher={noteType} onVoucherHandled={() => {}} />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const buttonStartingWith = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim().startsWith(label));

/** The grid cell labelled as the page labels it (`ui.cellLabel`). */
const cellInput = (column: string, row: number) =>
  host.querySelector<HTMLInputElement>(
    `input[aria-label="${i18n.t('ui.cellLabel', { column: i18n.t(column), line: row + 1 })}"]`,
  );

/** Types into an antd InputNumber or Input (React reads the native value setter). */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
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

const fieldInput = (field: string) =>
  host.querySelector<HTMLInputElement>(`[data-field="${field}"] input`);

describe('GoodsNotesPage: the GIN account and cost centre', () => {
  it('shows the expense account and cost centre fields on a GIN', async () => {
    await mountNew('GIN');
    expect(host.querySelector('[data-field="expenseAccount"]')).not.toBeNull();
    expect(host.querySelector('[data-field="costCenter"]')).not.toBeNull();
  });

  it('hides them on a GRN', async () => {
    await mountNew('GRN');
    expect(host.querySelector('[data-field="expenseAccount"]')).toBeNull();
    expect(host.querySelector('[data-field="costCenter"]')).toBeNull();
  });

  it('saves a GIN with the chosen expense account and cost centre', async () => {
    await mountNew('GIN');
    await pick(fieldInput('warehouse')!, 'Main warehouse');
    await pick(cellInput('items.title', 0)!, 'Test item');
    type(cellInput('stock.qty', 0)!, '2');
    await pick(fieldInput('expenseAccount')!, 'Freight expense');
    await pick(fieldInput('costCenter')!, 'Sales dept');

    act(() => buttonStartingWith(i18n.t('journal.saveDraft'))!.click());
    await settle();

    expect(goodsNotesCreate).toHaveBeenCalledTimes(1);
    const body = goodsNotesCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(body.noteType).toBe('GIN');
    expect(body.expenseAccountId).toBe('acc-exp');
    expect(body.costCenterId).toBe('cc-1');
  });
});
