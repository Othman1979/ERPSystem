import { useIsFetching } from '@tanstack/react-query';
import { theme } from 'antd';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

interface Props {
  forceVisible?: boolean;
}

export function GlobalLoadingBar({ forceVisible = false }: Props) {
  const fetching = useIsFetching({ predicate: (query) => query.state.data === undefined }) > 0;
  const loading = forceVisible || fetching;
  const [visible, setVisible] = useState(false);
  const { t } = useTranslation();
  const { token } = theme.useToken();

  useEffect(() => {
    if (!loading) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, [loading]);

  if (!visible) return null;
  return (
    <div
      className="global-loading-bar"
      style={{ backgroundColor: token.colorPrimaryBg }}
      role="progressbar"
      aria-label={t('common.loading')}
    >
      <span className="global-loading-bar__indicator" style={{ backgroundColor: token.colorPrimary }} />
    </div>
  );
}
