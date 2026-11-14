import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { HomeOutlined, LockOutlined } from '@ant-design/icons';
import { Button, Result } from 'antd';
import { useAuth } from '../auth/AuthContext';
import { displayName } from '../i18n/displayName';

/**
 * Shown instead of a screen the user's role cannot use (a link or a typed
 * URL): the page never mounts, so no request fails with 403 behind it.
 */
export function NoAccess() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { me } = useAuth();
  const current = me?.tenants.find((tn) => tn.isCurrent);
  const role = current ? displayName({ nameAr: current.roleNameAr, nameEn: current.roleNameEn }) : '';

  return (
    <Result
      icon={<LockOutlined />}
      title={t('access.title')}
      subTitle={t('access.text', { role })}
      extra={
        <Button type="primary" icon={<HomeOutlined />} onClick={() => navigate('/')}>
          {t('access.home')}
        </Button>
      }
      style={{ marginTop: '8vh' }}
    />
  );
}
