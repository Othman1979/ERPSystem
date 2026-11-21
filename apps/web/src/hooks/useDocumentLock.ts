import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  documentLocksControllerAcquire,
  documentLocksControllerForceRelease,
  documentLocksControllerHeartbeat,
  documentLocksControllerRelease,
} from '@erp/api-client';

export type LockDocType = 'JOURNAL_ENTRY' | 'RECEIPT' | 'PAYMENT' | 'SALES_INVOICE' | 'PURCHASE_INVOICE';

export type DocumentLockState =
  | { status: 'idle' }
  | { status: 'acquiring' }
  | { status: 'held' }
  | { status: 'reconnecting' }
  | { status: 'locked'; userName: string; acquiredAt: string }
  | { status: 'lost' }
  | { status: 'error'; error: unknown };

const TOKEN_STORAGE_KEY = 'erp:edit-lock-token';
const HEARTBEAT_MS = 30_000;

function createToken(): string {
  return globalThis.crypto.randomUUID();
}

function tabToken(): string {
  try {
    const stored = window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) return stored;
    const token = createToken();
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    return token;
  } catch {
    return createToken();
  }
}

export function documentLockHeaders(): Record<string, string> {
  return { 'X-Edit-Lock': tabToken() };
}

export function useDocumentLock(docType: LockDocType, id: string | null | undefined, enabled: boolean) {
  const [headers] = useState(documentLockHeaders);
  const [state, setState] = useState<DocumentLockState>(() =>
    enabled && id ? { status: 'acquiring' } : { status: 'idle' },
  );
  const [retryVersion, setRetryVersion] = useState(0);

  useEffect(() => {
    if (!enabled || !id) {
      setState({ status: 'idle' });
      return;
    }

    let active = true;
    let acquired = false;
    let pageHidden = false;
    let lost = false;
    let timer: number | undefined;
    setState({ status: 'acquiring' });

    const release = (keepalive = false) => {
      void documentLocksControllerRelease(docType, id, {
        headers,
        ...(keepalive ? { keepalive: true } : {}),
      }).catch(() => undefined);
    };

    const onPageHide = () => {
      pageHidden = true;
      if (acquired) release(true);
    };

    const heartbeat = async () => {
      try {
        await documentLocksControllerHeartbeat(docType, id, { headers });
        if (!active || lost) return;
        setState({ status: 'held' });
      } catch (error) {
        if (!active || lost) return;
        if (error instanceof ApiError && error.status === 409) {
          lost = true;
          if (timer !== undefined) window.clearInterval(timer);
          timer = undefined;
          setState({ status: 'lost' });
        } else {
          setState({ status: 'reconnecting' });
        }
      }
    };

    window.addEventListener('pagehide', onPageHide);
    void documentLocksControllerAcquire(docType, id, { headers }).then(
      () => {
        acquired = true;
        if (!active || pageHidden) {
          release(pageHidden);
          return;
        }
        setState({ status: 'held' });
        timer = window.setInterval(() => void heartbeat(), HEARTBEAT_MS);
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 409 && error.code === 'DOCUMENT_LOCKED') {
          setState({
            status: 'locked',
            userName: String(error.details?.userName ?? ''),
            acquiredAt: String(error.details?.acquiredAt ?? ''),
          });
        } else {
          setState({ status: 'error', error });
        }
      },
    );

    return () => {
      active = false;
      window.removeEventListener('pagehide', onPageHide);
      if (timer !== undefined) window.clearInterval(timer);
      if (acquired && !pageHidden) release();
    };
  }, [docType, enabled, headers, id, retryVersion]);

  const forceRelease = useCallback(() => {
    if (!id) return Promise.resolve();
    return documentLocksControllerForceRelease(docType, id, { headers });
  }, [docType, headers, id]);

  const retry = useCallback(() => setRetryVersion((version) => version + 1), []);
  const visibleState =
    enabled && id
      ? state.status === 'idle'
        ? ({ status: 'acquiring' } as const)
        : state
      : ({ status: 'idle' } as const);

  return { state: visibleState, headers, forceRelease, retry };
}
