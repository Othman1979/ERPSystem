/**
 * Item kinds for the API and the stock rules (ADR-031 §1, ADR-032 §5).
 *
 * A stocked item holds quantities and moves through stock: STOCK items and
 * MANUFACTURED items (a manufactured product with a bill of materials) behave
 * the same everywhere. SERVICE items never hold stock. A RECIPE is sold but
 * never stocked: its components leave stock when a sale posts (ADR-032 §7).
 * Every stock-only check must go through isStocked() so the kinds cannot drift apart.
 */
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';

/** Accepted values of the item kind filter and DTOs (one list, not one per DTO). */
export const ITEM_KINDS = ['STOCK', 'SERVICE', 'MANUFACTURED', 'RECIPE'] as const;

export type ItemKindValue = (typeof ITEM_KINDS)[number];

/** The kinds that hold stock (ADR-031 §1). */
export const STOCKED_ITEM_KINDS = ['STOCK', 'MANUFACTURED'] as const;

/** True for a recipe: sold and priced, never stocked (ADR-032 §5). */
export function isRecipe(kind: ItemKindValue): boolean {
  return kind === 'RECIPE';
}

/**
 * ADR-032 §5: a recipe is refused by every stock and purchasing document, by name (not as a
 * service). Documents that do not take a recipe call this where they check the item kind.
 */
export function assertNotRecipe(kind: ItemKindValue, code: string): void {
  if (kind === 'RECIPE') {
    throw new DomainError(ErrorCode.RECIPE_NOT_STOCKED, `Item ${code} is a recipe: it is sold, not bought or stocked`);
  }
}

/** True for an item kind that holds stock (STOCK or MANUFACTURED). */
export function isStocked(kind: ItemKindValue): boolean {
  return kind === 'STOCK' || kind === 'MANUFACTURED';
}

/** A Prisma `itemKind` filter that matches only the stocked kinds (a fresh array per call). */
export function stockedItemKindFilter(): { in: ('STOCK' | 'MANUFACTURED')[] } {
  return { in: [...STOCKED_ITEM_KINDS] };
}
