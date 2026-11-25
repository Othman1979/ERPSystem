import { useSearchParams } from 'react-router';

export type UrlTabSearchParams = (current: URLSearchParams, tab: string) => URLSearchParams;

function withTab(current: URLSearchParams, tab: string): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('tab', tab);
  return next;
}

export function useUrlTab<T extends string>(
  validKeys: readonly T[],
  defaultKey: T,
  searchParamsForTab: UrlTabSearchParams = withTab,
): readonly [T, (tab: string) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const activeTab = requestedTab && validKeys.includes(requestedTab as T) ? requestedTab as T : defaultKey;
  const changeTab = (tab: string) => {
    if (!validKeys.includes(tab as T)) return;
    setSearchParams((current) => searchParamsForTab(current, tab), { replace: true });
  };
  return [activeTab, changeTab] as const;
}
