import type { StockCountListItemDto } from '@erp/api-client';

/** A count as a choice: its number (or the id) and its date. */
export function countLabel(c: Pick<StockCountListItemDto, 'id' | 'docNo' | 'countDate'>): string {
  return `${c.docNo ?? `#${c.id}`} · ${c.countDate.slice(0, 10)}`;
}

/**
 * The first count must not be later than the second (ADR-032 §3): the other order is
 * refused by the API, and the screen says so before a request is sent. Dates are ISO
 * strings, so they compare as text.
 */
export function countsInOrder(from?: Pick<StockCountListItemDto, 'countDate'>, to?: Pick<StockCountListItemDto, 'countDate'>): boolean {
  if (!from || !to) return false;
  return from.countDate.slice(0, 10) <= to.countDate.slice(0, 10);
}
