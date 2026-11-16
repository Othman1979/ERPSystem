/** The kinds of an item, in the order the kind selectors show them (ADR-031 §1, ADR-032 §5). */
export const ITEM_KINDS = ['STOCK', 'MANUFACTURED', 'RECIPE', 'SERVICE'] as const;
export type ItemKindValue = (typeof ITEM_KINDS)[number];

/** The i18n key of each kind's label. */
export const ITEM_KIND_LABEL_KEY: Record<ItemKindValue, string> = {
  STOCK: 'items.stock',
  MANUFACTURED: 'items.manufactured',
  RECIPE: 'items.recipe',
  SERVICE: 'items.service',
};

/**
 * A kind that holds stock: a stock item, or a manufactured one (ADR-031 §1).
 * Every screen asks this, not for `STOCK` alone: balances, minimum and
 * default warehouse, the stock ledger and the stock pickers. A recipe holds
 * no stock (ADR-032 §5), so it is false for `RECIPE`.
 */
export function holdsStock(kind: string | null | undefined): boolean {
  return kind === 'STOCK' || kind === 'MANUFACTURED';
}

/** A recipe (ADR-032): sold and priced, its formula's components leave stock when the sale posts. */
export function isRecipe(kind: string | null | undefined): boolean {
  return kind === 'RECIPE';
}

/** Kinds that own a formula (ADR-031 §5, ADR-032 §6): a manufactured item or a recipe. */
export function ownsFormula(kind: string | null | undefined): boolean {
  return kind === 'MANUFACTURED' || kind === 'RECIPE';
}
