import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, companyControllerGet, companyControllerLogo } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { BrandingDisplay } from '../components/CompanyBranding';
import { EnterNav } from '../components/EnterNav';
import { readLastBranding, saveLastBranding, shrinkLogo } from '../branding/lastBranding';

export function LoginPage({ onSwitchToRegister }: { onSwitchToRegister: () => void }) {
  const { t, i18n } = useTranslation();
  const { login } = useAuth();
  const [branding] = useState(readLastBranding);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const onFinish = async (values: { email: string; password: string }) => {
    setLoading(true);
    setError(null);
    try {
      await login(values.email, values.password);
      try {
        const company = (await companyControllerGet()).data;
        const logo = company.logo
          ? await companyControllerLogo().then((r) => shrinkLogo(`data:${r.data.mimeType};base64,${r.data.base64}`))
          : null;
        saveLastBranding({ nameAr: company.legalNameAr, nameEn: company.legalNameEn, logo });
      } catch {
        // Login remains successful if optional branding cannot be fetched.
      }
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
        <div className="login-branding">
          <BrandingDisplay
            logo={branding?.logo}
            name={branding ? ((i18n.language === 'en' && branding.nameEn) || branding.nameAr) : undefined}
          />
        </div>
        <Typography.Title level={3} style={{ textAlign: 'center' }}>
          {t('auth.loginTitle')}
        </Typography.Title>
        {error && <Alert type="error" message={error} style={{ marginBottom: 16 }} />}
        <EnterNav>
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
        </EnterNav>
        <Button type="link" block onClick={onSwitchToRegister}>
          {t('auth.noAccount')}
        </Button>
      </Card>
    </div>
  );
}
