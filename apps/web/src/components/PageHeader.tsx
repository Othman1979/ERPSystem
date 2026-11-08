import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '../i18n';

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  /** Show a back button (e.g. breadcrumb-style navigation). */
  onBack?: () => void;
}

/** Odoo-style control panel: title, optional subtitle, actions on the end. */
export function PageHeader({ title, subtitle, actions, onBack }: Props) {
  const { t } = useTranslation();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 16,
        flexWrap: 'wrap',
      }}
    >
      {onBack && (
        <Button
          type="text"
          icon={i18n.language === 'ar' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
          onClick={onBack}
          aria-label={t('common.back')}
        />
      )}
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={4} style={{ margin: 0 }} ellipsis>
          {title}
        </Typography.Title>
        {subtitle && (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {subtitle}
          </Typography.Text>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {actions && <div>{actions}</div>}
    </div>
  );
}
