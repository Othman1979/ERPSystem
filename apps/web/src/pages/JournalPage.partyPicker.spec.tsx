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

const createDraft = vi.fn();
const listMappings = vi.fn();
const ok = <T,>(data: T) => Promise.resolve({ data, status: 200, headers: new Headers() });

const account = (id: string, code: string, flags: { isControl?: boolean; controlType?: string | null } = {}) => ({
  id,
  tenantId: '1',
  companyId: '1',
  code,
  nameAr: `acc${code}`,
  nameEn: `acc${code}`,
  parentId: null,
  level: 2,
  accountType: 'ASSET',
  normalBalance: 'DEBIT',
  isPostable: true,
  isControl: flags.isControl ?? false,
  controlType: flags.controlType ?? null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
});
const ACCOUNTS = [
  account('11', '1101', { controlType: 'CASH' }),
  account('13', '1103', { isControl: true, controlType: 'CUSTOMERS' }),
  account('21', '2101', { isControl: true, controlType: 'SUPPLIERS' }),
  account('41', '4101'),
  account('19', '1109'), // plain flags: a legacy chart maps it as CUSTOMERS_CONTROL in one test
];
const CUSTOMER = { id: '7', code: 'C-7', nameAr: 'cust7', nameEn: 'cust7', partyType: 'CUSTOMER', isActive: true };

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  accountingControllerListAccounts: () => ok(ACCOUNTS),
  accountingControllerListMappings: () => listMappings(),
  journalControllerList: () => ok({ items: [], total: 0, page: 1, pageSize: 25 }),
  partiesControllerList: (params: { partyType?: string }) =>
    ok({ items: params.partyType === 'CUSTOMER' ? [CUSTOMER] : [], total: 0, page: 1, pageSize: 20 }),
  partiesControllerGet: () => ok(CUSTOMER),
  journalControllerCreateDraft: (...args: unknown[]) => createDraft(...args),
}));

const { JournalPage } = await import('./JournalPage');

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  createDraft.mockReset();
  createDraft.mockReturnValue(new Promise(() => {})); // the save itself is not under test
  listMappings.mockReset();
  listMappings.mockImplementation(() => ok([]));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 400) => act(() => new Promise((r) => setTimeout(r, ms)));

async function openNewEntry() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          {/* ?new=1 opens the new-entry form directly (useNewFromUrl). */}
          <MemoryRouter initialEntries={['/journal?new=1']}>
            <JournalPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const label = (column: string, row: number) => i18n.t('ui.cellLabel', { column: i18n.t(column), line: row + 1 });
const field = (column: string, row: number) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label(column, row)}"]`);

/** Opens a grid select and clicks the option whose text contains `text`. */
async function pick(input: HTMLInputElement, text: string) {
  act(() => input.focus());
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  });
  await settle(50);
  // The open list: earlier lists stay in the document, hidden or still leaving (antd gives
  // every select the same id under test, so aria-controls cannot tell them apart).
  const open = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden):not([class*="-leave"])');
  expect(open).toHaveLength(1);
  const option = [...open[0].querySelectorAll<HTMLElement>('.ant-select-item-option')].find((o) =>
    o.textContent?.includes(text),
  );
  if (!option) throw new Error(`no option "${text}"`);
  act(() => option.click());
  await settle(50);
}

/** Types into an antd InputNumber (React reads the native value setter). */
function type(input: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSave() {
  const save = [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(i18n.t('journal.saveDraft')),
  );
  if (!save) throw new Error('no save button');
  act(() => save.click());
}

describe('JournalPage: party picker on control-account lines (D-2)', () => {
  it('shows the picker only on customers / suppliers lines', async () => {
    await openNewEntry();
    await pick(field('journal.account', 0)!, '1103');
    await pick(field('journal.account', 1)!, '1101');
    expect(field('journal.party', 0)).not.toBeNull();
    expect(field('journal.party', 0)!.closest('.ant-select')?.textContent).toContain(i18n.t('journal.pickCustomer'));
    expect(field('journal.party', 1)).toBeNull();

    // Another kind of control account asks for the other side; a plain account drops the picker.
    await pick(field('journal.account', 1)!, '2101');
    expect(field('journal.party', 1)!.closest('.ant-select')?.textContent).toContain(i18n.t('journal.pickSupplier'));
    await pick(field('journal.account', 1)!, '4101');
    expect(field('journal.party', 1)).toBeNull();
  });

  it('blocks saving a customers line without a customer and marks the cell; saves once one is picked', async () => {
    await openNewEntry();
    await pick(field('journal.account', 0)!, '1103');
    type(field('journal.debit', 0)!, '100');
    await pick(field('journal.account', 1)!, '4101');
    type(field('journal.credit', 1)!, '100');

    clickSave();
    await settle(50);
    expect(createDraft).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(i18n.t('journal.partyRequiredCustomer', { line: 1 }));
    const partyCell = field('journal.party', 0)!.closest('td')!;
    expect(partyCell.classList.contains('cell-missing')).toBe(true);
    expect(field('journal.party', 0)!.getAttribute('aria-invalid')).toBe('true');

    await pick(field('journal.party', 0)!, 'C-7');
    expect(partyCell.classList.contains('cell-missing')).toBe(false);
    clickSave();
    await settle(50);
    expect(createDraft).toHaveBeenCalledTimes(1);
    const body = createDraft.mock.calls[0][0] as { lines: Record<string, unknown>[] };
    expect(body.lines).toEqual([
      expect.objectContaining({ accountId: '13', debit: '100', partyType: 'CUSTOMER', partyId: '7' }),
      expect.not.objectContaining({ partyId: expect.anything() }),
    ]);
  });

  it('blocks a line with both debit and credit before it becomes a draft that cannot post', async () => {
    await openNewEntry();
    await pick(field('journal.account', 0)!, '1101');
    type(field('journal.debit', 0)!, '5');
    type(field('journal.credit', 0)!, '5');
    await pick(field('journal.account', 1)!, '4101');
    type(field('journal.credit', 1)!, '5');

    clickSave();
    await settle(50);
    expect(createDraft).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(i18n.t('journal.oneSide', { line: 1 }));
  });
});

describe('JournalPage: saving waits for the account mappings', () => {
  const saveButton = () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t('journal.saveDraft')))!;

  it('keeps save disabled, with a hint, while the mappings load', async () => {
    listMappings.mockImplementation(() => new Promise(() => {}));
    await openNewEntry();
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain(i18n.t('journal.rulesLoading'));
  });

  it('shows the failure with a retry, then applies the legacy mapping once loaded', async () => {
    listMappings.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    listMappings.mockImplementation(() => ok([{ mappingKey: 'CUSTOMERS_CONTROL', accountId: '19', account: null }]));
    await openNewEntry();
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain(i18n.t('journal.rulesFailed'));

    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(i18n.t('common.retry')))!;
    act(() => retry.click());
    await settle();
    expect(saveButton().disabled).toBe(false);
    expect(host.textContent).not.toContain(i18n.t('journal.rulesFailed'));

    // The mapped account now asks for a customer, and saving without one is blocked.
    await pick(field('journal.account', 0)!, '1109');
    expect(field('journal.party', 0)!.closest('.ant-select')?.textContent).toContain(i18n.t('journal.pickCustomer'));
    type(field('journal.debit', 0)!, '10');
    await pick(field('journal.account', 1)!, '4101');
    type(field('journal.credit', 1)!, '10');
    clickSave();
    await settle(50);
    expect(createDraft).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(i18n.t('journal.partyRequiredCustomer', { line: 1 }));
  });
});
