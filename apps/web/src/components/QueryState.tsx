import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { App, Button, Empty, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { ApiError, isConnectionError } from '@erp/api-client';

/** The part of a TanStack query result needed to tell "failed" from "empty". */
export interface ListQueryState {
  isError: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => unknown;
}

/** User-facing text for a failed request: the translated API code, or a network message. */
export function queryErrorMessage(error: unknown, t: TFunction): string {
  // The server could not be reached (the runtime classifies it, WEB-06), or a
  // 502–504 from the proxy: say so, not "internal error".
  const unreachable =
    isConnectionError(error) || (error instanceof ApiError && error.status >= 502 && error.status <= 504);
  if (error instanceof ApiError && !unreachable) {
    return t(`errors.${error.code}`, { defaultValue: error.message || t('errors.INTERNAL') });
  }
  return t('common.networkError');
}

/**
 * Body of an empty list. A failed query must never read as "no data" (WEB-03):
 * it shows the failure and a retry button; only a successful, empty result
 * shows the empty state.
 */
export function QueryEmpty({ query, empty }: { query: ListQueryState; empty?: ReactNode }) {
  const { t } = useTranslation();
  if (query.isError) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <>
            <Typography.Text type="danger" strong>
              {t('common.loadFailed')}
            </Typography.Text>
            <br />
            <Typography.Text type="secondary">{queryErrorMessage(query.error, t)}</Typography.Text>
          </>
        }
      >
        <Button icon={<ReloadOutlined />} loading={query.isFetching} onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </Empty>
    );
  }
  return empty ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />;
}

/** `locale` prop for an antd Table fed by a query: `<Table locale={tableLocale(q)} … />`. */
export function tableLocale(query: ListQueryState, empty?: ReactNode): { emptyText: ReactNode } {
  return { emptyText: <QueryEmpty query={query} empty={empty} /> };
}

// --- Global toast for failed queries (QueryCache.onError → QueryErrorToast) ---

type QueryErrorListener = (error: unknown) => void;
const listeners = new Set<QueryErrorListener>();

/** Called from `QueryCache({ onError })`; forwards to the mounted toast component. */
export function notifyQueryError(error: unknown): void {
  for (const listener of listeners) listener(error);
}

/** Window in which the same message is shown only once. */
export const QUERY_ERROR_DEDUPE_MS = 5000;

/**
 * Remembers when each message was last shown, so that a page whose six
 * queries fail together raises one toast, not six.
 */
export function createErrorDeduper(windowMs = QUERY_ERROR_DEDUPE_MS) {
  const lastShown = new Map<string, number>();
  return (text: string, now = Date.now()): boolean => {
    const last = lastShown.get(text);
    if (last !== undefined && now - last < windowMs) return false;
    lastShown.set(text, now);
    return true;
  };
}

/** Mount once inside antd's <App>: shows a deduplicated toast for every failed query. */
export function QueryErrorToast() {
  const { message } = App.useApp();
  const { t } = useTranslation();

  useEffect(() => {
    const shouldShow = createErrorDeduper();
    const listener: QueryErrorListener = (error) => {
      // An expired session is handled by the auth flow (back to the login screen).
      if (error instanceof ApiError && error.status === 401) return;
      const text = queryErrorMessage(error, t);
      if (!shouldShow(text)) return;
      void message.error({ key: `query-error:${text}`, content: t('common.loadFailedToast', { message: text }) });
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [message, t]);

  return null;
}
