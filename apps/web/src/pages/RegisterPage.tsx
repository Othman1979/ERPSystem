import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { ApiError, type RegisterDto } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';

export function RegisterPage({ onSwitchToLogin }: { onSwitchToLogin: () => void }) {
  const { t } = useTranslation();
  const { register } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: {
    tenantName: string;
    ownerName: string;
    email: string;
    password: string;
    companyNameAr?: string;
  }) => {
    setLoading(true);
    setError(null);
    try {
      const dto: RegisterDto = {
        tenantName: values.tenantName,
        ownerName: values.ownerName,
        email: values.email,
        password: values.password,
        companyNameAr: values.companyNameAr || undefined,
      };
      await register(dto);
      // A new company starts with the setup wizard (§13.4).
      navigate('/setup', { replace: true });
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
    <div style={{ maxWidth: 460, margin: '6vh auto' }}>
      <Card>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          {t('auth.registerTitle')}
        </Typography.Title>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item name="tenantName" label={t('auth.tenantName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="companyNameAr" label={t('auth.companyName')}>
            <Input />
          </Form.Item>
          <Form.Item name="ownerName" label={t('auth.ownerName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="email" label={t('auth.email')} rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('auth.password')}
            rules={[{ required: true, min: 8 }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            {t('auth.register')}
          </Button>
        </Form>
        <Button type="link" block onClick={onSwitchToLogin}>
          {t('auth.haveAccount')}
        </Button>
      </Card>
    </div>
  );
}
