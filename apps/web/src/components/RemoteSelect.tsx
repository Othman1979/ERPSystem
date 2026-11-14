import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Select, type SelectProps } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SEARCH_DEBOUNCE_MS } from '../hooks/usePagedQuery';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { PICKER_PAGE_SIZE } from '../hooks/useRemoteOptions';

export interface RemoteOption {
  value: string;
  label: string;
}

export { PICKER_PAGE_SIZE };

/**
 * A picker that searches on the server (ADR-022 §8) instead of loading every
 * row: each search asks for the first PICKER_PAGE_SIZE matches. The chosen
 * option is kept, so its label stays visible when a new search no longer
 * returns it.
 */
export function RemoteSelect({
  queryKey,
  fetchOptions,
  value,
  onChange,
  enabled = true,
  selected,
  ...rest
}: {
  /** Query key prefix, e.g. ['sales-invoices', 'pick']; the search text is appended. */
  queryKey: readonly unknown[];
  fetchOptions: (q: string | undefined, signal: AbortSignal) => Promise<RemoteOption[]>;
  value?: string;
  onChange?: (value: string | undefined, option?: RemoteOption) => void;
  enabled?: boolean;
  /** Label of the current value when it was not picked here (e.g. a saved document's party). */
  selected?: RemoteOption;
} & Omit<SelectProps<string>, 'options' | 'onChange' | 'onSearch' | 'filterOption' | 'showSearch' | 'value'>) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS) || undefined;
  const [chosen, setChosen] = useState<RemoteOption | undefined>();
  const query = useQuery({
    queryKey: [...queryKey, q ?? ''],
    queryFn: ({ signal }) => fetchOptions(q, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
  const found = query.data ?? [];
  const current = [chosen, selected].find((o) => o !== undefined && o.value === value);
  const options = current && !found.some((o) => o.value === current.value) ? [current, ...found] : found;

  return (
    <Select<string>
      {...rest}
      showSearch
      allowClear
      filterOption={false}
      value={value}
      loading={query.isFetching}
      notFoundContent={query.isFetching ? t('common.loading') : undefined}
      onSearch={setSearch}
      options={options}
      onChange={(v) => {
        const option = options.find((o) => o.value === v);
        setChosen(option);
        setSearch('');
        onChange?.(v, option);
      }}
    />
  );
}
