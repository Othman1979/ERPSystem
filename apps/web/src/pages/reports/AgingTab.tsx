import { useQuery } from '@tanstack/react-query';
import { Segmented, Table, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData } from '@erp/api-client';
import { Num } from '../../components/Num';
import { amountCell } from '../../format/cells';
import { formatAmount } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
type Bucket = (typeof BUCKETS)[number];

type AgingAmounts = Record<Bucket | 'total', string>;
interface AgingRow extends AgingAmounts {
  partyId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}
interface AgingResponse {
  asOf: string;
  rows: AgingRow[];
  totals: AgingAmounts;
}

/** Phase 6: open credit balances by days past due, per customer or supplier. */
export function AgingTab() {
  const { t } = useTranslation();
  const [partyType, setPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const { data, isLoading } = useQuery({
    queryKey: ['report-aging', partyType],
    queryFn: () => apiFetchData<AgingResponse>(`/api/v1/reports/aging?partyType=${partyType}`),
  });

  return (
    <>
      <Segmented
        style={{ marginBottom: 12 }}
        value={partyType}
        onChange={(v) => setPartyType(v as 'CUSTOMER' | 'SUPPLIER')}
        options={[
          { value: 'CUSTOMER', label: t('reports.customers') },
          { value: 'SUPPLIER', label: t('reports.suppliers') },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {t('reports.agingNote')} {data?.asOf ? `(${data.asOf})` : ''}
      </Typography.Paragraph>
      <Table
        rowKey="partyId"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={false}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: t('reports.party'), render: (_: unknown, r: AgingRow) => codeAndName(r) },
          ...BUCKETS.map((b) => ({
            title: t(`reports.${b}`),
            dataIndex: b,
            width: 120,
            align: 'right' as const,
            render: amountCell,
          })),
          {
            title: t('reports.agingTotal'),
            dataIndex: 'total',
            width: 130,
            align: 'right' as const,
            render: (v: string) => <strong>{amountCell(v)}</strong>,
          },
        ]}
        summary={() =>
          data && data.rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>{t('reports.agingTotal')}</Typography.Text>
              </Table.Summary.Cell>
              {[...BUCKETS, 'total' as const].map((b, i) => (
                <Table.Summary.Cell key={b} index={i + 1} align="right">
                  <Typography.Text strong>
                    <Num>{formatAmount(data.totals[b])}</Num>
                  </Typography.Text>
                </Table.Summary.Cell>
              ))}
            </Table.Summary.Row>
          ) : null
        }
      />
    </>
  );
}
