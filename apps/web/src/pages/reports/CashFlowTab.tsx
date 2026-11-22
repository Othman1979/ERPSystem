import { useQuery } from '@tanstack/react-query';
import { Tag } from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { reportsControllerCashFlow, type CashFlowSectionDto } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ReportCriteria } from '../../components/WinForm';
import { isoDay, PeriodMeta, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { sectionLines, StatementTable, type StatementLine, type StatementSection } from './StatementTable';

const PATH = '/reports/cash-flow';

const flat = (s: CashFlowSectionDto): StatementSection => ({
  rows: s.rows.map((r) => ({ ...r, depth: 0, isGroup: false })),
  total: s.total,
});

/** Phase 21 (ADR-036): cash flow statement, indirect method, for a period. */
export function CashFlowTab() {
  const { t, i18n } = useTranslation();
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const params = { from: isoDay(from), to: isoDay(to) };
  const listQuery = useQuery({
    queryKey: ['report-cash-flow', params.from, params.to],
    queryFn: ({ signal }) => reportsControllerCashFlow(params, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;
  const lang = i18n.language;

  const lines: StatementLine[] = data
    ? [
        ...sectionLines('o', t('cashFlow.operating'), flat(data.operating), t('cashFlow.operatingTotal'), lang).flatMap(
          (l): StatementLine[] =>
            l.kind === 'heading'
              ? [l, { kind: 'account', key: 'o:np', label: t('cashFlow.netProfit'), depth: 1, amount: data.netProfit }]
              : [l],
        ),
        ...sectionLines('i', t('cashFlow.investing'), flat(data.investing), t('cashFlow.investingTotal'), lang),
        ...sectionLines('f', t('cashFlow.financing'), flat(data.financing), t('cashFlow.financingTotal'), lang),
        { kind: 'result', key: 'net', label: t('cashFlow.netChange'), amount: data.netChange },
        { kind: 'subtotal', key: 'open', label: t('cashFlow.openingCash'), amount: data.openingCash },
        { kind: 'result', key: 'close', label: t('cashFlow.closingCash'), amount: data.closingCash },
      ]
    : [];

  return (
    <>
      <ReportCriteria
        actions={
          <>
            {data && (
              <Tag color={data.reconciles ? 'green' : 'red'}>
                {data.reconciles ? t('cashFlow.reconciles') : t('cashFlow.notReconciled')}
              </Tag>
            )}
            <ScreenPrintButton />
            <ExportButtons path={PATH} params={params} />
          </>
        }
      >
        <PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} resolved={data} />
      </ReportCriteria>
      {data && <PeriodMeta from={data.from} to={data.to} fiscalYear={data.fiscalYear} />}
      <StatementTable lines={lines} loading={isLoading} query={listQuery} />
    </>
  );
}
