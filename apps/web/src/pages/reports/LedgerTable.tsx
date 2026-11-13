import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Num } from '../../components/Num';
import { tableLocale, type ListQueryState } from '../../components/QueryState';
import { dec, formatAmount, type NumericInput } from '../../format/number';

export interface LedgerLine {
  lineId: string;
  entryNo: string | null;
  entryDate: string;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
  accountCode?: string;
  accountName?: string;
}

/** Statement JSON (account or party): opening, movements, closing (ADR-008). */
export interface LedgerData {
  openingBalance: string;
  openingDebit: string;
  openingCredit: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  closingDebit: string;
  closingCredit: string;
  rows: LedgerLine[];
}

type Row = LedgerLine & { kind?: 'opening' };

/** A debit / credit cell: blank when zero. */
export const sideCell =(v: NumericInput) => (v === undefined || v === null || dec(v).isZero() ? '' : <Num>{formatAmount(v)}</Num>);

/**
 * Account / party statement table: an opening-balance row, the period's
 * lines with a running balance, then the movements total and the closing
 * balance — each balance shown in the debit or credit column.
 */
export function LedgerTable({
  data,
  loading,
  query,
  withAccount = false,
}: {
  data: LedgerData | undefined;
  loading: boolean;
  /** The query that fetched `data`: its failure shows in the table, not as an empty ledger. */
  query: ListQueryState;
  /** Party statements show the control account of each line. */
  withAccount?: boolean;
}) {
  const { t } = useTranslation();
  const rows: Row[] = data
    ? [
        {
          kind: 'opening',
          lineId: 'opening',
          entryNo: null,
          entryDate: '',
          description: t('reports.openingPeriod'),
          debit: data.openingDebit,
          credit: data.openingCredit,
          balance: data.openingBalance,
        },
        ...data.rows,
      ]
    : [];
  const columns: ColumnsType<Row> = [
    { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 150, className: 'nowrap', render: (v: string | null) => v ?? '' },
    {
      title: t('journal.date'),
      dataIndex: 'entryDate',
      width: 110,
      render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : ''),
    },
    ...(withAccount
      ? [
          { title: t('accounts.code'), dataIndex: 'accountCode', width: 90 },
          { title: t('common.name'), dataIndex: 'accountName' },
        ]
      : []),
    { title: t('common.description'), dataIndex: 'description' },
    { title: t('journal.debit'), dataIndex: 'debit', align: 'right', width: 120, render: sideCell },
    { title: t('journal.credit'), dataIndex: 'credit', align: 'right', width: 120, render: sideCell },
    {
      title: t('reports.balance'),
      dataIndex: 'balance',
      align: 'right',
      width: 130,
      render: (v: string) => <Num>{formatAmount(v)}</Num>,
    },
  ];
  const labelSpan = withAccount ? 5 : 3;

  return (
    <Table<Row>
      rowKey="lineId"
      size="small"
      loading={loading}
      dataSource={rows}
      locale={tableLocale(query)}
      pagination={{ pageSize: 50 }}
      columns={columns}
      rowClassName={(r) => (r.kind === 'opening' ? 'report-row-strong' : '')}
      summary={() =>
        data ? (
          <>
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={labelSpan}>
                {t('reports.movementsTotal')}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                <Num>{formatAmount(data.totalDebit)}</Num>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                <Num>{formatAmount(data.totalCredit)}</Num>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} />
            </Table.Summary.Row>
            <Table.Summary.Row className="report-row-strong">
              <Table.Summary.Cell index={0} colSpan={labelSpan}>
                {t('reports.closingPeriod')}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                {sideCell(data.closingDebit)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                {sideCell(data.closingCredit)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                <Num>{formatAmount(data.closingBalance)}</Num>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          </>
        ) : null
      }
    />
  );
}
