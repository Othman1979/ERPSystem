import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SEARCH_DEBOUNCE_MS } from './usePagedQuery';
import { useDebouncedValue } from './useDebouncedValue';

/** How many matches a picker asks the server for (ADR-022 §8). */
export const PICKER_PAGE_SIZE = 20;

/**
 * Rows for a picker that searches on the server (ADR-022 §8) — items and
 * parties in the document grids and headers — instead of loading the whole
 * catalogue. Each search asks for the first PICKER_PAGE_SIZE matches.
 *
 * Every row seen is remembered, so a chosen row keeps its label and details
 * (price, tax rate, kind) after the next search no longer returns it:
 * `withSelected(ids)` is the current matches plus those rows. `remember()`
 * seeds rows known from elsewhere, e.g. the lines of a document being edited.
 */
export function useRemoteOptions<T extends { id: string }>({
  key,
  fetch,
  enabled = true,
}: {
  /**
   * Query key prefix, e.g. ['items', 'pick', { isActive: 'true' }]; the search text is
   * appended. Put every request filter in it: two pickers that differ only by a
   * filter must not share cached results.
   */
  key: readonly unknown[];
  fetch: (q: string | undefined, signal: AbortSignal) => Promise<T[]>;
  enabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS) || undefined;
  const [known, setKnown] = useState<ReadonlyMap<string, T>>(new Map());
  const query = useQuery({
    queryKey: [...key, q ?? ''],
    queryFn: ({ signal }) => fetch(q, signal),
    enabled,
    placeholderData: keepPreviousData,
  });
  // The list does not answer the text on screen yet: the debounce has not caught
  // up with it, or the query for it has not settled (keepPreviousData still shows
  // the last search). Until then no match is offered, so Enter cannot pick a row
  // that the new text would not show.
  const pending = search.trim() !== (q ?? '') || query.isPlaceholderData;

  const remember = useCallback((rows: readonly T[]) => {
    if (rows.length === 0) return;
    setKnown((prev) => {
      if (rows.every((r) => prev.get(r.id) === r)) return prev;
      const next = new Map(prev);
      for (const r of rows) next.set(r.id, r);
      return next;
    });
  }, []);
  useEffect(() => {
    if (query.data) remember(query.data);
  }, [query.data, remember]);

  const results = useMemo(() => (pending ? [] : (query.data ?? [])), [pending, query.data]);
  const byId = useCallback((id: string | undefined | null) => (id ? known.get(id) : undefined), [known]);
  /** Current matches, then any of `ids` that are not among them (chosen rows stay pickable and labelled). */
  const withSelected = useCallback(
    (ids: readonly (string | undefined | null)[]) => {
      const seen = new Set(results.map((r) => r.id));
      const extra: T[] = [];
      for (const id of ids) {
        const row = id && !seen.has(id) ? known.get(id) : undefined;
        if (row) {
          seen.add(row.id);
          extra.push(row);
        }
      }
      return [...results, ...extra];
    },
    [results, known],
  );

  return {
    results,
    byId,
    withSelected,
    remember,
    onSearch: setSearch,
    search,
    /** The search is still being answered; `results` is empty meanwhile. */
    pending,
    loading: query.isFetching,
    query,
  };
}
