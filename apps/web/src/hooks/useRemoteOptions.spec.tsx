// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import '../i18n';
import { SEARCH_DEBOUNCE_MS } from './usePagedQuery';
import { useRemoteOptions } from './useRemoteOptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Row {
  id: string;
  name: string;
}
type Picker = ReturnType<typeof useRemoteOptions<Row>>;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

/** Lets the debounce and the query finish. */
const settle = (ms = SEARCH_DEBOUNCE_MS + 50) => act(() => new Promise((r) => setTimeout(r, ms)));

/** Renders two pickers side by side; each one's rows come from its own `rows` function. */
function mount(
  a: { key: readonly unknown[]; rows: (q: string | undefined) => Row[] },
  b?: { key: readonly unknown[]; rows: (q: string | undefined) => Row[] },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pickers: { a?: Picker; b?: Picker } = {};
  function Harness() {
    pickers.a = useRemoteOptions<Row>({ key: a.key, fetch: async (q) => a.rows(q) });
    if (b) pickers.b = useRemoteOptions<Row>({ key: b.key, fetch: async (q) => b.rows(q) });
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    ),
  );
  return pickers;
}

const ITEMS: Row[] = [
  { id: '1', name: 'Alpha' },
  { id: '2', name: 'Beta' },
];

describe('useRemoteOptions (W5: a search that is still answered offers no match)', () => {
  it('offers nothing while the typed text is being debounced, then the matches once they arrive', async () => {
    const picker = mount({ key: ['items', 'pick'], rows: (q) => ITEMS.filter((r) => !q || r.name.startsWith(q)) });
    await settle();
    expect(picker.a!.pending).toBe(false);
    expect(picker.a!.results.map((r) => r.id)).toEqual(['1', '2']);

    act(() => picker.a!.onSearch('Be'));
    // Typed, not yet debounced: the list must not still show the rows of the old text.
    expect(picker.a!.pending).toBe(true);
    expect(picker.a!.results).toEqual([]);

    // The debounce fires inside the first wait; the query it starts resolves after that act closes.
    await settle();
    await settle(20);
    expect(picker.a!.pending).toBe(false);
    expect(picker.a!.results.map((r) => r.id)).toEqual(['2']);
  });

  it('keeps a chosen row labelled while nothing matches the new text', async () => {
    const picker = mount({ key: ['items', 'pick'], rows: (q) => ITEMS.filter((r) => !q || r.name.startsWith(q)) });
    await settle();
    act(() => picker.a!.remember([ITEMS[0]]));
    act(() => picker.a!.onSearch('Zz'));
    expect(picker.a!.withSelected(['1']).map((r) => r.id)).toEqual(['1']);
  });
});

describe('useRemoteOptions (W1: pickers with other filters do not share results)', () => {
  it('keeps the results of each filter apart under the same key prefix', async () => {
    const active = mount(
      { key: ['items', 'pick', { isActive: 'true' }], rows: () => [{ id: 'active-1', name: 'Active item' }] },
      { key: ['items', 'pick', { itemKind: 'STOCK' }], rows: () => [{ id: 'stock-1', name: 'Stock item' }] },
    );
    await settle();
    expect(active.a!.results.map((r) => r.id)).toEqual(['active-1']);
    expect(active.b!.results.map((r) => r.id)).toEqual(['stock-1']);
  });
});
