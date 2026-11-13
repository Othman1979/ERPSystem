import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Show a back button (e.g. breadcrumb-style navigation). */
  onBack?: () => void;
}

/** Odoo-style control panel: title, optional subtitle, actions on the end. */
export function PageHeader({ title, subtitle, actions, onBack }: Props) {
  const { t, i18n } = useTranslation();
  return (
    <div className="page-header">
      {onBack && (
        <Button
          type="text"
          icon={i18n.dir() === 'rtl' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
          onClick={onBack}
          aria-label={t('common.back')}
        />
      )}
      <div className="page-header-text">
        <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
          {title}
        </Typography.Title>
        {subtitle && (
          <div className="page-header-subtitle">{subtitle}</div>
        )}
      </div>
      {actions && <div>{actions}</div>}
    </div>
  );
}
