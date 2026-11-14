import { useQuery } from '@tanstack/react-query';
import { Segmented } from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reportsControllerIncomeStatement } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { useCostCenters } from '../../hooks/useCostCenters';
import { displayName } from '../../i18n/displayName';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { IncomeByCostCenterTab } from './IncomeByCostCenterTab';
import { sectionLines, StatementTable, type StatementLine } from './StatementTable';

const PATH = '/reports/income-statement';

type IncomeView = 'plain' | 'byCentre';

/**
 * Phase 8: revenue tree, cost of sales, gross profit, expense tree, net profit
 * for a period. With cost centres on, a switch shows the same statement split
 * by centre (ADR-024).
 */
export function IncomeStatementTab() {
  const { t } = useTranslation();
  const { enabled: costCentersEnabled } = useCostCenters();
  const [view, setView] = useState<IncomeView>('plain');
  if (!costCentersEnabled) return <PlainIncomeStatement />;
  return (
    <>
      <ListToolbar
        filters={
          <Segmented<IncomeView>
            value={view}
            onChange={setView}
            options={[
              { value: 'plain', label: t('reports.incomeStatement') },
              { value: 'byCentre', label: t('costCenters.byCentre') },
            ]}
          />
        }
      />
      {view === 'byCentre' ? <IncomeByCostCenterTab /> : <PlainIncomeStatement />}
    </>
  );
}

function PlainIncomeStatement() {
  const { t, i18n } = useTranslation();
  // Empty = the fiscal year containing today (or the end that is set), chosen by the API.
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-income-statement', params.from, params.to],
    queryFn: ({ signal }) => reportsControllerIncomeStatement(params, { signal }).then((r) => r.data),
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
