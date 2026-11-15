import type { QueryClient } from '@tanstack/react-query';

/**
 * One key family for every procurement query (review #47): requests, quotes,
 * the comparison and orders all start with `procurement`, so a change on any
 * screen refreshes the others (a cancelled order reopens a request and its
 * quotes; an approval closes them).
 */
export const PROCUREMENT_KEY = 'procurement' as const;

export const procurementKeys = {
  all: [PROCUREMENT_KEY] as const,
  requestList: () => [PROCUREMENT_KEY, 'requests', 'list'] as const,
  requestPick: (status: string) => [PROCUREMENT_KEY, 'requests', 'pick', status] as const,
  request: (id: string | undefined) => [PROCUREMENT_KEY, 'request', id] as const,
  quoteList: () => [PROCUREMENT_KEY, 'quotes', 'list'] as const,
  quote: (id: string | undefined) => [PROCUREMENT_KEY, 'quote', id] as const,
  comparison: (requestId: string | undefined) => [PROCUREMENT_KEY, 'comparison', requestId] as const,
  orderList: () => [PROCUREMENT_KEY, 'orders', 'list'] as const,
  order: (id: string | undefined) => [PROCUREMENT_KEY, 'order', id] as const,
};

/** Refreshes every procurement query: call it after any procurement mutation. */
export function invalidateProcurement(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: procurementKeys.all });
}
