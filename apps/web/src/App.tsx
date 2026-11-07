import { useTranslation } from 'react-i18next';
import { Button, Layout, Typography } from 'antd';
import { HealthPage } from './pages/HealthPage';
import i18n, { SUPPORTED_LANGUAGES, type AppLanguage } from './i18n';

const { Header, Content } = Layout;

export function App() {
  const { t } = useTranslation();
  const current = i18n.language as AppLanguage;
  const next = current === 'ar' ? 'en' : 'ar';

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
        }}
      >
        <Typography.Title level={4} style={{ color: '#fff', margin: 0 }}>
          {t('app.title')}
        </Typography.Title>
        <Button
          size="small"
          onClick={() => {
            void i18n.changeLanguage(SUPPORTED_LANGUAGES.includes(next) ? next : 'ar');
          }}
        >
          {t('language.switchTo')}
        </Button>
      </Header>
      <Content style={{ padding: 24 }}>
        <HealthPage />
      </Content>
    </Layout>
  );
}
