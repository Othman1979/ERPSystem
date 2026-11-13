import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DisconnectOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Result, Typography } from 'antd';

/** Seconds before each automatic retry; the last one repeats. */
export const RETRY_DELAYS_S = [2, 4, 8, 15, 30] as const;

/** Delay before automatic retry number `attempt` (0-based). */
export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_S[Math.min(attempt, RETRY_DELAYS_S.length - 1)];
}

/**
 * Full-screen state shown when the session could not be checked because the
 * server did not answer (WEB-04). It is not the sign-in screen: the session
 * cookie is probably still valid. Retries on its own with a growing delay, at
 * once when the browser comes back online, and on the button.
 */
export function ServerUnreachable({ onRetry }: { onRetry: () => Promise<void> }) {
  const { t } = useTranslation();
  const attempts = useRef(0);
  const busy = useRef(false);
  const [secondsLeft, setSecondsLeft] = useState(() => retryDelay(0));
  const [retrying, setRetrying] = useState(false);

  const retry = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setRetrying(true);
    try {
      // On success the parent replaces this screen; otherwise wait longer next time.
      await onRetry();
    } finally {
      busy.current = false;
      attempts.current += 1;
      setSecondsLeft(retryDelay(attempts.current));
      setRetrying(false);
    }
  }, [onRetry]);

  useEffect(() => {
    if (retrying) return undefined;
    if (secondsLeft <= 0) {
      void retry();
      return undefined;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, retrying, retry]);

  useEffect(() => {
    const onOnline = () => void retry();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [retry]);

  return (
    <Result
      icon={<DisconnectOutlined />}
      title={t('connection.title')}
      subTitle={t('connection.text')}
      extra={
        <>
          <Button type="primary" icon={<ReloadOutlined />} loading={retrying} onClick={() => void retry()}>
            {t('connection.retryNow')}
          </Button>
          <Typography.Paragraph type="secondary" style={{ marginTop: 12 }} aria-live="polite">
            {retrying ? t('connection.retrying') : t('connection.autoRetry', { seconds: secondsLeft })}
          </Typography.Paragraph>
        </>
      }
      style={{ marginTop: '12vh' }}
    />
  );
}
