import { useQuery } from '@tanstack/react-query';
import { PrinterOutlined } from '@ant-design/icons';
import { Button, Card, DatePicker, Select, Table, Tabs, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  accountingControllerListAccounts,
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
import { TaxSummaryTab } from './reports/TaxSummaryTab';
import { TradeSummaryTab } from './reports/TradeSummaryTab';
import { ExportButtons } from '../components/ExportButtons';
import { amountCell } from '../format/cells';
import { dec, formatAmount, sum, type NumericInput } from '../format/number';

interface Account {
  id: string;
  code: string;
  nameAr: string;
}

interface TbRow {
  accountId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  totalDebit: string;
  totalCredit: string;
  balance: string;
}

interface TbResponse {
  rows: TbRow[];
  totals: { debit: string; credit: string };
  balanced: boolean;
}

interface LedgerRow {
  lineId: string;
  entryNo: string;
  entryDate: string;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
}

interface LedgerResponse {
  account: { code: string; nameAr: string };
  openingBalance: string;
  closingBalance: string;
  rows: LedgerRow[];
}

interface StatementRow {
  lineId: string;
  entryNo: string;
  entryDate: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
}

interface StatementResponse {
  openingBalance: string;
  closingBalance: string;
  totalDebit: string;
  totalCredit: string;
  rows: StatementRow[];
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}


const dateCol = { title: '', dataIndex: 'entryDate', width: 110, render: (v: string) => dayjs(v).format('YYYY-MM-DD') };

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
  const [accountId, setAccountId] = useState<string | undefined>(undefined);
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
      apiFetchData<StatementResponse>(
        `/api/v1/reports/party-statement${qs({ partyType, partyId, ...range })}`,
      ),
    enabled: !!partyType && !!partyId,
  });

  // Each report shows only the filters it uses; the date range is shared between tabs.
  const dateFilters = (
    <>
      <DatePicker placeholder={t('reports.from')} value={from} onChange={setFrom} />
      <DatePicker placeholder={t('reports.to')} value={to} onChange={setTo} />
    </>
  );
  const printButton = (
    <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
      {t('common.print')}
    </Button>
  );
  // Bottom totals row for the ledger-style reports (debit, credit, closing balance).
  const totalsRow = (
    labelSpan: number,
    debit: NumericInput,
    credit: NumericInput,
    closing: NumericInput,
  ) => (
    <Table.Summary.Row>
      <Table.Summary.Cell index={0} colSpan={labelSpan}>
        {t('journal.total')}
      </Table.Summary.Cell>
      <Table.Summary.Cell index={1} align="right">
        <Num>{formatAmount(debit)}</Num>
      </Table.Summary.Cell>
      <Table.Summary.Cell index={2} align="right">
        <Num>{formatAmount(credit)}</Num>
      </Table.Summary.Cell>
      <Table.Summary.Cell index={3} align="right">
        <Num>{formatAmount(closing)}</Num>
      </Table.Summary.Cell>
    </Table.Summary.Row>
  );

  return (
    <div>
      <PageHeader title={t('reports.title')} />
      <Card>
      <Tabs
        defaultActiveKey={searchParams.get('tab') ?? 'tb'}
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
                <Table
                  rowKey="accountId"
                  size="small"
                  loading={tbLoading}
                  dataSource={tb?.rows ?? []}
                  pagination={false}
                  columns={[
                    { title: t('accounts.code'), dataIndex: 'code', width: 100 },
                    {
                      title: t('common.name'),
                      key: 'name',
                      render: (_: unknown, r: TbRow) => bothNames(r),
                    },
                    {
                      title: t('journal.debit'),
                      dataIndex: 'totalDebit',
                      align: 'right',
                      width: 120,
                      render: amountCell,
                    },
                    {
                      title: t('journal.credit'),
                      dataIndex: 'totalCredit',
                      align: 'right',
                      width: 120,
                      render: amountCell,
                    },
                    {
                      title: t('reports.balance'),
                      dataIndex: 'balance',
                      align: 'right',
                      width: 120,
                      render: amountCell,
                    },
                  ]}
                  summary={() =>
                    tb && tb.rows.length > 0
                      ? totalsRow(
                          2,
                          tb.totals.debit,
                          tb.totals.credit,
                          dec(tb.totals.debit).minus(dec(tb.totals.credit)),
                        )
                      : null
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
                    <span>
                      {t('reports.openingBalance')}: <strong><Num>{formatAmount(gl.openingBalance)}</Num></strong>
                    </span>
                  </div>
                )}
                <Table
                  rowKey="lineId"
                  size="small"
                  loading={glLoading}
                  dataSource={gl?.rows ?? []}
                  pagination={{ pageSize: 50 }}
                  columns={[
                    { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 150, className: 'nowrap' },
                    { ...dateCol, title: t('journal.date') },
                    { title: t('common.description'), dataIndex: 'description' },
                    {
                      title: t('journal.debit'),
                      dataIndex: 'debit',
                      align: 'right',
                      width: 110,
                      render: amountCell,
                    },
                    {
                      title: t('journal.credit'),
                      dataIndex: 'credit',
                      align: 'right',
                      width: 110,
                      render: amountCell,
                    },
                    {
                      title: t('reports.balance'),
                      dataIndex: 'balance',
                      align: 'right',
                      width: 120,
                      render: amountCell,
                    },
                  ]}
                  summary={() =>
                    gl && gl.rows.length > 0
                      ? totalsRow(
                          3,
                          sum(gl.rows.map((r) => r.debit)),
                          sum(gl.rows.map((r) => r.credit)),
                          gl.closingBalance,
                        )
                      : null
                  }
                />
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
                  {statement && (
                    <div className="report-meta">
                      <span>
                        {t('reports.openingBalance')}: <strong><Num>{formatAmount(statement.openingBalance)}</Num></strong>
                      </span>
                    </div>
                  )}
                  <Table
                    rowKey="lineId"
                    size="small"
                    loading={stLoading}
                    dataSource={statement?.rows ?? []}
                    pagination={{ pageSize: 50 }}
                    columns={[
                      { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 150, className: 'nowrap' },
                      { ...dateCol, title: t('journal.date') },
                      {
                        title: t('accounts.code'),
                        dataIndex: 'accountCode',
                        width: 90,
                      },
                      { title: t('common.name'), dataIndex: 'accountName' },
                      { title: t('common.description'), dataIndex: 'description' },
                      {
                        title: t('journal.debit'),
                        dataIndex: 'debit',
                        align: 'right',
                        width: 110,
                        render: amountCell,
                      },
                      {
                        title: t('journal.credit'),
                        dataIndex: 'credit',
                        align: 'right',
                        width: 110,
                        render: amountCell,
                      },
                      {
                        title: t('reports.balance'),
                        dataIndex: 'balance',
                        align: 'right',
                        width: 120,
                        render: amountCell,
                      },
                    ]}
                    summary={() =>
                      statement && statement.rows.length > 0
                        ? totalsRow(
                            5,
                            statement.totalDebit,
                            statement.totalCredit,
                            statement.closingBalance,
                          )
                        : null
                    }
                  />
                </>
              )}
              </>
            ),
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
