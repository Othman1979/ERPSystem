import { useQuery } from '@tanstack/react-query';
import { Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { reportsControllerIncomeStatementByCostCenter } from '@erp/api-client';
import { Num } from '../../components/Num';
import { tableLocale } from '../../components/QueryState';
import { dec, formatAmount } from '../../format/number';
import { palette } from '../../theme';
import { isoDay, PeriodMeta } from './PeriodFilters';
import { buildIncomeByCostCenterRows, columnTitle, type ByCentreRow } from './incomeByCostCenterRows';

/** Export path of the by-centre statement (the toolbar of IncomeStatementTab exports it). */
export const BY_CENTRE_PATH = '/reports/income-statement-by-cost-center';
const INDENT_PX = 18;
const AMOUNT_WIDTH = 140;

/** The amount of a row in one centre column (headings carry no amounts). */
const amountAt = (row: ByCentreRow, index: number): string | undefined =>
  row.kind === 'heading' ? undefined : row.amounts[index];

/** A result line that is negative reads red, as on the plain income statement. */
function AmountCell({ row, value }: { row: ByCentreRow; value: string | undefined }) {
  if (row.kind === 'heading' || value === undefined) return null;
  const negative = row.kind === 'result' && dec(value).lt(0);
  return <Num style={negative ? { color: palette.danger } : undefined}>{formatAmount(value)}</Num>;
}

/** The period both income statement views take from IncomeStatementTab (empty = the API's default). */
export interface IncomePeriodProps {
  from: Dayjs | null;
  to: Dayjs | null;
  /** Reports the period the API used, once the report has loaded. */
  onResolved?: (period: { from: string; to: string }) => void;
}

/**
 * Income statement split by cost centre (ADR-024): revenue and expenses down
 * the side, one amount column per centre and a "no centre" column last, then
 * the total and the net profit footer (equal to the ordinary income statement).
 */
export function IncomeByCostCenterTab({ from, to, onResolved }: IncomePeriodProps) {
  const { t, i18n } = useTranslation();
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-income-by-cost-center', params.from, params.to],
    queryFn: ({ signal }) => reportsControllerIncomeStatementByCostCenter(params, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;

  useEffect(() => {
    if (data && onResolved) onResolved({ from: data.from, to: data.to });
  }, [data, onResolved]);

  const lang = i18n.language;
  const unassigned = t('costCenters.unassigned');
  const rows = data
    ? buildIncomeByCostCenterRows(
        data,
        {
          revenue: t('costCenters.revenue'),
          expenses: t('costCenters.expenses'),
          netRevenue: t('costCenters.netRevenue'),
          totalExpenses: t('costCenters.totalExpenses'),
          netProfit: t('costCenters.netProfit'),
        },
        lang,
      )
    : [];

  // Headings, subtotals and results span the code and name columns, as on the plain statement.
  const columns: ColumnsType<ByCentreRow> = [
    {
      title: t('accounts.code'),
      key: 'code',
      width: 110,
      onCell: (r) => ({ colSpan: r.kind === 'account' ? 1 : 2 }),
      render: (_: unknown, r: ByCentreRow) => (r.kind === 'account' ? r.code : r.label),
    },
    {
      title: t('reports.account'),
      key: 'name',
      width: 240,
      onCell: (r) => ({ colSpan: r.kind === 'account' ? 1 : 0 }),
      render: (_: unknown, r: ByCentreRow) =>
        r.kind === 'account' ? <span style={{ paddingInlineStart: INDENT_PX }}>{r.label}</span> : null,
    },
    ...(data?.columns ?? []).map((column, index) => ({
      title: columnTitle(column, unassigned, lang),
      key: `col:${column.costCenterId ?? 'none'}`,
      width: AMOUNT_WIDTH,
      align: 'right' as const,
      render: (_: unknown, r: ByCentreRow) => <AmountCell row={r} value={amountAt(r, index)} />,
    })),
    {
      title: t('costCenters.total'),
      key: 'total',
      width: AMOUNT_WIDTH,
      align: 'right',
      render: (_: unknown, r: ByCentreRow) => (
        <AmountCell row={r} value={r.kind === 'heading' ? undefined : r.total} />
      ),
    },
  ];

  return (
    <>
      {data && (
        <div className="report-meta">
          <PeriodMeta from={data.from} to={data.to} fiscalYear={data.fiscalYear} />
        </div>
      )}
      <Table<ByCentreRow>
        className="stmt-table"
        rowKey="key"
        size="small"
        loading={isLoading}
        dataSource={rows}
        locale={tableLocale(listQuery)}
        pagination={false}
        scroll={{ x: 'max-content' }}
        rowClassName={(r) => (r.kind === 'account' ? 'stmt-account' : `stmt-${r.kind}`)}
        columns={columns}
      />
    </>
  );
}
