import { useQuery } from '@tanstack/react-query';
import { Select, Table, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData, warehousesControllerList } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { tableLocale } from '../../components/QueryState';
import { Num } from '../../components/Num';
import { amountCell, qtyCell } from '../../format/cells';
import { formatAmount } from '../../format/number';
import { bothNames, codeAndName } from '../../i18n/displayName';

interface ItemBalanceRow {
  itemId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  unit: { code: string; nameAr: string } | null;
  openingQty: string;
  openingValue: string;
  inQty: string;
  inValue: string;
  outQty: string;
  outValue: string;
  closingQty: string;
  closingValue: string;
}

interface ItemBalances {
  rows: ItemBalanceRow[];
  totals: { openingValue: string; inValue: string; outValue: string; closingValue: string };
}

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * Items balance (ميزان المواد, ADR-008): per item the opening quantity and
 * value, the period's ins and outs, and the closing quantity and value.
 * Shares the page's date range.
 */
export function ItemBalancesTab({
  range,
  dateFilters,
  printButton,
}: {
  range: { from?: string; to?: string };
  dateFilters: ReactNode;
  printButton: ReactNode;
}) {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState<string | undefined>(undefined);
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
  });
  const params = { warehouseId, ...range };
  const listQuery = useQuery({
    queryKey: ['report-item-balances', warehouseId, range.from, range.to],
    queryFn: () => apiFetchData<ItemBalances>(`/api/v1/stock/item-balances${qs(params)}`),
  });
  const { data, isLoading } = listQuery;

  const pair = (key: 'opening' | 'in' | 'out' | 'closing', title: string) => ({
    title,
    children: [
      { title: t('reports.qty'), dataIndex: `${key}Qty`, align: 'right' as const, width: 90, render: qtyCell },
      { title: t('reports.value'), dataIndex: `${key}Value`, align: 'right' as const, width: 110, render: amountCell },
    ],
  });

  return (
    <>
      <ListToolbar
        filters={
          <>
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('reports.allWarehouses')}
              style={{ minWidth: 200 }}
              value={warehouseId}
              onChange={setWarehouseId}
              options={(warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }))}
            />
            {dateFilters}
          </>
        }
        actions={
          <>
            {printButton}
            <ExportButtons path="/stock/item-balances" params={params} />
          </>
        }
      />
      <div className="report-meta">
        <Typography.Text type="secondary">{t('reports.itemBalancesNote')}</Typography.Text>
      </div>
      <Table<ItemBalanceRow>
        rowKey="itemId"
        size="small"
        bordered
        loading={isLoading}
        dataSource={data?.rows ?? []}
        locale={tableLocale(listQuery)}
        pagination={false}
        scroll={{ x: 1100 }}
        columns={[
          { title: t('accounts.code'), dataIndex: 'code', width: 100, fixed: 'left' },
          { title: t('reports.item'), key: 'name', render: (_: unknown, r) => bothNames(r) },
          pair('opening', t('reports.openingPeriod')),
          pair('in', t('reports.qtyIn')),
          pair('out', t('reports.qtyOut')),
          pair('closing', t('reports.closingPeriod')),
        ]}
        summary={() =>
          data && data.rows.length > 0 ? (
            <Table.Summary.Row className="report-row-strong">
              <Table.Summary.Cell index={0} colSpan={2}>
                {t('journal.total')}
              </Table.Summary.Cell>
              {(['openingValue', 'inValue', 'outValue', 'closingValue'] as const).map((k, i) => [
                <Table.Summary.Cell key={`${k}-q`} index={1 + i * 2} />,
                <Table.Summary.Cell key={k} index={2 + i * 2} align="right">
                  <Num>{formatAmount(data.totals[k])}</Num>
                </Table.Summary.Cell>,
              ])}
            </Table.Summary.Row>
          ) : null
        }
      />
    </>
  );
}
