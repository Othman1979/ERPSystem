import { useQuery } from '@tanstack/react-query';
import { documentLocksControllerStatus } from '@erp/api-client';
import { LOCK_STATUS_MS } from '../liveRefresh';
import type { LockDocType } from './useDocumentLock';

export function useDocumentLockStatus(
  docType: LockDocType,
  id: string | null | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['document-lock-status', docType, id],
    queryFn: ({ signal }) => documentLocksControllerStatus(docType, id!, { signal }).then((r) => r.data),
    enabled: enabled && !!id,
    refetchInterval: enabled && id ? LOCK_STATUS_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
}
