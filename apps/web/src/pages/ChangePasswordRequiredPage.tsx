import { Button, Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

/**
 * Shown instead of the app while the account still uses a temporary password
 * (the server rejects every other route until it is changed).
 */
export function ChangePasswordRequiredPage() {
  const { t } = useTranslation();
  const { logout, refreshMe } = useAuth();
  return (
    <div style={{ maxWidth: 420, margin: '8vh auto' }}>
      <Card>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          {t('auth.mustChangeTitle')}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          {t('auth.mustChangeBody')}
        </Typography.Paragraph>
        <ChangePasswordForm onDone={() => void refreshMe()} />
        <Button type="link" block onClick={() => void logout()}>
          {t('auth.logout')}
        </Button>
      </Card>
    </div>
  );
}
