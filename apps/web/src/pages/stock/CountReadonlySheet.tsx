import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { StockCountDetailDto, StockCountLineDto, StockCountVarianceDto } from '@erp/api-client';
import { Num } from '../../components/Num';
import { qtyCell } from '../../format/cells';
import { formatAmount, formatQty } from '../../format/number';
import { displayName } from '../../i18n/displayName';
import { bookHidden, diffTone, type DiffTone } from './countPayload';
import { useItemUnits } from './stockHooks';

const toneStyle = (tone: DiffTone) => ({
  color: tone === 'shortage' ? 'var(--c-danger)' : tone === 'surplus' ? 'var(--c-success)' : undefined,
  fontWeight: tone === 'shortage' || tone === 'surplus' ? 600 : undefined,
});

/**
 * The lines of a submitted or posted count, read only (ADR-030 §5): book,
 * counted and difference in base units, with the difference's value from the
 * variance report. A line that was never counted shows dashes.
 */
export function CountReadonlySheet({
  detail,
  variance,
}: {
  detail: StockCountDetailDto;
  variance: StockCountVarianceDto | undefined;
}) {
  const { t } = useTranslation();
  const hideBook = bookHidden(detail.lines);
  const valueByItem = useMemo(
    () => new Map((variance?.lines ?? []).map((v) => [v.itemId, v.differenceValue])),
    [variance],
  );

  const columns: ColumnsType<StockCountLineDto> = [
    {
      title: t('items.code'),
      width: 110,
      responsive: ['sm'],
      render: (_: unknown, l: StockCountLineDto) => <span className="count-code">{l.item.code}</span>,
    },
    {
      title: t('common.name'),
      minWidth: 140,
      render: (_: unknown, l: StockCountLineDto) => displayName(l.item) ?? l.item.code,
    },
    { title: t('items.unit'), width: 80, render: (_: unknown, l: StockCountLineDto) => <BaseUnit itemId={l.itemId} /> },
    ...(hideBook
      ? []
      : ([
          { title: t('stock.systemQty'), dataIndex: 'systemQty', width: 110, align: 'right', render: qtyCell },
        ] as ColumnsType<StockCountLineDto>)),
    {
      title: t('stock.countedQty'),
      dataIndex: 'countedQty',
      width: 110,
      align: 'right',
      render: qtyCell,
    },
    ...(hideBook
      ? []
      : ([
          {
            title: t('stock.diff'),
            width: 110,
            align: 'right',
            render: (_: unknown, l: StockCountLineDto) => {
              const tone = diffTone(l.differenceQty);
              const sign = tone === 'surplus' ? '+' : '';
              return (
                <Num style={toneStyle(tone)}>{l.differenceQty ? `${sign}${formatQty(l.differenceQty)}` : '—'}</Num>
              );
            },
          },
        ] as ColumnsType<StockCountLineDto>)),
    {
      title: t('stockCount.variance.value'),
      width: 120,
      align: 'right',
      render: (_: unknown, l: StockCountLineDto) => {
        const value = valueByItem.get(l.itemId);
        if (value === undefined) return '—';
        return <Num style={toneStyle(diffTone(value))}>{formatAmount(value)}</Num>;
      },
    },
  ];

  return (
    <Table<StockCountLineDto>
      rowKey="id"
      size="small"
      dataSource={detail.lines}
      columns={columns}
      pagination={{ pageSize: 25, hideOnSinglePage: true }}
      scroll={{ x: 'max-content' }}
    />
  );
}

/** The item's base unit code, from its cached item card. */
function BaseUnit({ itemId }: { itemId: string }) {
  const item = useItemUnits(itemId);
  return <>{item.data?.baseUnit.code ?? '—'}</>;
}
