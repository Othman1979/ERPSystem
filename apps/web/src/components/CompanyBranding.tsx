import { CloudServerOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Space } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { companyControllerLogo } from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { saveLastBranding, shrinkLogo } from '../branding/lastBranding';
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
  useEffect(() => {
    if (!company.data || (company.data.logo && !logo.data)) return;
    let active = true;
    void (async () => {
      try {
        const scaledLogo = logo.data ? await shrinkLogo(logo.data) : null;
        if (active) {
          saveLastBranding({
            nameAr: company.data!.legalNameAr,
            nameEn: company.data!.legalNameEn,
            logo: scaledLogo,
          });
        }
      } catch {
        // Branding is optional when the logo cannot be scaled.
      }
    })();
    return () => {
      active = false;
    };
  }, [company.data, logo.data]);
  return (
    <BrandingDisplay
      logo={logo.data}
      name={company.data ? ((i18n.language === 'en' && company.data.legalNameEn) || company.data.legalNameAr) : undefined}
      compact={mobile}
    />
  );
}
