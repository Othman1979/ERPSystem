import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TablePaginationConfig } from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDebouncedValue } from './useDebouncedValue';

/** A numbered page from the API (ADR-022 §3). */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** What every numbered list sends (ADR-022 §2), besides its own filters. */
export interface PageParams {
  page: number;
  pageSize: number;
  q?: string;
  sort?: string;
}

export const PAGE_SIZE_OPTIONS = [20, 50, 100];
/** Wait this long after the last key stroke before searching on the server. */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * A server-paged list (ADR-022): page, page size, search and sort are state
 * here, sent to the API, and the table shows the server's total.
 *  - Changing a filter, the search or the sort goes back to page 1 (no extra
 *    request: the page is keyed by the filters it was chosen for).
 *  - The previous page stays on screen while the next one loads.
 *  - A page that went past the end (rows deleted meanwhile) moves to the last page.
 * The query key is `[...key, params]`, so invalidating `key` refreshes it.
 */
export function usePagedQuery<T, F extends Record<string, string | undefined>>({
  key,
  filters,
  fetch,
  enabled = true,
  defaultSort,
  defaultPageSize = PAGE_SIZE_OPTIONS[0],
}: {
  key: readonly unknown[];
  filters: F;
  fetch: (params: PageParams & Partial<F>, signal: AbortSignal) => Promise<Page<T>>;
  enabled?: boolean;
  /** The API's default sort; the table shows it as the active column. */
  defaultSort?: string;
  defaultPageSize?: number;
}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const [sort, setSort] = useState<string | undefined>(undefined);
  const [pageSize, setPageSize] = useState(defaultPageSize);
  // Drop filters that are not set, so `{}` and `{ status: undefined }` share a key.
  const setFilters = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== ''),
  ) as Partial<F>;
  const scope = JSON.stringify([setFilters, q, sort, pageSize]);
  const [paged, setPaged] = useState({ scope, page: 1 });
  // Derived state (React's "adjust state during render"): new filters start
  // at page 1, and the old page is forgotten, so clearing a search later
  // does not jump back to it.
  if (paged.scope !== scope) setPaged({ scope, page: 1 });
  const page = paged.scope === scope ? paged.page : 1;
  const setPage = (p: number) => setPaged({ scope, page: p });

  const params = {
    ...setFilters,
    page,
    pageSize,
    ...(q ? { q } : {}),
    ...(sort ? { sort } : {}),
  } as PageParams & Partial<F>;
  const query = useQuery({
    queryKey: [...key, params],
    queryFn: ({ signal }) => fetch(params, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
  const data = query.data;

  // Past the end: go to the last page that still has rows.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && data.page > 1) {
      setPaged({ scope, page: Math.max(1, Math.ceil(data.total / data.pageSize)) });
    }
  }, [data, scope]);

  const effectiveSort = sort ?? defaultSort;
  /** Controlled `sortOrder` for a sortable column keyed by its API sort key. */
  const sortOrderOf = (columnKey: string): 'ascend' | 'descend' | null =>
    effectiveSort === columnKey ? 'ascend' : effectiveSort === `-${columnKey}` ? 'descend' : null;

  const pagination: TablePaginationConfig = {
    current: page,
    pageSize,
    total: data?.total ?? 0,
    showSizeChanger: true,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    showTotal: (total, [from, to]) => t('common.pageRange', { from, to, total }),
    size: 'small',
  };

  /** Table `onChange`: page, page size and the sorted column (its `key` is the API sort key). */
  const onTableChange = (
    next: TablePaginationConfig,
    _filters: unknown,
    sorter: SorterResult<T> | SorterResult<T>[],
  ) => {
    const s = Array.isArray(sorter) ? sorter[0] : sorter;
    const columnKey = s?.columnKey != null ? String(s.columnKey) : undefined;
    const nextSort = columnKey && s.order ? (s.order === 'descend' ? `-${columnKey}` : columnKey) : undefined;
    // Clearing a column's sort returns to the list's default order.
    if ((nextSort ?? defaultSort) !== effectiveSort) {
      setSort(nextSort);
      return;
    }
    if (next.pageSize && next.pageSize !== pageSize) {
      setPageSize(next.pageSize);
      return;
    }
    if (next.current && next.current !== page) setPage(next.current);
  };

  return {
    query,
    rows: data?.items ?? [],
    total: data?.total,
    search,
    setSearch,
    pagination,
    onTableChange,
    sortOrderOf,
  };
}
