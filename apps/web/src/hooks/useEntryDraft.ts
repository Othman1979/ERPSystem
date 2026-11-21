import { Modal } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const DRAFT_PREFIX = 'erp:entry-draft:v1';
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface EntryDraftScope {
  userId?: string | null;
  tenantId?: string | null;
  companyId?: string | null;
  screenKey: string;
}

export function entryDraftStorageKey({ userId, tenantId, companyId, screenKey }: EntryDraftScope): string | null {
  if (!userId || !tenantId || !companyId) return null;
  return `${DRAFT_PREFIX}:${userId}:${tenantId}:${companyId}:${screenKey}`;
}

interface StoredDraft<T> {
  savedAt: number;
  data: T;
}

export function useEntryDraft<T>({
  scope,
  value,
  initialValue,
  dirtyValue,
  initialDirtyValue,
  onRestore,
  enabled = true,
  discardWhenDisabled = false,
  debounceMs = 500,
}: {
  scope: EntryDraftScope;
  value: T;
  initialValue: T;
  dirtyValue?: unknown;
  initialDirtyValue?: unknown;
  onRestore: (value: T) => void;
  enabled?: boolean;
  discardWhenDisabled?: boolean;
  debounceMs?: number;
}) {
  const { t, i18n } = useTranslation();
  const key = useMemo(() => entryDraftStorageKey(scope), [
    scope.userId,
    scope.tenantId,
    scope.companyId,
    scope.screenKey,
  ]);
  const [candidate, setCandidate] = useState<StoredDraft<T> | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;
  const skipWrite = useRef<{ key: string; comparisonJson: string } | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const valueJson = JSON.stringify(value);
  const comparisonJson = JSON.stringify(dirtyValue === undefined ? value : dirtyValue);
  const initialComparisonJson = JSON.stringify(
    initialDirtyValue === undefined ? initialValue : initialDirtyValue,
  );
  const dirty = enabled && comparisonJson !== initialComparisonJson;

  const clear = useCallback(() => {
    if (key) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage may be unavailable in private browsing.
      }
      skipWrite.current = { key, comparisonJson };
    }
    setCandidate(null);
  }, [comparisonJson, key]);

  useEffect(() => {
    setCandidate(null);
    setLoadedKey(key);
    if (!key) return;
    if (!enabled && discardWhenDisabled) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage may be unavailable in private browsing.
      }
      return;
    }
    if (!enabled) return;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<StoredDraft<T>>;
      const savedAt = Number(stored.savedAt);
      const age = Date.now() - savedAt;
      if (
        !Number.isFinite(savedAt) ||
        stored.data === undefined ||
        age < 0 ||
        age > DRAFT_TTL_MS
      ) {
        localStorage.removeItem(key);
        return;
      }
      setCandidate({ savedAt, data: stored.data });
    } catch {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage may be unavailable in private browsing.
      }
    }
  }, [discardWhenDisabled, enabled, key]);

  useEffect(() => {
    if (skipWrite.current && skipWrite.current.key !== key) skipWrite.current = null;
  }, [key]);

  useEffect(() => {
    if (!candidate || candidate === null || !key) return;
    const time = new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(candidate.savedAt);
    const dialog = Modal.confirm({
      title: t('common.entryDraftLeaveTitle'),
      content: t('common.entryDraftRestorePrompt', { time }),
      okText: t('common.entryDraftRestore'),
      cancelText: t('common.entryDraftDiscard'),
      onOk: () => {
        restoreRef.current(candidate.data);
        setCandidate(null);
      },
      onCancel: clear,
    });
    return () => dialog.destroy();
  }, [candidate, clear, i18n.language, key, t]);

  useEffect(() => {
    if (!key || !enabled || loadedKey !== key || candidate) return;
    if (skipWrite.current?.key === key) {
      if (skipWrite.current.comparisonJson === comparisonJson) return;
      skipWrite.current = null;
    }
    if (comparisonJson === initialComparisonJson) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage may be unavailable in private browsing.
      }
      return;
    }
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data: valueRef.current }));
      } catch {
        // Storage may be unavailable in private browsing.
      }
    }, debounceMs);
    return () => window.clearTimeout(timer);
  }, [
    candidate,
    comparisonJson,
    debounceMs,
    enabled,
    initialComparisonJson,
    key,
    loadedKey,
    valueJson,
  ]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const confirmLeave = useCallback(
    (leave: () => void) => {
      if (!dirty) {
        leave();
        return;
      }
      Modal.confirm({
        title: t('common.entryDraftLeaveTitle'),
        content: t('common.entryDraftLeavePrompt'),
        okText: t('common.entryDraftDiscard'),
        cancelText: t('common.cancel'),
        onOk: () => {
          clear();
          leave();
        },
      });
    },
    [clear, dirty, t],
  );

  return { key, dirty, clear, confirmLeave };
}
