import { CloudServerOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Space } from 'antd';
import { useTranslation } from 'react-i18next';
import { companyControllerLogo } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { useCompany } from './CompanyProfileForm';

export function BrandingDisplay({
  logo,
  name,
  compact = false,
}: {
  logo?: string | null;
  name?: string;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Space className={`branding-display${compact ? ' branding-display-compact' : ''}`} size={8}>
      {logo ? (
        <img className="branding-logo" src={logo} alt={name || t('app.title')} />
      ) : compact ? (
        <CloudServerOutlined aria-label={t('app.title')} />
      ) : (
        <span className="branding-fallback">{t('app.title')}</span>
      )}
      {!compact && name && <span className="branding-name">{name}</span>}
    </Space>
  );
}

export function CompanyBranding({ mobile = false }: { mobile?: boolean }) {
  const { i18n } = useTranslation();
  const { companyId } = useAuth();
  const company = useCompany(Boolean(companyId));
  const logo = useQuery({
    queryKey: ['company-logo', companyId, company.data?.logo?.id],
    queryFn: ({ signal }) =>
      companyControllerLogo({ signal }).then((r) => `data:${r.data.mimeType};base64,${r.data.base64}`),
    enabled: Boolean(companyId && company.data?.logo),
  });
  return (
    <BrandingDisplay
      logo={logo.data}
      name={company.data ? ((i18n.language === 'en' && company.data.legalNameEn) || company.data.legalNameAr) : undefined}
      compact={mobile}
    />
  );
}
