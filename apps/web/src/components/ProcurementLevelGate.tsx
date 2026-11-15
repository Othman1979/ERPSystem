import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { SettingOutlined } from '@ant-design/icons';
import { Button, Result, Spin } from 'antd';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { meetsProcurementLevel, type ProcurementLevel, useProcurementLevelState } from '../auth/procurementLevel';

/**
 * Shows a screen only from its procurement level up (ADR-024 §2.3). Without a
 * minimum the children render at once and no company query runs. While the
 * company loads, a spinner shows, never a "no access" screen.
 */
export function ProcurementLevelGate({ min, children }: { min?: ProcurementLevel; children: ReactNode }) {
  if (!min) return <>{children}</>;
  return <LevelCheck min={min}>{children}</LevelCheck>;
}

function LevelCheck({ min, children }: { min: ProcurementLevel; children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { level, loading } = useProcurementLevelState();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 64 }}>
        <Spin size="large" />
      </div>
    );
  }
  if (meetsProcurementLevel(level, min)) return <>{children}</>;

  // The company profile lives in settings, which needs settings.manage as well.
  const canOpenProfile = can(PERMISSIONS.COMPANY_MANAGE) && can(PERMISSIONS.SETTINGS_MANAGE);
  return (
    <Result
      icon={<SettingOutlined />}
      title={t('procurement.shellUi.levelTooLowTitle')}
      subTitle={t('procurement.shellUi.levelTooLowText', { level: t(`procurement.shellUi.levelNames.${min}`) })}
      extra={
        canOpenProfile ? (
          <Button type="primary" icon={<SettingOutlined />} onClick={() => navigate('/settings')}>
            {t('procurement.shellUi.openCompanyProfile')}
          </Button>
        ) : undefined
      }
      style={{ marginTop: '8vh' }}
    />
  );
}
