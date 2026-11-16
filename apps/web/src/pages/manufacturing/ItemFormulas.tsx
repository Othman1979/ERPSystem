import { PlusOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { Button, Space, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { bomsControllerList, type BomStatus } from '@erp/api-client';
import { useAuth } from '../../auth/AuthContext';
import { PERMISSIONS } from '../../auth/permissions';
import { StatusTag, type StatusTone } from '../../components/StatusTag';
import { formatAmount } from '../../format/number';
import { bomKeys } from './manufacturingQueries';

const TONE: Record<BomStatus, StatusTone> = { DRAFT: 'neutral', ACTIVE: 'success', INACTIVE: 'neutral' };

/**
 * The formulas of a manufactured item, on its page (ADR-031 §5): each version
 * with its status and applied cost, opened in the BOM screen, and a button for
 * a new formula of this item.
 */
export function ItemFormulas({ itemId }: { itemId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { can } = useAuth();
  const versions = useQuery({
    queryKey: bomKeys.ofItem(itemId),
    queryFn: ({ signal }) => bomsControllerList({ itemId, pageSize: 100 }, { signal }).then((r) => r.data.items),
  });

  return (
    <section aria-label={t('manufacturing.formulas.title')} style={{ marginTop: 16 }}>
      <Space wrap align="center" style={{ justifyContent: 'space-between', width: '100%' }}>
        <Typography.Title level={5} style={{ margin: 0 }}>
          {t('manufacturing.formulas.title')}
        </Typography.Title>
        {can(PERMISSIONS.ITEM_MANAGE) && (
          <Button size="small" icon={<PlusOutlined />} onClick={() => navigate(`/boms?new=1&itemId=${itemId}`)}>
            {t('manufacturing.bom.new')}
          </Button>
        )}
      </Space>
      {versions.isError ? (
        <Typography.Text type="danger">{t('common.loadFailed')}</Typography.Text>
      ) : versions.data && versions.data.length === 0 ? (
        <Typography.Text type="secondary">{t('manufacturing.formulas.empty')}</Typography.Text>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {(versions.data ?? []).map((b) => (
            <li key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '6px 0' }}>
              <Button type="link" style={{ padding: 0 }} onClick={() => navigate(`/boms?bomId=${b.id}`)}>
                {`v${b.versionNo}`}
              </Button>
              <StatusTag tone={TONE[b.status]}>{t(`manufacturing.status.${b.status}`)}</StatusTag>
              <Typography.Text type="secondary">
                {t('manufacturing.bom.appliedCost')}: {formatAmount(b.appliedCostPerUnit)}
              </Typography.Text>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
