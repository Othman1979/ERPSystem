// @vitest-environment jsdom
/**
 * The count document (ADR-030): a blind draft hides the book columns, a
 * submitted count shows them, the member who counted or created a count
 * cannot approve it, and the import's row errors are listed in plain words.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import type { StockCountDetailDto, StockCountLineDto, StockCountVarianceDto } from '@erp/api-client';

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

const ME = { user: { id: '7' }, currentMembership: { roleCode: 'MEMBER' } };
let me: unknown = ME;
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, me }),
}));

const line = (over: Partial<StockCountLineDto>): StockCountLineDto =>
  ({
    id: '1',
    countId: '9',
    itemId: '11',
    countedQty: null,
    countedUnitQty: null,
    itemUnitId: null,
    itemUnit: null,
    countedBy: null,
    countedAt: null,
    systemQty: null,
    differenceQty: null,
    item: { id: '11', code: 'A-100', nameAr: 'صنف الاختبار', nameEn: null, baseUnitId: '1' },
    ...over,
  }) as unknown as StockCountLineDto;

const detailOf = (over: Partial<StockCountDetailDto>): StockCountDetailDto =>
  ({
    id: '9',
    docNo: null,
    status: 'DRAFT',
    countDate: '2026-11-10',
    blind: false,
    scope: 'WAREHOUSE',
    includeZero: false,
    createdBy: '1',
    counterIds: [],
    description: null,
    adjustmentId: null,
    warehouse: { id: '5', code: 'W1', nameAr: 'المستودع الرئيسي' },
    lines: [],
    ...over,
  }) as unknown as StockCountDetailDto;

let detail: StockCountDetailDto;
let variance: StockCountVarianceDto;

vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  stockDocumentsControllerGetCount: () => ok(detail),
  stockDocumentsControllerCountVariance: () => ok(variance),
  catalogControllerGetItem: () => ok({ id: '11', baseUnit: { code: 'PCS', nameAr: 'قطعة' }, units: [] }),
  catalogControllerListItems: () => ok({ items: [], page: 1, pageSize: 20, total: 0 }),
  warehousesControllerList: () => ok([]),
}));

const { CountDocument } = await import('./CountDocument');
const { CountImportErrors } = await import('./CountImportErrors');

let root: Root | undefined;
let host: HTMLDivElement;
let client: QueryClient;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  me = ME;
  variance = {
    countId: '9',
    docNo: null,
    status: 'SUBMITTED',
    warehouse: { code: 'W1', nameAr: 'المستودع الرئيسي' },
    countDate: '2026-11-10',
    lines: [],
    uncounted: [],
    totals: {
      shortageQty: '0',
      surplusQty: '0',
      shortageValue: '0.000',
      surplusValue: '0.000',
      netValue: '0.000',
      countedLines: 0,
      uncountedLines: 0,
    },
  } as StockCountVarianceDto;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
  client.clear();
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

async function render(ui: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>{ui}</MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const headers = () => [...document.querySelectorAll('th')].map((th) => th.textContent?.trim() ?? '');
const buttonNamed = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

describe('a blind draft hides the book (ADR-030 §6)', () => {
  it('shows no system qty or difference column while the API withholds them', async () => {
    detail = detailOf({
      blind: true,
      lines: [line({ id: '1', countedQty: '2', countedUnitQty: '2', systemQty: null, differenceQty: null })],
    });
    await render(<CountDocument id="9" onBack={() => {}} />);

    const names = headers();
    expect(names).toContain(i18n.t('stock.countedQty'));
    expect(names).not.toContain(i18n.t('stock.systemQty'));
    expect(names).not.toContain(i18n.t('stock.diff'));
  });

  it('shows the book and difference columns on an open draft', async () => {
    detail = detailOf({
      blind: false,
      lines: [line({ id: '1', systemQty: '10.000000', differenceQty: null })],
    });
    await render(<CountDocument id="9" onBack={() => {}} />);

    const names = headers();
    expect(names).toContain(i18n.t('stock.systemQty'));
    expect(names).toContain(i18n.t('stock.diff'));
  });
});

describe('approval rights in the submitted state (ADR-030 §3)', () => {
  const submitted = (over: Partial<StockCountDetailDto>) =>
    detailOf({
      status: 'SUBMITTED',
      createdBy: '1',
      counterIds: ['7'],
      lines: [line({ id: '1', countedQty: '5', countedUnitQty: '5', systemQty: '5.000000', differenceQty: '0', countedBy: '7' })],
      ...over,
    });

  it('hides the approve action from the member who counted a line', async () => {
    detail = submitted({});
    await render(<CountDocument id="9" onBack={() => {}} />);

    const approve = buttonNamed('Approve');
    expect(approve).toBeDefined();
    expect(approve!.disabled).toBe(true);
  });

  it('hides the approve action from the member who created the count', async () => {
    me = { user: { id: '1' }, currentMembership: { roleCode: 'MEMBER' } };
    detail = submitted({ createdBy: '1' });
    await render(<CountDocument id="9" onBack={() => {}} />);

    expect(buttonNamed('Approve')!.disabled).toBe(true);
  });

  it('lets the owner approve a count they counted', async () => {
    me = { user: { id: '8' }, currentMembership: { roleCode: 'OWNER' } };
    detail = submitted({ createdBy: '1' });
    await render(<CountDocument id="9" onBack={() => {}} />);

    expect(buttonNamed('Approve')!.disabled).toBe(false);
  });

  it('lets a member who neither counted nor created the count approve it', async () => {
    me = { user: { id: '9' }, currentMembership: { roleCode: 'MEMBER' } };
    detail = submitted({ createdBy: '1' });
    await render(<CountDocument id="9" onBack={() => {}} />);

    expect(buttonNamed('Approve')!.disabled).toBe(false);
  });
});

describe('import errors (ADR-030 §11)', () => {
  it('lists each refused row with its reason in words, and says nothing was imported', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <AntApp>
          <CountImportErrors
            rows={[
              { row: 3, reason: 'UNKNOWN_ITEM: no active stock item with this code or barcode' },
              { row: 7, reason: 'DUPLICATE: the same item is on row 2' },
            ]}
            onClose={() => {}}
          />
        </AntApp>,
      ),
    );
    await settle(100);

    const dialog = document.querySelector('.ant-modal-content');
    expect(dialog).not.toBeNull();
    const text = dialog!.textContent ?? '';
    expect(text).toContain('Nothing was imported');
    expect(text).toContain('2 problem(s) found');
    expect(text).toContain('Unknown or inactive item');
    expect(text).toContain('The item appears twice in the sheet');
    const rows = [...dialog!.querySelectorAll('tbody tr')].map((tr) => tr.textContent ?? '');
    expect(rows.some((r) => r.startsWith('3'))).toBe(true);
    expect(rows.some((r) => r.startsWith('7'))).toBe(true);
  });
});
