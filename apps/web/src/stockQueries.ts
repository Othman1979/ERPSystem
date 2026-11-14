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

/** The document lists and details each trade screen refreshes after a save, post or delete, besides stock. */
export const DOCUMENT_QUERY_KEYS = {
  salesInvoice: [['sales-invoices'], ['sales-invoice']],
  // A return changes its invoice's returned and owed amounts.
  salesReturn: [['sales-returns'], ['sales-invoices']],
  purchaseInvoice: [['purchase-invoices'], ['purchase-invoice']],
  purchaseReturn: [['purchase-returns'], ['purchase-invoices']],
  goodsNote: [['goods-notes']],
} satisfies Record<string, QueryKey[]>;

export type StockDocument = keyof typeof DOCUMENT_QUERY_KEYS;

/**
 * What the Sales, Purchases and Goods Notes screens run after a write
 * (create, update, post, delete): their own lists and details, then every
 * stock figure (`invalidateStock`).
 */
export function invalidateStockDocument(client: QueryClient, document: StockDocument): void {
  for (const queryKey of DOCUMENT_QUERY_KEYS[document]) void client.invalidateQueries({ queryKey });
  invalidateStock(client);
}
