import { useQuery } from '@tanstack/react-query';
import { Card, DatePicker, Descriptions, Select, Space, Table, Tabs, Tag } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  accountingControllerListAccounts,
  apiFetchData,
  partiesControllerList,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { bothNames, codeAndName } from '../i18n/displayName';
import { Num } from '../components/Num';
import { AgingTab } from './reports/AgingTab';
import { amountCell } from '../format/cells';
import { formatAmount } from '../format/number';

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

  return (
    <div>
      <PageHeader title={t('reports.title')} />
      <Card>
      <Space style={{ marginBottom: 16 }} wrap>
        <DatePicker placeholder={t('reports.from')} value={from} onChange={setFrom} />
        <DatePicker placeholder={t('reports.to')} value={to} onChange={setTo} />
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
        <Select
          allowClear
          placeholder={t('reports.partyType')}
          style={{ width: 140 }}
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
      </Space>
      <Tabs
        items={[
          {
            key: 'tb',
            label: t('reports.trialBalance'),
            children: (
              <>
                {tb && (
                  <Space style={{ marginBottom: 8 }}>
                    <span>
                      {t('journal.debit')}: <Num>{formatAmount(tb.totals.debit)}</Num> — {t('journal.credit')}:{' '}
                      <Num>{formatAmount(tb.totals.credit)}</Num>
                    </span>
                    <Tag color={tb.balanced ? 'green' : 'red'}>
                      {tb.balanced ? t('reports.balanced') : t('reports.unbalanced')}
                    </Tag>
                  </Space>
                )}
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
                />
              </>
            ),
          },
          {
            key: 'gl',
            label: t('reports.generalLedger'),
            children: !accountId ? (
              <div>{t('reports.selectAccount')}</div>
            ) : (
              <>
                {gl && (
                  <Descriptions size="small" column={3} style={{ marginBottom: 8 }}>
                    <Descriptions.Item label={t('reports.account')}>
                      {codeAndName(gl.account)}
                    </Descriptions.Item>
                    <Descriptions.Item label={t('reports.openingBalance')}>
                      <Num>{formatAmount(gl.openingBalance)}</Num>
                    </Descriptions.Item>
                    <Descriptions.Item label={t('reports.closingBalance')}>
                      <Num>{formatAmount(gl.closingBalance)}</Num>
                    </Descriptions.Item>
                  </Descriptions>
                )}
                <Table
                  rowKey="lineId"
                  size="small"
                  loading={glLoading}
                  dataSource={gl?.rows ?? []}
                  pagination={{ pageSize: 50 }}
                  columns={[
                    { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 110 },
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
                />
              </>
            ),
          },
          {
            key: 'aging',
            label: t('reports.aging'),
            children: <AgingTab />,
          },
          {
            key: 'statement',
            label: t('reports.partyStatement'),
            children:
              !partyType || !partyId ? (
                <div>{t('reports.selectParty')}</div>
              ) : (
                <>
                  {statement && (
                    <Descriptions size="small" column={3} style={{ marginBottom: 8 }}>
                      <Descriptions.Item label={t('reports.openingBalance')}>
                        <Num>{formatAmount(statement.openingBalance)}</Num>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('reports.closingBalance')}>
                        <Num>{formatAmount(statement.closingBalance)}</Num>
                      </Descriptions.Item>
                      <Descriptions.Item label={t('reports.balance')}>
                        <Num>{formatAmount(statement.closingBalance)}</Num>
                      </Descriptions.Item>
                    </Descriptions>
                  )}
                  <Table
                    rowKey="lineId"
                    size="small"
                    loading={stLoading}
                    dataSource={statement?.rows ?? []}
                    pagination={{ pageSize: 50 }}
                    columns={[
                      { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 110 },
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
                  />
                </>
              ),
          },
        ]}
      />
      </Card>
    </div>
  );
}
