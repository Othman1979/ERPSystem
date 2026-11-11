import { useQuery } from '@tanstack/react-query';
import { PrinterOutlined } from '@ant-design/icons';
import { Button, Card, DatePicker, Select, Table, Tabs, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  accountingControllerListAccounts,
  fiscalControllerListYears,
  apiFetchData,
  partiesControllerList,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar } from '../components/ListToolbar';
import { bothNames, codeAndName } from '../i18n/displayName';
import { Num } from '../components/Num';
import { AgingTab } from './reports/AgingTab';
import { BalanceSheetTab } from './reports/BalanceSheetTab';
import { IncomeStatementTab } from './reports/IncomeStatementTab';
import { ItemBalancesTab } from './reports/ItemBalancesTab';
import { LedgerTable, sideCell, type LedgerData } from './reports/LedgerTable';
import { TaxSummaryTab } from './reports/TaxSummaryTab';
import { TradeSummaryTab } from './reports/TradeSummaryTab';
import { ExportButtons } from '../components/ExportButtons';
import { formatAmount } from '../format/number';

interface Account {
  id: string;
  code: string;
  nameAr: string;
}

/** Opening / movement / closing, each debit and credit (ADR-008). */
const TB_COLUMNS = [
  'openingDebit',
  'openingCredit',
  'periodDebit',
  'periodCredit',
  'closingDebit',
  'closingCredit',
] as const;
type TbColumn = (typeof TB_COLUMNS)[number];

