import { Input, Modal, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Asks for the reason of a rejection or a cancellation; the reason is required. */
export function ReasonModal({
  title,
  okText,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  okText: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const blank = reason.trim() === '';
  return (
    <Modal
      open
      title={title}
      okText={okText}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => {
        setTried(true);
        if (!blank) onConfirm(reason.trim());
      }}
    >
      <Input.TextArea
        aria-label={t('procurement.reason')}
        autoSize={{ minRows: 3, maxRows: 6 }}
        maxLength={500}
        value={reason}
        status={tried && blank ? 'error' : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {tried && blank && <Typography.Text type="danger">{t('procurement.reasonRequired')}</Typography.Text>}
    </Modal>
  );
}
