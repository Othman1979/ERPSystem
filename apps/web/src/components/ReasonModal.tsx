import { Form, Input, Modal } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormSection } from './FormDialog';

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
      <Form layout="vertical">
        <FormSection title={title} cols={1}>
          <Form.Item
            label={t('procurement.reason')}
            required
            validateStatus={tried && blank ? 'error' : undefined}
            help={tried && blank ? t('procurement.reasonRequired') : undefined}
          >
            <Input.TextArea
              aria-label={t('procurement.reason')}
              autoSize={{ minRows: 3, maxRows: 6 }}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Form.Item>
        </FormSection>
      </Form>
    </Modal>
  );
}
