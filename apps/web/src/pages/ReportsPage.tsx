import { useQuery } from '@tanstack/react-query';
import { Card, DatePicker, Input, Select, Space, Table, Tabs } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  accountingControllerListAccounts,
  apiFetchData,
  journalControllerTrialBalance,
} from '@erp/api-client';

interface Account {
  id: string;
  code: string;
  nameAr: string;
}

interface TbRow {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  balance: string;
}

interface GlRow {
  entryNo: string;
  entryDate: string;
  description: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

interface StatementRow {
  entryNo: string;
  entryDate: string;
  description: string | null;
  debit: string;
  credit: string;
  balance: string;
}

function qs(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

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
    label: `${a.code} — ${a.nameAr}`,
  }));

  const range = {
    from: from?.format('YYYY-MM-DD'),
    to: to?.format('YYYY-MM-DD'),
  };

  const { data: tb, isLoading: tbLoading } = useQuery({
    queryKey: ['report-tb'],
    queryFn: () => journalControllerTrialBalance().then((r) => r.data as unknown as TbRow[]),
  });

  const { data: gl, isLoading: glLoading } = useQuery({
    queryKey: ['report-gl', accountId, range.from, range.to],
    queryFn: () =>
      apiFetchData<{ rows: GlRow[] }>(
        `/api/v1/reports/general-ledger${qs({ accountId, ...range })}`,
      ).then((r) => r.rows),
    enabled: !!accountId,
  });

  const { data: statement, isLoading: stLoading } = useQuery({
    queryKey: ['report-statement', accountId, partyType, partyId, range.from, range.to],
    queryFn: () =>
      apiFetchData<{ rows: StatementRow[] }>(
        `/api/v1/reports/party-statement${qs({ accountId, partyType, partyId, ...range })}`,
      ).then((r) => r.rows),
    enabled: !!accountId && !!partyType && !!partyId,
  });

  const num = (v: string | null | undefined) => (v == null ? '—' : Number(v).toFixed(3));

  return (
    <Card title={t('reports.title')}>
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
          onChange={setPartyType}
          options={[
            { value: 'CUSTOMER', label: t('reports.customer') },
            { value: 'SUPPLIER', label: t('reports.supplier') },
          ]}
        />
        <Input
          allowClear
          disabled={!partyType}
          placeholder={t('reports.partyId')}
          style={{ width: 240 }}
          value={partyId}
          onChange={(e) => setPartyId(e.target.value || undefined)}
        />
      </Space>
      <Tabs
        items={[
          {
            key: 'tb',
            label: t('reports.trialBalance'),
            children: (
              <Table
                rowKey="accountCode"
                size="small"
                loading={tbLoading}
                dataSource={tb ?? []}
                pagination={false}
                columns={[
                  { title: t('accounts.code'), dataIndex: 'accountCode', width: 100 },
                  { title: t('accounts.nameAr'), dataIndex: 'accountName' },
                  {
                    title: t('journal.debit'),
                    dataIndex: 'debit',
                    align: 'right',
                    width: 120,
                    render: num,
                  },
                  {
                    title: t('journal.credit'),
                    dataIndex: 'credit',
                    align: 'right',
                    width: 120,
                    render: num,
                  },
                  {
                    title: t('reports.balance'),
                    dataIndex: 'balance',
                    align: 'right',
                    width: 120,
                    render: num,
                  },
                ]}
              />
            ),
          },
          {
            key: 'gl',
            label: t('reports.generalLedger'),
            children: !accountId ? (
              <div>{t('reports.selectAccount')}</div>
            ) : (
              <Table
                rowKey={(r) => `${r.entryNo}-${r.entryDate}`}
                size="small"
                loading={glLoading}
                dataSource={gl ?? []}
                pagination={{ pageSize: 50 }}
                columns={[
                  { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 100 },
                  {
                    title: t('journal.date'),
                    dataIndex: 'entryDate',
                    width: 110,
                    render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
                  },
                  { title: t('common.description'), dataIndex: 'description' },
                  {
                    title: t('journal.debit'),
                    dataIndex: 'debit',
                    align: 'right',
                    width: 110,
                    render: num,
                  },
                  {
                    title: t('journal.credit'),
                    dataIndex: 'credit',
                    align: 'right',
                    width: 110,
                    render: num,
                  },
                  {
                    title: t('reports.balance'),
                    dataIndex: 'runningBalance',
                    align: 'right',
                    width: 120,
                    render: num,
                  },
                ]}
              />
            ),
          },
          {
            key: 'statement',
            label: t('reports.partyStatement'),
            children:
              !accountId || !partyType || !partyId ? (
                <div>{t('reports.selectParty')}</div>
              ) : (
                <Table
                  rowKey={(r) => `${r.entryNo}-${r.entryDate}`}
                  size="small"
                  loading={stLoading}
                  dataSource={statement ?? []}
                  pagination={{ pageSize: 50 }}
                  columns={[
                    { title: t('journal.entryNo'), dataIndex: 'entryNo', width: 100 },
                    {
                      title: t('journal.date'),
                      dataIndex: 'entryDate',
                      width: 110,
                      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
                    },
                    { title: t('common.description'), dataIndex: 'description' },
                    {
                      title: t('journal.debit'),
                      dataIndex: 'debit',
                      align: 'right',
                      width: 110,
                      render: num,
                    },
                    {
                      title: t('journal.credit'),
                      dataIndex: 'credit',
                      align: 'right',
                      width: 110,
                      render: num,
                    },
                    {
                      title: t('reports.balance'),
                      dataIndex: 'balance',
                      align: 'right',
                      width: 120,
                      render: num,
                    },
                  ]}
                />
              ),
          },
        ]}
      />
    </Card>
  );
}
