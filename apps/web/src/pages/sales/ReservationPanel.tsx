import { useQuery } from '@tanstack/react-query';
import { Alert, Table, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { salesCycleControllerReservation, type SalesCycleReservationItemDto } from '@erp/api-client';
import { useCompany } from '../../components/CompanyProfileForm';
import { tableLocale } from '../../components/QueryState';
import { qtyCell } from '../../format/cells';
import { salesCycleKeys } from './cycleQueryKeys';
import { reservationShortfalls } from './salesLines';

/** A line the panel shows: the item, and its quantity in base units when the line is saved. */
export interface ReservationLine {
  itemId: string;
  label: string;
  qtyBase?: string;
}

/**
 * Stock held, reserved by other sales orders and available, per item of a
 * sales document (ADR-027 §5). Shown when the company reserves (SOFT or HARD).
 * With `checkStock`, a line above what is available is marked; under HARD the
 * confirmation is refused, and the panel says so.
 */
export function ReservationPanel({
  warehouseId,
  lines,
  checkStock,
}: {
  warehouseId?: string;
  lines: readonly ReservationLine[];
  checkStock: boolean;
}) {
  const { t } = useTranslation();
  const company = useCompany();
  const mode = company.data?.salesReservation ?? 'NONE';
  const itemIds = [...new Set(lines.map((l) => l.itemId))].sort();
  const csv = itemIds.join(',');

  const reservation = useQuery({
    queryKey: salesCycleKeys.reservation(warehouseId ?? '', csv),
    queryFn: ({ signal }) =>
      salesCycleControllerReservation({ warehouseId: warehouseId!, itemIds: csv }, { signal }).then((r) => r.data),
    enabled: mode !== 'NONE' && !!warehouseId && itemIds.length > 0,
  });

  if (mode === 'NONE' || !warehouseId || itemIds.length === 0) return null;

  const rows = reservation.data?.items ?? [];
  const counted = lines.flatMap((l) => (l.qtyBase !== undefined ? [{ itemId: l.itemId, qtyBase: l.qtyBase }] : []));
  const short = checkStock ? reservationShortfalls(counted, rows) : new Set<string>();
  const labelOf = new Map(lines.map((l) => [l.itemId, l.label]));

  return (
    <section className="doc-section">
      <Typography.Title level={5}>{t('salesCycle.reservation.title')}</Typography.Title>
      <Typography.Text type="secondary">
        {mode === 'HARD' ? t('salesCycle.reservation.hardHint') : t('salesCycle.reservation.softHint')}
      </Typography.Text>
      {short.size > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ margin: '12px 0' }}
          message={mode === 'HARD' ? t('salesCycle.reservation.refused') : t('salesCycle.reservation.short')}
        />
      )}
      <Table<SalesCycleReservationItemDto>
        rowKey="itemId"
        size="small"
        pagination={false}
        loading={reservation.isLoading}
        locale={tableLocale(reservation)}
        dataSource={rows}
        columns={[
          {
            title: t('procurement.item'),
            render: (_: unknown, r: SalesCycleReservationItemDto) => labelOf.get(r.itemId) ?? r.itemId,
          },
          { title: t('salesCycle.reservation.onHand'), dataIndex: 'onHand', width: 110, align: 'right' as const, render: qtyCell },
          { title: t('salesCycle.reservation.reserved'), dataIndex: 'reserved', width: 110, align: 'right' as const, render: qtyCell },
          {
            title: t('salesCycle.reservation.available'),
            dataIndex: 'available',
            width: 120,
            align: 'right' as const,
            render: (v: string | null, r: SalesCycleReservationItemDto) => (
              <Typography.Text type={short.has(r.itemId) ? 'warning' : undefined} strong={short.has(r.itemId)}>
                {qtyCell(v)}
              </Typography.Text>
            ),
          },
        ]}
       scroll={{ x: 'max-content' }}/>
    </section>
  );
}
