// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import '../i18n';
import { InvoiceLinesGrid, type InvoiceItemOption, type InvoiceLineDraft } from './InvoiceLinesGrid';
import { emptyLine, JournalLinesGrid, type JournalLineDraft } from './JournalLinesGrid';
import i18n from '../i18n';

vi.mock('./CompanyProfileForm', () => ({
  useCompany: () => ({ data: { pricesIncludeTax: false } }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

function render(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

describe('line keys after draft restore', () => {
  it('adds a unique journal line key after the restored lines replace the initial lines', () => {
    const onChange = vi.fn();
    const initial = [emptyLine(1), emptyLine(2)];
    const restored = [emptyLine(1), emptyLine(2), emptyLine(3)];
    render(<JournalLinesGrid lines={initial} onChange={onChange} accountOptions={[]} />);
    act(() =>
      root!.render(<JournalLinesGrid lines={restored} onChange={onChange} accountOptions={[]} />),
    );

    act(() =>
      host.querySelector('[data-cell="2-4"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );

    const lines = onChange.mock.calls.at(-1)?.[0] as JournalLineDraft[];
    expect(lines.map((line) => line.key)).toEqual([1, 2, 3, 4]);
  });

  it('adds a unique invoice line key after the restored lines replace the initial lines', () => {
    const onChange = vi.fn();
    const initial: InvoiceLineDraft[] = [{ key: 1 }, { key: 2 }];
    const restored: InvoiceLineDraft[] = [{ key: 1 }, { key: 2 }, { key: 3 }];
    const props = { onChange, itemOptions: [] as InvoiceItemOption[] };
    render(<InvoiceLinesGrid lines={initial} {...props} />);
    act(() =>
      root!.render(<InvoiceLinesGrid lines={restored} {...props} />),
    );

    act(() =>
      host.querySelector('[data-cell="2-4"]')!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      ),
    );

    const lines = onChange.mock.calls.at(-1)?.[0] as InvoiceLineDraft[];
    expect(lines.map((line) => line.key)).toEqual([1, 2, 3, 4]);
  });
});
