import { Button, Card, Collapse, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { PageHeader } from '../components/PageHeader';

/** Guide sections (i18n help.<id>.title / .body) and the screen each one opens. */
export const HELP_SECTIONS: { id: string; path?: string }[] = [
  { id: 'start', path: '/setup' },
  { id: 'opening', path: '/opening-balances' },
  { id: 'masters', path: '/items' },
  { id: 'sales', path: '/sales' },
  { id: 'purchases', path: '/purchases' },
  { id: 'treasury', path: '/treasury' },
  { id: 'stock', path: '/stock' },
  { id: 'journal', path: '/journal' },
  { id: 'reports', path: '/reports' },
  { id: 'einvoice', path: '/einvoice' },
  { id: 'users', path: '/users' },
  { id: 'subscription', path: '/settings' },
  { id: 'keyboard' },
];

/** Short in-app user guide in Arabic and English (§17 Phase 9, ADR-009 §10). */
export function HelpPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title={t('help.title')} subtitle={t('help.subtitle')} />
      <Card>
        <Collapse
          defaultActiveKey={['start']}
          items={HELP_SECTIONS.map((s) => ({
            key: s.id,
            label: t(`help.${s.id}.title`),
            children: (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Typography.Paragraph style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>
                  {t(`help.${s.id}.body`)}
                </Typography.Paragraph>
                {s.path && (
                  <Button size="small" onClick={() => navigate(s.path!)}>
                    {t('help.open')}
                  </Button>
                )}
              </Space>
            ),
          }))}
        />
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
          <Link to="/privacy">{t('legal.privacy.title')}</Link>
          {' · '}
          <Link to="/terms">{t('legal.terms.title')}</Link>
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
