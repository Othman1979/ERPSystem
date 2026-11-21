export const LIVE_REFRESH_MS = 30_000;
export const LOCK_STATUS_MS = 15_000;
export const PICKER_FRESH_MS = 10_000;

export function refetchIfOlderThan(
  query: { dataUpdatedAt: number; isFetching: boolean; refetch: () => unknown },
  ms: number,
): void {
  if (!query.isFetching && (query.dataUpdatedAt === 0 || Date.now() - query.dataUpdatedAt > ms)) {
    void query.refetch();
  }
}
