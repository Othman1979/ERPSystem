/**
 * Item kinds for the API and the stock rules (ADR-031 §1).
 *
 * A stocked item holds quantities and moves through stock: STOCK items and
 * MANUFACTURED items (a manufactured product with a bill of materials) behave
 * the same everywhere. SERVICE items never hold stock. Every stock-only check
 * must go through isStocked() so the two kinds cannot drift apart.
 */

/** Accepted values of the item kind filter and DTOs (one list, not one per DTO). */
export const ITEM_KINDS = ['STOCK', 'SERVICE', 'MANUFACTURED'] as const;

export type ItemKindValue = (typeof ITEM_KINDS)[number];

/** The kinds that hold stock (ADR-031 §1). */
export const STOCKED_ITEM_KINDS = ['STOCK', 'MANUFACTURED'] as const;

/** True for an item kind that holds stock (STOCK or MANUFACTURED). */
export function isStocked(kind: ItemKindValue): boolean {
  return kind === 'STOCK' || kind === 'MANUFACTURED';
}

/** A Prisma `itemKind` filter that matches only the stocked kinds (a fresh array per call). */
export function stockedItemKindFilter(): { in: ('STOCK' | 'MANUFACTURED')[] } {
  return { in: [...STOCKED_ITEM_KINDS] };
}
