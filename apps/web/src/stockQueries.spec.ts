import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateStock, STOCK_QUERY_KEYS } from './stockQueries';

// Every source file in the web app, as raw text (resolved by Vite at test time).
const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.spec.{ts,tsx}'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** First segment of every literal query key a screen caches under (queryKey / key / *_QUERY_KEY). */
function cachedKeyHeads(): Set<string> {
  const heads = new Set<string>();
  for (const src of Object.values(sources)) {
    for (const m of src.matchAll(/\b(?:queryKey|key|[A-Z_]*QUERY_KEY)\s*[:=]\s*\{?\[\s*'([a-z0-9-]+)'/g)) heads.add(m[1]);
  }
  return heads;
}

/** Literal first segments passed to invalidateQueries({ queryKey: ['…'] }), with their file. */
function invalidatedKeyHeads(): { head: string; file: string }[] {
  const found: { head: string; file: string }[] = [];
  for (const [file, src] of Object.entries(sources)) {
    for (const m of src.matchAll(/invalidateQueries\(\{\s*queryKey:\s*\[\s*'([a-z0-9-]+)'/g)) found.push({ head: m[1], file });
  }
  return found;
}

describe('invalidateStock', () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient();
  });
  afterEach(() => client.clear());

  /** Caches a query under the key a screen uses, as if it had been fetched. */
  const seed = (queryKey: unknown[]) => client.setQueryData(queryKey, { seeded: true });
  const invalidated = (queryKey: unknown[]) => client.getQueryCache().find({ queryKey, exact: true })?.state.isInvalidated;

  it("expires every screen's stock figures after a post, and nothing else", () => {
    // The keys as the screens build them (StockPage, ItemsPage, ItemBalancesTab, HomeDashboard).
    const stock = [
      ['stock-balances', '7', false],
      ['stock-balances', 'items-page', ['1', '2']],
      ['stock-movements', { itemId: '1' }],
      ['stock-valuation'],
      ['item-ledger', '1', undefined, '2025-01-01', '2025-12-31'],
      ['report-item-balances', '7', '2025-01-01', '2025-12-31'],
      ['dashboard-summary'],
    ];
    const other = [['sales-invoices', 'list'], ['items', 'list'], ['journal-entries'], ['report-aging', 'CUSTOMER', '']];
    for (const k of [...stock, ...other]) seed(k);

    invalidateStock(client);

    for (const k of stock) expect({ key: k, invalidated: invalidated(k) }).toEqual({ key: k, invalidated: true });
    for (const k of other) expect({ key: k, invalidated: invalidated(k) }).toEqual({ key: k, invalidated: false });
  });

  it('targets only keys some screen caches under', () => {
    const heads = cachedKeyHeads();
    for (const [head] of STOCK_QUERY_KEYS as string[][]) expect({ head, cached: heads.has(head) }).toEqual({ head, cached: true });
  });

  it.each(['pages/SalesPage.tsx', 'pages/PurchasesPage.tsx', 'pages/GoodsNotesPage.tsx', 'pages/StockPage.tsx'])(
    '%s refreshes stock through invalidateStock',
    (file) => {
      expect(sources[`./${file}`]).toContain('invalidateStock(queryClient)');
    },
  );
});

describe('query invalidations', () => {
  it('finds the source files and their invalidations', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    expect(invalidatedKeyHeads().length).toBeGreaterThan(10);
  });

  it('every literal invalidateQueries key matches a key some screen caches under', () => {
    const heads = cachedKeyHeads();
    const dead = invalidatedKeyHeads().filter((k) => !heads.has(k.head));
    expect(dead).toEqual([]);
  });
});
