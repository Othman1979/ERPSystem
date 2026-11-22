import { useQuery } from '@tanstack/react-query';
import { Segmented } from 'antd';
import type { Dayjs } from 'dayjs';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reportsControllerIncomeStatement } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ReportCriteria, WinField } from '../../components/WinForm';
import { useCostCenters } from '../../hooks/useCostCenters';
import { displayName } from '../../i18n/displayName';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { BY_CENTRE_PATH, IncomeByCostCenterTab, type IncomePeriodProps } from './IncomeByCostCenterTab';
import { sectionLines, StatementTable, type StatementLine } from './StatementTable';

const PATH = '/reports/income-statement';

type IncomeView = 'plain' | 'byCentre';

/** The period the API used for the report (shown as the placeholder of empty pickers). */
type ResolvedPeriod = { from: string; to: string };

/**
 * Phase 8: revenue tree, cost of sales, gross profit, expense tree, net profit
 * for a period. With cost centres on, a switch shows the same statement split
 * by centre (ADR-024). The period and the toolbar belong here, so switching
 * the view keeps the period.
 */
export function IncomeStatementTab() {
  const { t } = useTranslation();
  const { enabled: costCentersEnabled } = useCostCenters();
  const [view, setView] = useState<IncomeView>('plain');
  // Empty = the fiscal year containing today (or the end that is set), chosen by the API.
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const [resolved, setResolved] = useState<ResolvedPeriod | undefined>(undefined);
  const params = { from: isoDay(from), to: isoDay(to) };
  const byCentre = costCentersEnabled && view === 'byCentre';
  const period: IncomePeriodProps = { from, to, onResolved: setResolved };

  return (
    <>
      <ReportCriteria
        actions={
          <>
            <ScreenPrintButton />
            <ExportButtons path={byCentre ? BY_CENTRE_PATH : PATH} params={params} />
          </>
        }
      >
        {costCentersEnabled && (
          <WinField label={t('reports.incomeStatement')}>
            <Segmented<IncomeView>
              value={view}
              onChange={setView}
              options={[
                { value: 'plain', label: t('reports.incomeStatement') },
                { value: 'byCentre', label: t('costCenters.byCentre') },
              ]}
            />
          </WinField>
        )}
        <PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} resolved={resolved} />
      </ReportCriteria>
      {byCentre ? <IncomeByCostCenterTab {...period} /> : <PlainIncomeStatement {...period} />}
    </>
  );
}

function PlainIncomeStatement({ from, to, onResolved }: IncomePeriodProps) {
  const { t, i18n } = useTranslation();
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-income-statement', params.from, params.to],
    queryFn: ({ signal }) => reportsControllerIncomeStatement(params, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;

  useEffect(() => {
    if (data && onResolved) onResolved({ from: data.from, to: data.to });
  }, [data, onResolved]);

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
      {data && (
        <div className="report-meta">
          <PeriodMeta from={data.from} to={data.to} fiscalYear={data.fiscalYear} />
        </div>
      )}
      <StatementTable lines={lines} loading={isLoading} query={listQuery} />
    </>
  );
}
