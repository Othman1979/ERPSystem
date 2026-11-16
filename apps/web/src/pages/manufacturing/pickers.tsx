import type { ComponentProps } from 'react';
import { catalogControllerListItems } from '@erp/api-client';
import { PICKER_PAGE_SIZE, RemoteSelect } from '../../components/RemoteSelect';
import { codeAndName } from '../../i18n/displayName';

type RemoteProps = Omit<ComponentProps<typeof RemoteSelect>, 'queryKey' | 'fetchOptions'>;

/** A manufactured item, searched on the server (ADR-031 §1). */
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

/** A stocked item (a stock or a manufactured one): the components of a formula and the materials of a voucher (ADR-031 §1). */
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
