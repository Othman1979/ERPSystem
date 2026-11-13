import { Modal, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { ChangePasswordForm } from './ChangePasswordForm';

/**
 * Topbar dialog for a signed-in user to change their own password.
 * Uses a plain Modal: the form carries its own submit button, which
 * FormDialog's footer cannot trigger.
 */
export function ChangePasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      title={t('auth.changePassword')}
      open={open}
      onCancel={onClose}
      footer={null}
      width={420}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">{t('auth.otherSessionsNote')}</Typography.Paragraph>
      <ChangePasswordForm onDone={onClose} />
    </Modal>
  );
}
