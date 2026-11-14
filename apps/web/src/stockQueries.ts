import type { QueryClient, QueryKey } from '@tanstack/react-query';

/**
 * Query-key prefixes of every screen that shows stock on hand, stock moves or
 * stock value. Posting or reversing a document that moves stock (sales and
 * purchases, their returns, goods notes, adjustments, transfers, approved
 * counts) changes all of them.
 */
export const STOCK_QUERY_KEYS: QueryKey[] = [
  ['stock-balances'], // Stock page balances and the Items screen's per-page on-hand
  ['stock-movements'], // Stock page, movements tab
  ['stock-valuation'], // Stock page, valuation tab
  ['item-ledger'], // the item card
  ['report-item-balances'], // Reports, item balances
  ['dashboard-summary'], // home dashboard: low stock
];

/** Expires every cached stock figure after a write that moved stock. */
export function invalidateStock(client: QueryClient): void {
  for (const queryKey of STOCK_QUERY_KEYS) void client.invalidateQueries({ queryKey });
}
