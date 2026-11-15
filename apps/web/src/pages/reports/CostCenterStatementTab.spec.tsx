// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';

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
const statement = vi.fn();

const CENTRE = {
  id: 'cc1',
  tenantId: '1',
  companyId: '1',
  code: 'CC1',
  nameAr: 'مبيعات',
  nameEn: 'Sales',
  parentId: null,
  isPostable: true,
  isActive: true,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  createdBy: null,
  updatedBy: null,
};

vi.mock('../../hooks/useCostCenters', () => ({
  useCostCenters: () => ({ enabled: true, ready: true, rows: [CENTRE], list: {}, nameOf: () => undefined }),
}));
vi.mock('@erp/api-client', async (original) => ({
  ...(await original<typeof import('@erp/api-client')>()),
  journalControllerCostCenterStatement: (...args: unknown[]) => statement(...args),
}));

const line = (id: string, description: string, balance: string) => ({
  lineId: id,
  entryId: `e-${id}`,
  entryNo: `JV-${id}`,
  entryDate: '2026-03-10',
  accountCode: '4101',
  accountName: 'مبيعات',
  accountNameEn: 'Sales revenue',
  sourceType: 'MANUAL',
  postingKind: 'MANUAL',
  description,
  debit: '0.000',
  credit: '10.000',
  balance,
});

/** First page carries the summary and a cursor; the second page is the last. */
const FIRST_PAGE = {
  items: [line('1', 'First line', '-10.000'), line('2', 'Second line', '-20.000')],
  nextCursor: 'cursor-2',
  summary: {
    openingBalance: '0.000',
    openingDebit: '0.000',
    openingCredit: '0.000',
    totalDebit: '0.000',
    totalCredit: '30.000',
    closingBalance: '-30.000',
    closingDebit: '0.000',
    closingCredit: '30.000',
  },
};
const SECOND_PAGE = { items: [line('3', 'Third line', '-30.000')], nextCursor: null, summary: null };

const { CostCenterStatementTab } = await import('./CostCenterStatementTab');

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderWithProviders(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <QueryClientProvider client={client}>
        <AntApp>
          <MemoryRouter>{node}</MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
}

/** Lets the queries resolve and React commit the table. */
async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Opens the centre picker and clicks the centre whose label contains `text`. */
async function pickCentre(text: string) {
  const picker = host?.querySelector<HTMLElement>(`.ant-select[aria-label="${i18n.t('costCenters.name')}"] .ant-select-selector`);
  if (!picker) throw new Error('no centre picker');
  // rc-select opens its list on mousedown on the selector.
  act(() => {
    picker.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
  await flush();
  const open = [
    ...document.querySelectorAll<HTMLElement>(
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden):not([class*="-leave"])',
    ),
  ];
  const option = open
    .flatMap((d) => [...d.querySelectorAll<HTMLElement>('.ant-select-item-option')])
    .find((o) => o.textContent?.includes(text));
  if (!option) throw new Error(`no option "${text}"`);
  act(() => option.click());
  await flush();
}

const buttonNamed = (scope: ParentNode, text: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  statement.mockReset();
});

describe('CostCenterStatementTab', () => {
  it('asks for nothing until a centre is picked', async () => {
    renderWithProviders(<CostCenterStatementTab />);
    await flush();
    expect(statement).not.toHaveBeenCalled();
    expect(host?.textContent).toContain(i18n.t('costCenters.pickCentre'));
  });

  it('loads more with the cursor of the last page and appends its rows', async () => {
    statement.mockImplementation((params: { cursor?: string }) =>
      ok(params.cursor === 'cursor-2' ? SECOND_PAGE : FIRST_PAGE),
    );
    renderWithProviders(<CostCenterStatementTab />);
    await flush();
    await pickCentre('Sales');
    await flush();

    expect(statement).toHaveBeenLastCalledWith(
      { costCenterId: 'cc1', from: undefined, to: undefined, limit: 100, cursor: undefined },
      expect.anything(),
    );
    expect(host?.textContent).toContain('First line');
    expect(host?.textContent).toContain('Second line');
    expect(host?.textContent).not.toContain('Third line');

    act(() => buttonNamed(host!, i18n.t('common.loadMore'))!.click());
    await flush();

    expect(statement).toHaveBeenLastCalledWith(
      { costCenterId: 'cc1', from: undefined, to: undefined, limit: 100, cursor: 'cursor-2' },
      expect.anything(),
    );
    // The rows already on screen stay, the next page's row is appended, and the last page has no more.
    expect(host?.textContent).toContain('First line');
    expect(host?.textContent).toContain('Second line');
    expect(host?.textContent).toContain('Third line');
    expect(buttonNamed(host!, i18n.t('common.loadMore'))).toBeUndefined();
    expect(statement).toHaveBeenCalledTimes(2);
  });
});
