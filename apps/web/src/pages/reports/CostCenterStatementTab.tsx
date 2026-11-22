import { Select } from 'antd';
import type { Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { journalControllerCostCenterStatement, type CostCenterStatementItemDto } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { ReportCriteria, WinField } from '../../components/WinForm';
import { LoadMore } from '../../components/LoadMore';
import { useCostCenters } from '../../hooks/useCostCenters';
import { useKeysetQuery } from '../../hooks/useKeysetQuery';
import { codeAndName } from '../../i18n/displayName';
import { isoDay, PeriodPickers, ScreenPrintButton } from './PeriodFilters';
import { LedgerTable, type LedgerLine, type LedgerSummary } from './LedgerTable';

/** Lines per "load more" page of a statement (ADR-022 §4). */
const STATEMENT_PAGE_LIMIT = 100;

/**
 * The lines of one cost centre posted in the period, with a running balance
 * that starts at zero (ADR-024). Keyset-paged like the party statement.
 */
export function CostCenterStatementTab() {
  const { t, i18n } = useTranslation();
  const { rows: centres } = useCostCenters();
  const [costCenterId, setCostCenterId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const range = { from: isoDay(from), to: isoDay(to) };
  const selected = centres.find((c) => c.id === costCenterId);

  const statement = useKeysetQuery<CostCenterStatementItemDto, LedgerSummary>({
    key: ['report-cc-statement', costCenterId, range.from, range.to],
    fetch: (cursor, signal) =>
      journalControllerCostCenterStatement(
        { costCenterId: costCenterId ?? '', ...range, limit: STATEMENT_PAGE_LIMIT, cursor },
        { signal },
      ).then((r) => r.data),
    enabled: !!costCenterId,
  });

  // The statement shows each account in the language of the screen.
  const lang = i18n.language;
  const lines: LedgerLine[] = statement.rows.map((r) => ({
    ...r,
    accountName: lang === 'en' && r.accountNameEn ? r.accountNameEn : r.accountName,
  }));

  return (
    <>
      <ReportCriteria
        actions={
          costCenterId && (
            <>
              <ScreenPrintButton />
              <ExportButtons
                path="/reports/cost-center-statement"
                params={{ costCenterId, ...range }}
              />
            </>
          )
        }
      >
            <WinField label={t('costCenters.name')}>
            <Select
              showSearch
              allowClear
              optionFilterProp="label"
              aria-label={t('costCenters.name')}
              placeholder={t('costCenters.pickCentre')}
              style={{ minWidth: 260 }}
              value={costCenterId}
              onChange={setCostCenterId}
              options={centres.map((c) => ({ value: c.id, label: codeAndName(c) }))}
            />
            </WinField>
            <PeriodPickers from={from} to={to} onFrom={setFrom} onTo={setTo} />
      </ReportCriteria>
      <div className="report-meta">
        <span>{t('costCenters.statementHint')}</span>
        {selected && (
          <span>
            {t('costCenters.name')}: <strong>{codeAndName(selected)}</strong>
          </span>
        )}
      </div>
      {!costCenterId ? (
        <div className="report-empty">{t('costCenters.pickCentre')}</div>
      ) : (
        <>
          <LedgerTable
            summary={statement.summary}
            rows={lines}
            loading={statement.query.isLoading}
            query={statement.query}
            withAccount
          />
          <LoadMore
            hasMore={statement.hasMore}
            loading={statement.loadingMore}
            onLoadMore={statement.loadMore}
            shown={statement.rows.length}
          />
        </>
      )}
    </>
  );
}
