/** The kinds of an item, in the order the kind selectors show them (ADR-031 §1). */
export const ITEM_KINDS = ['STOCK', 'MANUFACTURED', 'SERVICE'] as const;
export type ItemKindValue = (typeof ITEM_KINDS)[number];

/** The i18n key of each kind's label. */
export const ITEM_KIND_LABEL_KEY: Record<ItemKindValue, string> = {
  STOCK: 'items.stock',
  MANUFACTURED: 'items.manufactured',
  SERVICE: 'items.service',
};

/**
 * A kind that holds stock: a stock item, or a manufactured one (ADR-031 §1).
 * Every screen asks this, not for `STOCK` alone: balances, minimum and
 * default warehouse, the stock ledger and the stock pickers.
 */
export function holdsStock(kind: string | null | undefined): boolean {
  return kind === 'STOCK' || kind === 'MANUFACTURED';
}
