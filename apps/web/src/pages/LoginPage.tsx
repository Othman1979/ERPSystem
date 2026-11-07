import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';

export function LoginPage({ onSwitchToRegister }: { onSwitchToRegister: () => void }) {
  const { t } = useTranslation();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      await login(values.email, values.password);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 420, margin: '8vh auto' }}>
      <Card>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          {t('auth.loginTitle')}
        </Typography.Title>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="email" label={t('auth.email')} rules={[{ required: true }]}>
            <Input type="email" autoComplete="email" />
          </Form.Item>
          <Form.Item name="password" label={t('auth.password')} rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t('auth.login')}
          </Button>
        </Form>
        <Button type="link" block onClick={onSwitchToRegister}>
          {t('auth.noAccount')}
        </Button>
      </Card>
    </div>
  );
}
