import { useQuery } from '@tanstack/react-query';
import { Alert, Table, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useTranslation } from 'react-i18next';
import { bomsControllerCost, type BomCostCardDto, type BomCostLineDto } from '@erp/api-client';
import { DocField, DocFields, DocValue } from '../../components/DocLayout';
import { StatusTag } from '../../components/StatusTag';
import { Num } from '../../components/Num';
import { formatAmount, formatPercent, formatQty, formatUnitCost, dec } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';
import { bomKeys } from './manufacturingQueries';

/**
 * The colour of a margin: a negative one (the price is below the cost) is
 * danger, otherwise the text stays plain. The words say it too (ADR-020 §3).
 */
export function marginTone(margin: string | null | undefined): 'danger' | undefined {
  return margin != null && dec(margin).isNegative() ? 'danger' : undefined;
}

/**
 * The cost card of an ACTIVE formula (ADR-032 §4): each leaf component at its
 * current average cost, the total and the cost per output unit, the item's sale
 * price net of tax, and the margin in value and in percent.
 */
export function BomCostCard({ bomId }: { bomId: string }) {
  const { t } = useTranslation();
  const cost = useQuery({
    queryKey: bomKeys.cost(bomId),
    queryFn: ({ signal }) => bomsControllerCost(bomId, { signal }).then((r) => r.data),
  });
  return (
    <section aria-label={t('manufacturing.bom.costCard')} style={{ marginTop: 16 }}>
      <Typography.Title level={5}>{t('manufacturing.bom.costCard')}</Typography.Title>
      {cost.isError ? (
        <Alert type="error" showIcon message={t('common.loadFailed')} />
      ) : cost.data ? (
        <CostCardView card={cost.data} />
      ) : (
        <Typography.Text type="secondary">{t('common.loading')}</Typography.Text>
      )}
    </section>
  );
}

/** The card's content, from the API's figures (no arithmetic here: money is strings, ADR-031 §10). */
export function CostCardView({ card }: { card: BomCostCardDto }) {
  const { t } = useTranslation();
  const columns: ColumnsType<BomCostLineDto> = [
    { title: t('manufacturing.bom.component'), render: (_: unknown, l: BomCostLineDto) => codeAndName(l.componentItem) },
    {
      title: t('manufacturing.bom.baseQty'),
      align: 'right',
      render: (_: unknown, l: BomCostLineDto) => (
        <Num>{`${formatQty(l.qtyBase)} ${l.componentItem.baseUnit.code}`}</Num>
      ),
    },
    {
      title: t('manufacturing.bom.costAvg'),
      align: 'right',
      render: (_: unknown, l: BomCostLineDto) => <Num>{formatUnitCost(l.avgCost)}</Num>,
    },
    {
      title: t('manufacturing.bom.costLine'),
      align: 'right',
      render: (_: unknown, l: BomCostLineDto) => (
        <span>
          <Num>{formatAmount(l.totalCost)}</Num>
          {l.zeroCost && (
            <StatusTag tone="warning">
              {t('manufacturing.bom.zeroCostTag')}
            </StatusTag>
          )}
        </span>
      ),
    },
  ];
  const margin = card.margin ?? null;
  const tone = marginTone(margin);

  return (
    <>
      {card.missingBom && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={t('manufacturing.bom.missingBomWarning')} />}
      {card.zeroCostWarning && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={t('manufacturing.bom.zeroCostWarning')} />}
      <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
        {t('manufacturing.bom.costCardHint')}
      </Typography.Text>
      <Table<BomCostLineDto>
        rowKey="componentItemId"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={card.lines}
        columns={columns}
      />
      <div style={{ marginTop: 12 }}>
      <DocFields>
        <DocField label={t('manufacturing.bom.costTotal')}>
          <DocValue>
            <Num>{formatAmount(card.totalCost)}</Num>
          </DocValue>
        </DocField>
        <DocField label={t('manufacturing.bom.costPerUnit')}>
          <DocValue>
            <Num>{formatUnitCost(card.unitCost)}</Num>
          </DocValue>
        </DocField>
        {card.salePriceNet != null ? (
          <DocField label={t('manufacturing.bom.salePriceNet')}>
            <DocValue>
              <Num>{formatAmount(card.salePriceNet)}</Num>
            </DocValue>
          </DocField>
        ) : (
          <DocField label={t('manufacturing.bom.salePriceNet')} wide>
            <DocValue>
              <Typography.Text type="secondary">{t('manufacturing.bom.noSalePrice')}</Typography.Text>
            </DocValue>
          </DocField>
        )}
        {margin != null && (
          <DocField label={t('manufacturing.bom.margin')}>
            <DocValue>
              <Typography.Text type={tone} strong={tone === 'danger'} data-testid="margin-value">
                <Num>{formatAmount(margin)}</Num>
              </Typography.Text>
              <span style={{ margin: '0 8px' }}>·</span>
              <Typography.Text type={tone} data-testid="margin-pct">
                <Num>{`${formatPercent(card.marginPct)}%`}</Num>
              </Typography.Text>
              {tone === 'danger' && (
                <StatusTag tone="danger">{t('manufacturing.bom.negativeMargin')}</StatusTag>
              )}
            </DocValue>
          </DocField>
        )}
      </DocFields>
      </div>
    </>
  );
}
