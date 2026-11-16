import { useQuery, type QueryClient } from '@tanstack/react-query';
import { catalogControllerGetItem } from '@erp/api-client';
import { invalidateStock } from '../../stockQueries';

/** Query keys of the bill-of-materials and production screens; every key starts with its module name. */
export const bomKeys = {
  list: () => ['boms', 'list'] as const,
  /** The versions of one item, for the formula pickers and the item page. */
  ofItem: (itemId: string | undefined) => ['boms', 'item', itemId] as const,
  detail: (id: string | undefined) => ['boms', 'detail', id] as const,
  requirements: (id: string, qty: string) => ['boms', 'requirements', id, qty] as const,
  cost: (id: string) => ['boms', 'cost', id] as const,
};

export const productionKeys = {
  list: () => ['production-vouchers', 'list'] as const,
  detail: (id: string | undefined) => ['production-vouchers', 'detail', id] as const,
};

/** After a BOM or voucher change: the lists, the details, and the stock a posting moved. */
export function invalidateManufacturing(queryClient: QueryClient, { stock = false }: { stock?: boolean } = {}): Promise<unknown> {
  const done = Promise.all([
    queryClient.invalidateQueries({ queryKey: ['boms'] }),
    queryClient.invalidateQueries({ queryKey: ['production-vouchers'] }),
  ]);
  if (stock) invalidateStock(queryClient);
  return done;
}

/**
 * An item with its units and base unit. Cached under the key the grid unit
 * cells use, so a page of lines asks once for each item.
 */
export function useItemDetail(itemId: string | undefined) {
  return useQuery({
    queryKey: ['items', 'detail', itemId],
    queryFn: ({ signal }) => catalogControllerGetItem(itemId!, { signal }).then((r) => r.data),
    enabled: !!itemId,
    staleTime: 5 * 60_000,
  });
}
