import { Alert, Card, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { PageHeader } from '../components/PageHeader';

/** Sections of each document, in order; the texts are i18n keys legal.<kind>.<id>.title / .body. */
export const LEGAL_SECTIONS = {
  privacy: ['who', 'data', 'use', 'sharing', 'retention', 'security', 'rights', 'changes', 'contact'],
  terms: ['acceptance', 'service', 'account', 'billing', 'cancellation', 'einvoice', 'use', 'liability', 'law', 'changes'],
} as const;

export type LegalKind = keyof typeof LEGAL_SECTIONS;

/**
 * Privacy policy and terms of use (BUILD_PLAN §13.8, ADR-009 §9): DRAFTS to
 * be replaced by texts reviewed by a lawyer; the page says so. Open to
 * guests too (linked from registration).
 */
export function LegalPage({ kind, standalone = false }: { kind: LegalKind; standalone?: boolean }) {
  const { t } = useTranslation();
  const other: LegalKind = kind === 'privacy' ? 'terms' : 'privacy';
  return (
    <div style={standalone ? { maxWidth: 820, margin: '4vh auto', padding: '0 16px' } : undefined}>
      <PageHeader title={t(`legal.${kind}.title`)} subtitle={t('legal.updated')} />
      <Card>
        <Alert type="warning" showIcon message={t('legal.draftNotice')} style={{ marginBottom: 16 }} />
        <Typography.Paragraph>{t(`legal.${kind}.intro`)}</Typography.Paragraph>
        {LEGAL_SECTIONS[kind].map((id, i) => (
          <section key={id}>
            <Typography.Title level={5}>{`${i + 1}. ${t(`legal.${kind}.${id}.title`)}`}</Typography.Title>
            <Typography.Paragraph style={{ whiteSpace: 'pre-line' }}>{t(`legal.${kind}.${id}.body`)}</Typography.Paragraph>
          </section>
        ))}
        <Typography.Paragraph type="secondary">
          <Link to={`/${other}`}>{t(`legal.${other}.title`)}</Link>
          {standalone && (
            <>
              {' · '}
              <Link to="/">{t('legal.backToSignIn')}</Link>
            </>
          )}
        </Typography.Paragraph>
      </Card>
    </div>
  );
}
