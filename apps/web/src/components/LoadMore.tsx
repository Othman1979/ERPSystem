import { Button } from 'antd';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Foot of a "load more" list (ADR-022 §8): the next page loads when this
 * comes into view while scrolling, and the button does the same for keyboard
 * and screen-reader users. Shows how many rows are on screen; renders nothing
 * once the last page is in.
 */
export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
  shown,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  /** Rows on screen so far. */
  shown: number;
}) {
  const { t } = useTranslation();
  const sentinel = useRef<HTMLDivElement>(null);
  const load = useRef(onLoadMore);
  load.current = onLoadMore;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) load.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore]);

  if (!hasMore) return null;
  return (
    <div ref={sentinel} className="load-more">
      <span className="load-more-count" aria-live="polite">
        {t('common.rowsShown', { count: shown })}
      </span>
      <Button onClick={onLoadMore} loading={loading}>
        {t('common.loadMore')}
      </Button>
    </div>
  );
}
