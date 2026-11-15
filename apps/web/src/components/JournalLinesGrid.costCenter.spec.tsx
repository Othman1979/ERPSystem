// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { JournalLinesGrid, type CostCenterColumn, type JournalLineDraft } from './JournalLinesGrid';

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

const ACCOUNT_OPTIONS = [
  { value: 'cash', label: '1101 Cash' },
  { value: 'exp', label: '5101 Expense' },
  { value: 'rev', label: '4101 Sales' },
];

const CENTRES: CostCenterColumn = {
  options: [
    { value: 'cc1', label: 'CC-1 Head office' },
    { value: 'cc2', label: 'CC-2 Branch' },
  ],
  income: new Set(['exp', 'rev']),
  required: new Set(['exp']),
};

// Row 1: an expense line with a centre. Row 2: a cash line (balance sheet).
const LINES: JournalLineDraft[] = [
  { key: 1, accountId: 'exp', debit: '5', costCenterId: 'cc1' },
  { key: 2, accountId: 'cash', credit: '5' },
];

let root: Root | undefined;
let host: HTMLDivElement;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host.remove();
  document.body.innerHTML = '';
});

const settle = (ms = 300) => act(() => new Promise((r) => setTimeout(r, ms)));

function render(props: Partial<Parameters<typeof JournalLinesGrid>[0]> = {}) {
  const onChange = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <JournalLinesGrid
        lines={LINES}
        onChange={onChange}
        accountOptions={ACCOUNT_OPTIONS}
        {...props}
      />,
    ),
  );
  return { onChange };
}

const label = (column: string, row: number) => i18n.t('ui.cellLabel', { column: i18n.t(column), line: row + 1 });
const field = (column: string, row: number) =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label(column, row)}"]`);
const cell = (row: number, col: number) => host.querySelector<HTMLTableCellElement>(`td[data-cell="${row}-${col}"]`);

/** Opens a grid select and clicks the option whose text contains `text`. */
async function pick(input: HTMLInputElement, text: string) {
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

describe('cost centre column of JournalLinesGrid', () => {
  it('has no cost centre column without the prop', () => {
    render();
    expect([...host.querySelectorAll('th')].map((th) => th.textContent)).not.toContain(i18n.t('costCenters.column'));
    expect(cell(0, 6)).toBeNull();
    expect(field('costCenters.column', 0)).toBeNull();
  });

  it('shows the column after the account column when the prop is given', () => {
    render({ costCenterColumn: CENTRES });
    const headers = [...host.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).toContain(i18n.t('costCenters.column'));
    expect(headers.indexOf(i18n.t('costCenters.column'))).toBeGreaterThan(headers.indexOf(i18n.t('journal.account')));
  });

  it('shows a centre select on income-statement rows only, a dash on balance-sheet rows', () => {
    render({ costCenterColumn: CENTRES });
    expect(field('costCenters.column', 0)).not.toBeNull();
    expect(field('costCenters.column', 1)).toBeNull();
    expect(cell(1, 6)?.textContent).toBe('—');
  });

  it('clears the centre when the account changes to a balance-sheet account', async () => {
    const { onChange } = render({ costCenterColumn: CENTRES });
    await pick(field('journal.account', 0)!, '1101 Cash');
    const next = onChange.mock.calls.at(-1)![0] as JournalLineDraft[];
    expect(next[0].accountId).toBe('cash');
    expect(next[0].costCenterId).toBeUndefined();
  });

  it('keeps the centre when the account changes to another income-statement account', async () => {
    const { onChange } = render({ costCenterColumn: CENTRES });
    await pick(field('journal.account', 0)!, '4101 Sales');
    const next = onChange.mock.calls.at(-1)![0] as JournalLineDraft[];
    expect(next[0].accountId).toBe('rev');
    expect(next[0].costCenterId).toBe('cc1');
  });

  it('marks the centre cell of a line whose account requires a centre', () => {
    render({
      costCenterColumn: CENTRES,
      lines: [{ key: 1, accountId: 'exp', debit: '5' }, { key: 2, accountId: 'rev', credit: '5' }],
    });
    // 'exp' is required (CENTRES.required), 'rev' is an income account that is not.
    expect(cell(0, 6)?.classList.contains('cell-required')).toBe(true);
    expect(field('costCenters.column', 0)?.getAttribute('aria-required')).toBe('true');
    expect(cell(1, 6)?.classList.contains('cell-required')).toBe(false);
    expect(field('costCenters.column', 1)?.getAttribute('aria-required')).toBeNull();
  });

  it('marks the cell of the missing-centre row', () => {
    render({
      costCenterColumn: CENTRES,
      lines: [{ key: 1, accountId: 'exp', debit: '5' }, LINES[1]],
      missingCostCenter: 1,
    });
    expect(cell(0, 6)?.classList.contains('cell-missing')).toBe(true);
    expect(cell(1, 6)?.classList.contains('cell-missing')).toBe(false);
  });
});
