import { useQuery } from '@tanstack/react-query';
import { DatePicker, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetchData } from '@erp/api-client';
import { ExportButtons, queryString } from '../../components/ExportButtons';
import { ListToolbar } from '../../components/ListToolbar';
import { Num } from '../../components/Num';
import { dec, formatAmount } from '../../format/number';
import { palette } from '../../theme';
import { isoDay, ScreenPrintButton } from './PeriodFilters';
import { sectionLines, StatementTable, type StatementLine, type StatementSection } from './StatementTable';

interface BalanceSheet {
  asOf: string;
  yearStart: string;
  fiscalYear: { id: string; code: string } | null;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  /** Σ (Cr − Dr) of revenue + expenses before the fiscal year (no closing entries). */
  priorYears: string;
  /** The same from the fiscal year's start to asOf. */
  yearProfit: string;
  totalLiabilitiesAndEquity: string;
  difference: string;
  balanced: boolean;
}

const PATH = '/reports/balance-sheet';

/** Phase 8: assets = liabilities + equity + unclosed profits, as of a date. */
export function BalanceSheetTab() {
  const { t, i18n } = useTranslation();
  // The local calendar date, like the aging report.
  const [asOf, setAsOf] = useState<Dayjs>(() => dayjs());
  const params = { asOf: isoDay(asOf) };
  const listQuery = useQuery({
    queryKey: ['report-balance-sheet', params.asOf],
    queryFn: ({ signal }) => apiFetchData<BalanceSheet>(`/api/v1${PATH}${queryString(params)}`, { signal }),
  });
  const { data, isLoading } = listQuery;

  const lang = i18n.language;
  const lines: StatementLine[] = data
    ? [
        ...sectionLines('a', t('reports.assets'), data.assets, t('reports.totalAssets'), lang),
        ...sectionLines('l', t('reports.liabilities'), data.liabilities, t('reports.totalLiabilities'), lang),
        // Equity: its accounts, then the profits no closing entry has moved into it yet.
        ...sectionLines('e', t('reports.equity'), data.equity, t('reports.totalEquity'), lang).flatMap(
          (l): StatementLine[] =>
            l.kind === 'subtotal'
              ? [
                  { kind: 'account', key: 'e:prior', label: t('reports.priorYearsProfit'), depth: 1, amount: data.priorYears },
                  { kind: 'account', key: 'e:year', label: t('reports.yearProfit'), depth: 1, amount: data.yearProfit },
                  {
                    ...l,
                    amount: dec(data.equity.total).plus(dec(data.priorYears)).plus(dec(data.yearProfit)).toFixed(3),
                  },
                ]
              : [l],
        ),
        {
          kind: 'result',
          key: 'le',
          label: t('reports.totalLiabilitiesEquity'),
          amount: data.totalLiabilitiesAndEquity,
        },
      ]
    : [];

  return (
    <>
      <ListToolbar
        filters={
          <DatePicker
            value={asOf}
            onChange={(d) => d && setAsOf(d)}
            allowClear={false}
            prefix={t('reports.asOf')}
            aria-label={t('reports.asOf')}
          />
        }
        actions={
          <>
            {data && (
              <Tag color={data.balanced ? 'green' : 'red'}>
                {data.balanced ? t('reports.balanced') : t('reports.unbalanced')}
              </Tag>
            )}
            <ScreenPrintButton />
            <ExportButtons path={PATH} params={params} />
          </>
        }
      />
      {data && (
        <div className="report-meta">
          <span>
            {t('reports.fiscalYearStart')}: <strong><Num>{data.yearStart}</Num></strong>
          </span>
          {data.fiscalYear && (
            <span>
              {t('reports.fiscalYear')}: <strong>{data.fiscalYear.code}</strong>
            </span>
          )}
          {!data.balanced && (
            <span style={{ color: palette.danger }}>
              {t('reports.difference')}: <strong><Num>{formatAmount(data.difference)}</Num></strong>
            </span>
          )}
        </div>
      )}
      <StatementTable lines={lines} loading={isLoading} query={listQuery} />
    </>
  );
}
