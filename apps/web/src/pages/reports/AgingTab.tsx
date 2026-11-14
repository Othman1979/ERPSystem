import { useQuery } from '@tanstack/react-query';
import { PrinterOutlined } from '@ant-design/icons';
import { Button, DatePicker, Segmented, Table, Tooltip, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { treasuryControllerAging, type AgingReportRowDto } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { tableLocale } from '../../components/QueryState';
import { Num } from '../../components/Num';
import { amountCell } from '../../format/cells';
import { formatAmount } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

const BUCKETS = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
/** `total` = aged buckets; `balance` = total + unapplied = the party's control-account balance. */
const SUMMARY_COLUMNS = [...BUCKETS, 'total', 'unapplied', 'balance'] as const;
type AgingRow = AgingReportRowDto;

/** Phase 6: open credit balances by days past due, per customer or supplier, as of a date. */
export function AgingTab() {
  const { t } = useTranslation();
  const [partyType, setPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  // The local calendar date, so "today" is the user's day rather than the server's UTC day.
  const [asOf, setAsOf] = useState<Dayjs>(() => dayjs());
  const asOfParam = asOf.format('YYYY-MM-DD');
  const listQuery = useQuery({
    queryKey: ['report-aging', partyType, asOfParam],
    queryFn: ({ signal }) =>
      treasuryControllerAging({ partyType, asOf: asOfParam }, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;

  return (
    <>
      <ListToolbar
        filters={
          <>
            <Segmented
              value={partyType}
              onChange={(v) => setPartyType(v as 'CUSTOMER' | 'SUPPLIER')}
              options={[
                { value: 'CUSTOMER', label: t('reports.customers') },
                { value: 'SUPPLIER', label: t('reports.suppliers') },
              ]}
            />
            <DatePicker
              value={asOf}
              onChange={(d) => d && setAsOf(d)}
              allowClear={false}
              placeholder={t('reports.asOf')}
              prefix={t('reports.asOf')}
              aria-label={t('reports.asOf')}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('reports.agingNote')}
            </Typography.Text>
          </>
        }
        actions={
          <>
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
            <ExportButtons path="/reports/aging" params={{ partyType, asOf: asOfParam }} />
          </>
        }
      />
      <Table
        rowKey="partyId"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        locale={tableLocale(listQuery)}
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
          {
            title: (
              <Tooltip title={t('reports.unappliedHint')}>
                <span>{t('reports.unapplied')}</span>
              </Tooltip>
            ),
            dataIndex: 'unapplied',
            width: 120,
            align: 'right' as const,
            render: amountCell,
          },
          {
            title: t('reports.balance'),
            dataIndex: 'balance',
            width: 130,
            align: 'right' as const,
            render: amountCell,
          },
        ]}
        summary={() =>
          data && data.rows.length > 0 ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>{t('reports.agingTotal')}</Typography.Text>
              </Table.Summary.Cell>
              {SUMMARY_COLUMNS.map((b, i) => (
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
