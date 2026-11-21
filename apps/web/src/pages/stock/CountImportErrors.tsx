import { Alert, Modal, Table } from 'antd';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { splitReason, type SheetRowError } from './countPayload';

/** The reason in the user's language: the code is translated, the detail from the API is kept. */
export function importReasonText(t: TFunction, reason: string): string {
  const { code, detail } = splitReason(reason);
  const label = t(`stockCount.importReasons.${code}`, { defaultValue: code });
  return detail ? `${label} (${detail})` : label;
}

/**
 * The rows that stopped an import (ADR-030 §11, all or nothing): the file is
 * not imported at all, so the counter fixes these rows and uploads again.
 */
export function CountImportErrors({ rows, onClose }: { rows: SheetRowError[]; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open
      title={t('stockCount.importErrorsTitle')}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnHidden
    >
      <Alert
        type="error"
        showIcon
        style={{ marginBottom: 12 }}
        message={t('stockCount.importErrorsSummary', { count: rows.length })}
      />
      <Table<SheetRowError>
        size="small"
        rowKey={(r) => `${r.row}:${r.reason}`}
        dataSource={rows}
        pagination={rows.length > 10 ? { pageSize: 10 } : false}
        columns={[
          { title: t('stockCount.importRow'), dataIndex: 'row', width: 80, align: 'right' },
          { title: t('stockCount.importReason'), render: (_: unknown, r: SheetRowError) => importReasonText(t, r.reason) },
        ]}
       scroll={{ x: 'max-content' }}/>
    </Modal>
  );
}
