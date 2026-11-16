import type { CatalogControllerListItemsParams } from '@erp/api-client';
import type { RemoteOption } from '../../components/RemoteSelect';

/**
 * The kinds that own a formula, and the picker of a formula's owner (ADR-032 §6):
 * a manufactured item or a recipe, one request for each kind, merged.
 */
export const OWNER_ITEM_KINDS = ['MANUFACTURED', 'RECIPE'] as const;

/**
 * The search parameters of a formula's component picker (ADR-031 §1, ADR-032 §6):
 * the stocked items (a stock or a manufactured one) for every formula, and the
 * recipes too when the owner is a recipe. A manufactured item never takes a recipe:
 * a recipe is sold, so its components leave stock, and it cannot be made in a batch.
 */
export function componentSearchParams(ownerKind: string | undefined): Pick<CatalogControllerListItemsParams, 'stocked' | 'itemKind'>[] {
  return ownerKind === 'RECIPE' ? [{ stocked: 'true' }, { itemKind: 'RECIPE' }] : [{ stocked: 'true' }];
}

/** Options from several searches, each item once, in the order they came. */
export function mergeOptions(lists: RemoteOption[][]): RemoteOption[] {
  const seen = new Set<string>();
  const merged: RemoteOption[] = [];
  for (const list of lists) {
    for (const option of list) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      merged.push(option);
    }
  }
  return merged;
}
