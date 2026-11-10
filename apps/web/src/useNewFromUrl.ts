import { useEffect } from 'react';
import { useSearchParams } from 'react-router';

/**
 * Opens a page's new-document form when it is reached with `?new=1` (the home
 * screen's quick actions), then drops the flag so a refresh or Back doesn't
 * reopen it.
 */
export function useNewFromUrl(open: () => void): void {
  const [params, setParams] = useSearchParams();
  const wantsNew = params.get('new') === '1';
  useEffect(() => {
    if (!wantsNew) return;
    open();
    const next = new URLSearchParams(params);
    next.delete('new');
    setParams(next, { replace: true });
    // Runs once per ?new=1 visit; `open` and `params` are read at that moment.
  }, [wantsNew]);
}
