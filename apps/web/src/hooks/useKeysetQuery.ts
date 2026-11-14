import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@erp/api-client';
import { App } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A cursor is only valid for the data it was issued on. Refetching every loaded
 * page on each window focus would ask with cursors the data may have moved past,
 * so reads are not refetched on focus and stay fresh for a few minutes.
 */
export const KEYSET_STALE_MS = 5 * 60_000;

/**
 * Retries a failed page once, except for a refusal (4xx): the same request
 * gets the same answer, e.g. a CURSOR_INVALID or a forbidden branch.
 */
export function keysetRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

/** One page of a keyset read (ADR-022 §4). `summary` comes on the first page only. */
export interface KeysetPage<T, S = undefined> {
  items: T[];
  nextCursor: string | null;
  summary?: S | null;
}

/**
 * A "load more" read (ADR-022 §4): the account and party statements and the
 * stock movements. Pages are appended as the user scrolls; the running
 * balance continues across pages because the server carries it in the cursor.
 * A refused cursor (CURSOR_INVALID: the data, the filters or the member's
 * branches changed) restarts the read from the first page, with a message.
 * The query key is `key`, so invalidating it restarts the read too.
 */
export function useKeysetQuery<T, S = undefined>({
  key,
  fetch,
  enabled = true,
}: {
  key: readonly unknown[];
  fetch: (cursor: string | undefined, signal: AbortSignal) => Promise<KeysetPage<T, S>>;
  enabled?: boolean;
}) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => fetch(pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    staleTime: KEYSET_STALE_MS,
    refetchOnWindowFocus: false,
    retry: keysetRetry,
  });

  const cursorRefused = query.error instanceof ApiError && query.error.code === 'CURSOR_INVALID';
  useEffect(() => {
    if (!cursorRefused) return;
    void message.info(t('errors.CURSOR_INVALID'));
    void queryClient.resetQueries({ queryKey: key });
    // `key` is a fresh array each render; the refusal itself is the trigger, so it is left out.
  }, [cursorRefused]);

  const pages = query.data?.pages ?? [];
  return {
    query,
    rows: pages.flatMap((p) => p.items),
    summary: pages[0]?.summary ?? undefined,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