interface TbRow extends Record<TbColumn, string> {
  accountId: string;
  /** PRIOR_YEARS: the computed "unclosed prior years profit" row (ADR-008 §7). */
  kind: 'PRIOR_YEARS' | null;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

interface FiscalYearOption {
  id: string;
  code: string;
  startDate: string;
  endDate: string;
}

interface TbResponse {
  rows: TbRow[];
  totals: Record<TbColumn, string>;
  balanced: boolean;
}

interface LedgerResponse extends LedgerData {
  account: { code: string; nameAr: string; nameEn?: string | null };
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}



export function ReportsPage() {
  const { t } = useTranslation();
  // ?tab=sales&from&to&groupBy (dashboard links) opens a report with those filters.
  const [searchParams] = useSearchParams();
  const linkFilters = {
    from: searchParams.get('from'),
    to: searchParams.get('to'),
    groupBy: searchParams.get('groupBy'),
  };
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  // ?tab=gl&accountId= (account statement shortcuts on accounts and cash boxes).
  const [accountId, setAccountId] = useState<string | undefined>(searchParams.get('accountId') ?? undefined);
  const [tab, setTab] = useState(searchParams.get('tab') ?? 'tb');
  // Double-clicking a trial balance row opens that account's statement.
  const openStatement = (id: string) => {
    setAccountId(id);
    setTab('gl');
  };
  const [partyType, setPartyType] = useState<'CUSTOMER' | 'SUPPLIER' | undefined>(undefined);
  const [partyId, setPartyId] = useState<string | undefined>(undefined);

  const { data: accounts } = useQuery({
    queryKey: ['accounts-all'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as Account[]),
  });
  const accountOptions = (accounts ?? []).map((a) => ({
    value: a.id,
    label: codeAndName(a),
  }));

  const range = {
    from: from?.format('YYYY-MM-DD'),
    to: to?.format('YYYY-MM-DD'),
  };

  // The from/to filters above apply to the trial balance too.
  const { data: tb, isLoading: tbLoading } = useQuery({
    queryKey: ['report-tb', range.from, range.to],
    queryFn: () => apiFetchData<TbResponse>(`/api/v1/reports/trial-balance${qs(range)}`),
  });

  const { data: parties } = useQuery({
    queryKey: ['parties', partyType],
    queryFn: () =>
      partiesControllerList({ partyType: partyType ?? '', isActive: '' }).then(
        (r) => r.data as unknown as { id: string; code: string; nameAr: string; nameEn: string | null }[],
      ),
    enabled: !!partyType,
  });

  const { data: gl, isLoading: glLoading } = useQuery({
    queryKey: ['report-gl', accountId, range.from, range.to],
    queryFn: () =>
      apiFetchData<LedgerResponse>(
        `/api/v1/reports/general-ledger${qs({ accountId, ...range })}`,
      ),
    enabled: !!accountId,
  });

  const { data: statement, isLoading: stLoading } = useQuery({
    queryKey: ['report-statement', partyType, partyId, range.from, range.to],
    queryFn: () =>
      apiFetchData<LedgerData>(
        `/api/v1/reports/party-statement${qs({ partyType, partyId, ...range })}`,
      ),
    enabled: !!partyType && !!partyId,
  });

  // A fiscal year fills the date range (the dates stay editable).
  const { data: years } = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: () => fiscalControllerListYears().then((r) => r.data as unknown as FiscalYearOption[]),
  });
  const selectedYear = (years ?? []).find(
    (y) => range.from === y.startDate.slice(0, 10) && range.to === y.endDate.slice(0, 10),
  );

  // Each report shows only the filters it uses; the date range is shared between tabs.
  const dateFilters = (
    <>
      <Select
        allowClear
        placeholder={t('reports.fiscalYear')}
        style={{ minWidth: 130 }}
        value={selectedYear?.id}
        onChange={(id?: string) => {
          const y = (years ?? []).find((x) => x.id === id);
          setFrom(y ? dayjs(y.startDate.slice(0, 10)) : null);
          setTo(y ? dayjs(y.endDate.slice(0, 10)) : null);
        }}
        options={(years ?? []).map((y) => ({ value: y.id, label: y.code }))}
      />
      <DatePicker placeholder={t('reports.from')} value={from} onChange={setFrom} />
      <DatePicker placeholder={t('reports.to')} value={to} onChange={setTo} />
    </>
  );
  const printButton = (
    <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
      {t('common.print')}
    </Button>
  );
  // Trial balance column groups: opening, movements, closing — debit / credit each.
  const tbGroup = (prefix: 'opening' | 'period' | 'closing', title: string) => ({
    title,
    children: (['Debit', 'Credit'] as const).map((side) => ({
      title: t(side === 'Debit' ? 'journal.debit' : 'journal.credit'),
      dataIndex: `${prefix}${side}`,
      align: 'right' as const,
      width: 115,
      render: sideCell,
    })),
  });

  return (
    <div>
      <PageHeader title={t('reports.title')} />
      <Card>
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'tb',
            label: t('reports.trialBalance'),
            children: (
              <>
                <ListToolbar
                  filters={dateFilters}
                  actions={
                    <>
                      {tb && (
                        <Tag color={tb.balanced ? 'green' : 'red'}>
                          {tb.balanced ? t('reports.balanced') : t('reports.unbalanced')}
                        </Tag>
                      )}
                      {printButton}
                      <ExportButtons path="/reports/trial-balance" params={range} />
                    </>
                  }
                />
                <div className="report-meta">
                  <span>{t('reports.openingNote')}</span>
                  {tb?.rows.some((r) => r.kind === 'PRIOR_YEARS') && <span>{t('reports.priorYearsNote')}</span>}
                </div>
                <Table<TbRow>
                  rowKey={(r) => r.accountId || 'prior-years'}
                  size="small"
                  bordered
                  loading={tbLoading}
                  dataSource={tb?.rows ?? []}
                  pagination={false}
                  scroll={{ x: 1000 }}
                  rowClassName={(r) => (r.kind ? 'report-row-strong' : '')}
                  onRow={(r) =>
                    r.kind
                      ? {}
                      : { onDoubleClick: () => openStatement(r.accountId), style: { cursor: 'pointer' } }
                  }
                  columns={[
                    { title: t('accounts.code'), dataIndex: 'code', width: 90 },
                    {
                      title: t('common.name'),
                      key: 'name',
                      render: (_: unknown, r: TbRow) => (r.kind ? t('reports.priorYearsRow') : bothNames(r)),
                    },
                    tbGroup('opening', t('reports.openingPeriod')),
                    tbGroup('period', t('reports.movements')),
                    tbGroup('closing', t('reports.closingPeriod')),
                  ]}
                  summary={() =>
                    tb && tb.rows.length > 0 ? (
                      <Table.Summary.Row className="report-row-strong">
                        <Table.Summary.Cell index={0} colSpan={2}>
                          {t('journal.total')}
                        </Table.Summary.Cell>
                        {TB_COLUMNS.map((k, i) => (
                          <Table.Summary.Cell key={k} index={i + 1} align="right">
                            <Num>{formatAmount(tb.totals[k])}</Num>
                          </Table.Summary.Cell>
                        ))}
                      </Table.Summary.Row>
                    ) : null
                  }
                />
              </>
            ),
          },
          { key: 'is', label: t('reports.incomeStatement'), children: <IncomeStatementTab /> },
          { key: 'bs', label: t('reports.balanceSheet'), children: <BalanceSheetTab /> },
          {
            key: 'gl',
            label: t('reports.generalLedger'),
            children: (
              <>
                <ListToolbar
                  filters={
                    <>
                      <Select
                        showSearch
                        allowClear
                        optionFilterProp="label"
                        placeholder={t('reports.account')}
                        style={{ minWidth: 280 }}
                        value={accountId}
                        onChange={setAccountId}
                        options={accountOptions}
                      />
                      {dateFilters}
                    </>
                  }
                  actions={
                    accountId && (
                      <>
                        {printButton}
                        <ExportButtons path="/reports/general-ledger" params={{ accountId, ...range }} />
                      </>
                    )
                  }
                />
                {!accountId ? (
                  <div className="report-empty">{t('reports.selectAccount')}</div>
                ) : (
                <>
                {gl && (
                  <div className="report-meta">
                    <span>
                      {t('reports.account')}: <strong>{codeAndName(gl.account)}</strong>
                    </span>
                    <span>{t('reports.openingNote')}</span>
                  </div>
                )}
                <LedgerTable data={gl} loading={glLoading} />
                </>
                )}
              </>
            ),
          },
          {
            key: 'statement',
            label: t('reports.partyStatement'),
            children: (
              <>
                <ListToolbar
                  filters={
                    <>
                      <Select
                        allowClear
                        placeholder={t('reports.partyType')}
                        value={partyType}
                        onChange={(v) => {
                          setPartyType(v);
                          setPartyId(undefined);
                        }}
                        options={[
                          { value: 'CUSTOMER', label: t('reports.customer') },
                          { value: 'SUPPLIER', label: t('reports.supplier') },
                        ]}
                      />
                      <Select
                        showSearch
                        allowClear
                        optionFilterProp="label"
                        disabled={!partyType}
                        placeholder={t('reports.party')}
                        style={{ minWidth: 240 }}
                        value={partyId}
                        onChange={setPartyId}
                        options={(parties ?? []).map((p) => ({ value: p.id, label: codeAndName(p) }))}
                      />
                      {dateFilters}
                    </>
                  }
                  actions={
                    partyType &&
                    partyId && (
                      <>
                        {printButton}
                        <ExportButtons
                          path="/reports/party-statement"
                          params={{ partyType, partyId, ...range }}
                        />
                      </>
                    )
                  }
                />
              {!partyType || !partyId ? (
                <div className="report-empty">{t('reports.selectParty')}</div>
              ) : (
                <>
                  <div className="report-meta">
                    <span>{t('reports.openingNote')}</span>
                  </div>
                  <LedgerTable data={statement} loading={stLoading} withAccount />
                </>
              )}
              </>
            ),
          },
          {
            key: 'items',
            label: t('reports.itemBalances'),
            children: <ItemBalancesTab range={range} dateFilters={dateFilters} printButton={printButton} />,
          },
          {
            key: 'aging',
            label: t('reports.aging'),
            children: <AgingTab />,
          },
          { key: 'tax', label: t('reports.taxSummary'), children: <TaxSummaryTab /> },
          {
            key: 'sales',
            label: t('reports.salesSummary'),
            children: (
              <TradeSummaryTab
                kind="sales"
                initial={searchParams.get('tab') === 'sales' ? linkFilters : undefined}
              />
            ),
          },
          {
            key: 'purchases',
            label: t('reports.purchasesSummary'),
            children: (
              <TradeSummaryTab
                kind="purchases"
                initial={searchParams.get('tab') === 'purchases' ? linkFilters : undefined}
              />
            ),
          },
        ]}
      />
      </Card>
    </div>
  );
}
