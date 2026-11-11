import { CloudDownloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Space, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchBlob } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { apiErrorText, saveBlob } from './ExportButtons';

/**
 * Company data export (§13.6): a ZIP of Excel workbooks with all the data.
 * Owner only, and available even when the subscription is suspended or
 * cancelled (read only).
 */
export function DataExportCard() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const isOwner = me?.currentMembership?.roleCode === 'OWNER';

  const download = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await apiFetchBlob('/api/v1/export/tenant-data');
      saveBlob(blob, filename ?? 'tenant-export.zip');
      message.success(t('dataExport.done'));
    } catch (err) {
      message.error(apiErrorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Space direction="vertical" size={12} style={{ maxWidth: 720 }}>
      <Typography.Paragraph>{t('dataExport.intro')}</Typography.Paragraph>
      <Typography.Paragraph type="secondary">{t('dataExport.contents')}</Typography.Paragraph>
      {isOwner ? (
        <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={download}>
          {t('dataExport.download')}
        </Button>
      ) : (
        <Alert type="info" showIcon message={t('dataExport.ownerOnly')} />
      )}
    </Space>
  );
}
