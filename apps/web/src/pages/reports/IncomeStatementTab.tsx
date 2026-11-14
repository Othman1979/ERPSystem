import { useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData } from '@erp/api-client';
import { ExportButtons, queryString } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { displayName } from '../../i18n/displayName';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { sectionLines, StatementTable, type StatementLine, type StatementSection } from './StatementTable';

interface CostOfSalesRow {
  kind: 'COGS' | 'INVENTORY_ADJUSTMENT';
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  amount: string;
}

interface IncomeStatement {
  from: string;
  to: string;
  fiscalYear: { id: string; code: string } | null;
  revenue: StatementSection;
  costOfSales: { rows: CostOfSalesRow[]; total: string };
  grossProfit: string;
  expenses: StatementSection;
  netProfit: string;
}

const PATH = '/reports/income-statement';

/** Phase 8: revenue tree, cost of sales, gross profit, expense tree, net profit for a period. */
export function IncomeStatementTab() {
  const { t, i18n } = useTranslation();
  // Empty = the fiscal year containing today (or the end that is set), chosen by the API.
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-income-statement', params.from, params.to],
    queryFn: ({ signal }) => apiFetchData<IncomeStatement>(`/api/v1${PATH}${queryString(params)}`, { signal }),
  });
  const { data, isLoading } = listQuery;

  const lang = i18n.language;
  const lines: StatementLine[] = data
    ? [
        ...sectionLines('rev', t('reports.revenue'), data.revenue, t('reports.netRevenue'), lang),
        { kind: 'heading', key: 'cos:h', label: t('reports.costOfSales') },
        ...data.costOfSales.rows.map(
          (r): StatementLine => ({
            kind: 'account',
            key: `cos:${r.accountId}`,
            code: r.code,
            label: displayName(r, lang),
            depth: 1,
            amount: r.amount,
          }),
        ),
        { kind: 'subtotal', key: 'cos:t', label: t('reports.totalCostOfSales'), amount: data.costOfSales.total },
        { kind: 'result', key: 'gross', label: t('reports.grossProfit'), amount: data.grossProfit },
        ...sectionLines('exp', t('reports.expenses'), data.expenses, t('reports.totalExpenses'), lang),
        { kind: 'result', key: 'net', label: t('reports.netProfit'), amount: data.netProfit },
      ]
    : [];

  return (
    <>
      <ListToolbar
        filters={<PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} resolved={data} />}
        actions={
          <>
            <ScreenPrintButton />
            <ExportButtons path={PATH} params={params} />
          </>
        }
      />
      {data && (
        <div className="report-meta">
          <PeriodMeta from={data.from} to={data.to} fiscalYear={data.fiscalYear} />
        </div>
      )}
      <StatementTable lines={lines} loading={isLoading} query={listQuery} />
    </>
  );
}
