import { useQuery } from '@tanstack/react-query';
import { getHealth } from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Descriptions, Skeleton } from 'antd';

export function HealthPage() {
  const { t } = useTranslation();
  const { data, isLoading, isError, error, dataUpdatedAt } = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => getHealth({ signal }),
    refetchInterval: 30_000,
  });

  if (isLoading) return <Skeleton active />;

  if (isError || !data) {
    return (
      <Alert
        type="error"
        showIcon
        message={t('health.error')}
        description={error instanceof Error ? error.message : undefined}
      />
    );
  }

  return (
    <div>
      <PageHeader title={t('health.title')} />
      <Card>
      <Descriptions column={1} size="small">
        <Descriptions.Item label={t('health.apiOk')}>{data.status}</Descriptions.Item>
        <Descriptions.Item label={t('health.dbOk')}>
          {data.db === 'up' ? t('health.dbOk') : t('health.dbDown')}
        </Descriptions.Item>
        <Descriptions.Item label={t('health.lastChecked')}>
          {new Date(dataUpdatedAt).toLocaleString()}
        </Descriptions.Item>
      </Descriptions>
      </Card>
    </div>
  );
}
