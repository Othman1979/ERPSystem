import { Alert, Button, Modal } from 'antd';
import {
  documentLocksControllerForceRelease,
  type DocumentLockStatusDto,
} from '@erp/api-client';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { formatDateTime } from '../format/date';
import type { LockDocType } from '../hooks/useDocumentLock';

export function DocumentLockBanner({
  docType,
  id,
  query,
}: {
  docType: LockDocType;
  id: string;
  query: UseQueryResult<DocumentLockStatusDto, Error>;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const holder = query.data?.holder;

  if (!holder || holder.mine) return null;

  return (
    <Alert
      type="warning"
      showIcon
      message={t('common.documentLockActiveEditor', {
        name: holder.userName,
        time: formatDateTime(holder.acquiredAt),
      })}
      action={
        can(PERMISSIONS.DOCUMENT_UNLOCK) ? (
          <Button
            onClick={() =>
              Modal.confirm({
                title: t('common.documentLockUnlockConfirm'),
                onOk: async () => {
                  await documentLocksControllerForceRelease(docType, id);
                  await query.refetch();
                },
              })
            }
          >
            {t('common.documentLockUnlock')}
          </Button>
        ) : undefined
      }
    />
  );
}
