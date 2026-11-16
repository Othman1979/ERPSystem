import type { ComponentProps } from 'react';
import { catalogControllerListItems } from '@erp/api-client';
import { PICKER_PAGE_SIZE, RemoteSelect, type RemoteOption } from '../../components/RemoteSelect';
import { codeAndName } from '../../i18n/displayName';
import { componentSearchParams, mergeOptions, OWNER_ITEM_KINDS } from './pickerRules';

type RemoteProps = Omit<ComponentProps<typeof RemoteSelect>, 'queryKey' | 'fetchOptions'>;

/** A manufactured item, searched on the server (ADR-031 §1): the owner of a production voucher's formula. */
export function ManufacturedItemPicker(props: RemoteProps) {
  return (
    <RemoteSelect
      {...props}
      queryKey={['items', 'pick', 'manufactured']}
      fetchOptions={(q, signal) =>
        catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, itemKind: 'MANUFACTURED', ...(q ? { q } : {}) }, { signal }).then(
          (r) => r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })),
        )
      }
    />
  );
}

/** The owner of a formula: a manufactured item or a recipe (ADR-032 §6), searched on the server. */
export function OwnerItemPicker(props: RemoteProps) {
  return (
    <RemoteSelect
      {...props}
      queryKey={['items', 'pick', 'owner']}
      fetchOptions={(q, signal) =>
        Promise.all(
          OWNER_ITEM_KINDS.map((itemKind) =>
            catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, itemKind, ...(q ? { q } : {}) }, { signal }).then(
              (r): RemoteOption[] => r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })),
            ),
          ),
        ).then(mergeOptions)
      }
    />
  );
}

/**
 * A component of a formula (ADR-031 §1, ADR-032 §6): a stocked item, plus the recipes
 * when the owner is a recipe. `ownerKind` is the kind of the formula's item.
 */
export function ComponentItemPicker({ ownerKind, ...props }: RemoteProps & { ownerKind?: string }) {
  return (
    <RemoteSelect
      {...props}
      queryKey={['items', 'pick', 'component', ownerKind ?? '']}
      fetchOptions={(q, signal) =>
        Promise.all(
          componentSearchParams(ownerKind).map((kind) =>
            catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, ...kind, ...(q ? { q } : {}) }, { signal }).then(
              (r): RemoteOption[] => r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })),
            ),
          ),
        ).then(mergeOptions)
      }
    />
  );
}

/** A stocked item (a stock or a manufactured one): the materials of a voucher and of the sales grids (ADR-031 §1). */
export function StockedItemPicker(props: RemoteProps) {
  return (
    <RemoteSelect
      {...props}
      queryKey={['items', 'pick', 'stocked']}
      fetchOptions={(q, signal) =>
        catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, stocked: 'true', ...(q ? { q } : {}) }, { signal }).then((r) =>
          r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })),
        )
      }
    />
  );
}
