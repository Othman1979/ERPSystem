import type { QueryClient } from '@tanstack/react-query';

/**
 * Query keys of the sales quote and order screens (ADR-027). One family, so a
 * change on any of them refreshes the others: converting a quote, confirming
 * an order or posting an invoice made from one all move the reservations.
 */
export const SALES_CYCLE_KEY = 'sales-cycle' as const;

export const salesCycleKeys = {
  all: [SALES_CYCLE_KEY] as const,
  quoteList: () => [SALES_CYCLE_KEY, 'quotes', 'list'] as const,
  quote: (id: string | undefined) => [SALES_CYCLE_KEY, 'quote', id] as const,
  orderList: () => [SALES_CYCLE_KEY, 'orders', 'list'] as const,
  order: (id: string | undefined) => [SALES_CYCLE_KEY, 'order', id] as const,
  invoiceable: (id: string | undefined) => [SALES_CYCLE_KEY, 'invoiceable', id] as const,
  reservation: (warehouseId: string, itemIds: string) => [SALES_CYCLE_KEY, 'reservation', warehouseId, itemIds] as const,
  company: () => ['company'] as const,
};

/** Refreshes the sales cycle and the sales invoices it feeds: call it after any cycle mutation. */
export function invalidateSalesCycle(queryClient: QueryClient): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: salesCycleKeys.all }),
    queryClient.invalidateQueries({ queryKey: ['sales-invoices'] }),
    queryClient.invalidateQueries({ queryKey: ['sales-invoice'] }),
  ]);
}
