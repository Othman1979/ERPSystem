import { useQuery } from '@tanstack/react-query';
import { message } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  catalogControllerGetItem,
  catalogControllerListItems,
  warehousesControllerList,
  type ItemListItemDto,
} from '@erp/api-client';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../../hooks/useRemoteOptions';
import { codeAndName } from '../../i18n/displayName';

/** Message and error toasts of a stock screen, with the API's translated error text. */
export function useApiMessage() {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const show = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  const ok = (key: string) => apiMessage.success(t(key));
  return { apiMessage, contextHolder, show, ok };
}

export function useLookups() {
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const whOptions = (warehouses.data ?? [])
    .filter((w) => w.isActive)
    .map((w) => ({ value: w.id, label: codeAndName(w) }));
  const ownedWhOptions = (warehouses.data ?? [])
    .filter((w) => w.isActive && w.consignmentSupplierId === null)
    .map((w) => ({ value: w.id, label: codeAndName(w) }));
  // Report rows only carry the warehouse code; show "code — name" instead.
  const warehouseLabel = (code: string) =>
    codeAndName((warehouses.data ?? []).find((w) => w.code === code)) ?? code;
  return { warehouses, whOptions, ownedWhOptions, warehouseLabel };
}

/**
 * Stock items for the document grids: searched on the server as the user
 * types, never the whole catalogue (ADR-022 §8). Chosen rows stay labelled.
 */
export function useStockItemPicker(enabled: boolean) {
  return useRemoteOptions<ItemListItemDto>({
    key: ['items', 'pick', { stocked: 'true' }],
    enabled,
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, stocked: 'true', ...(q ? { q } : {}) },
        { signal },
      ).then((r) => r.data.items),
  });
}

export const itemOptionsOf = (rows: readonly ItemListItemDto[]) =>
  rows.map((i) => ({ value: i.id, label: codeAndName(i) }));

/**
 * An item's units and base unit (ADR-030 §8). Cached per item, so a page of
 * count lines asks once for each item.
 */
export function useItemUnits(itemId: string) {
  return useQuery({
    queryKey: ['item-units', itemId],
    queryFn: ({ signal }) => catalogControllerGetItem(itemId, { signal }).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
