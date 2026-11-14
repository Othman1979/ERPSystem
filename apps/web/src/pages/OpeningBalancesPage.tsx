import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InboxOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, DatePicker, Input, Space, Table, Tag, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  accountingControllerListMappings,
  fiscalControllerListYears,
  journalControllerGet,
  journalControllerList,
  journalControllerOpening,
  journalControllerReverse,
} from '@erp/api-client';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { enterTo, focusFirstGridCell, focusNamedField } from '../components/GridSelect';
import {
  emptyLine,
  JournalLinesGrid,
  partyFields,
  type JournalLineDraft,
} from '../components/JournalLinesGrid';
import { Num } from '../components/Num';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ReverseButton } from '../components/ReverseButton';
import { usePartyColumn } from '../components/usePartyColumn';
import { amountCell, amountOrBlankCell } from '../format/cells';
import { formatAmount } from '../format/number';
import { codeAndName } from '../i18n/displayName';
import { idemHeaders } from '../idempotency';
import { useNewFromUrl } from '../useNewFromUrl';
import { openingPlug } from './opening/openingPlug';
import { selectPostable, useAccounts } from '../hooks/useAccounts';
import { type Page } from '../hooks/usePagedQuery';

interface Mapping {
  mappingKey: string;
  accountId: string | null;
  account: { id: string; code: string; nameAr: string; nameEn?: string | null } | null;
}

interface FiscalYear {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

interface OpeningLine {
  id: string;
  debit: string;
  credit: string;
  description: string | null;
  partyId: string | null;
  account?: { code: string; nameAr: string; nameEn?: string | null };
}

interface OpeningEntry {
  id: string;
  entryNo: string | null;
  entryDate: string;
  description: string | null;
  status: string;
  postingKind?: string;
  totalDebit: string;
  totalCredit: string;
  lines?: OpeningLine[];
  reversalOf?: { entryNo: string | null } | null;
  reversals?: { entryNo: string | null; status: string }[];
}

const day = (v: string) => v.slice(0, 10);

/** Start of the open fiscal year holding today, else of the earliest open year. */
function defaultOpeningDate(years: FiscalYear[] | undefined): Dayjs {
  const open = (years ?? [])
    .filter((y) => y.status === 'OPEN')
    .sort((a, b) => day(a.startDate).localeCompare(day(b.startDate)));
  const today = dayjs().format('YYYY-MM-DD');
  const current = open.find((y) => day(y.startDate) <= today && today <= day(y.endDate));
  const year = current ?? open[0];
  return year ? dayjs(day(year.startDate)) : dayjs().startOf('year');
}

/**
 * Opening balances (§8.6): one posted OPENING entry per submission for
 * accounts, customers and suppliers. The difference goes to the
 * OPENING_BALANCE_EQUITY account (server-side); opening stock is entered as
 * an OPENING stock adjustment, never on the inventory account.
 */
export function OpeningBalancesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { modal } = App.useApp();
  const [apiMessage, contextHolder] = message.useMessage();

  const [screen, setScreen] = useState<'list' | 'entry' | 'view'>('list');
  const [viewId, setViewId] = useState<string | null>(null);
  const [entryDate, setEntryDate] = useState<Dayjs>(dayjs());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<JournalLineDraft[]>([emptyLine(1), emptyLine(2)]);
  const [formSeq, setFormSeq] = useState(0);
  // One key per opened form: a double click or a retry after a lost response
  // replays the same entry instead of posting a second one.
  const idemKey = useMemo(() => crypto.randomUUID(), [formSeq]);

  const entries = useQuery({
    queryKey: ['journal-entries', 'opening'],
    queryFn: ({ signal }) =>
      journalControllerList({ sourceType: 'OPENING_ENTRY', pageSize: 100 }, { signal }).then(
        (r) => (r.data as unknown as Page<OpeningEntry>).items,
      ),
  });
  const accounts = useAccounts();
  const mappings = useQuery({
    queryKey: ['account-mappings'],
    queryFn: ({ signal }) => accountingControllerListMappings({ signal }).then((r) => r.data as unknown as Mapping[]),
  });
  const years = useQuery({
    queryKey: ['fiscal-years'],
    queryFn: ({ signal }) => fiscalControllerListYears({ signal }).then((r) => r.data as unknown as FiscalYear[]),
  });
  const detail = useQuery({
    queryKey: ['journal-entry', viewId],
    queryFn: ({ signal }) => journalControllerGet(viewId!, { signal }).then((r) => r.data as unknown as OpeningEntry),
    enabled: screen === 'view' && !!viewId,
  });
  // The picker and labels follow the lines on screen: the draft's, or the saved entry's.
  const { partyColumn, partyName } = usePartyColumn(accounts.data, {
    shownPartyIds: screen === 'view' ? (detail.data?.lines ?? []).map((l) => l.partyId) : lines.map((l) => l.partyId),
    enabled: screen === 'entry',
  });

  const mapped = (key: string) => mappings.data?.find((m) => m.mappingKey === key);
  const equityAccount = mapped('OPENING_BALANCE_EQUITY')?.account ?? null;
  const inventoryAccountId = mapped('INVENTORY')?.accountId ?? null;

  // The plug account is added by the server, and the inventory account is
  // fed by the opening stock adjustment — neither is typed here.
  const accountOptions = selectPostable(accounts.data ?? [])
    .filter((a) => a.id !== inventoryAccountId && a.id !== equityAccount?.id)
    .map((a) => ({ value: a.id, label: codeAndName(a) }));

  const filled = lines.filter((l) => l.accountId);
  const plug = openingPlug(filled);
  const equityLabel = equityAccount ? codeAndName(equityAccount) : t('opening.equityAccount');
  const plugText =
    plug.side === null
      ? t('opening.noDifference')
      : t(plug.side === 'CREDIT' ? 'opening.plugCredit' : 'opening.plugDebit', {
          amount: formatAmount(plug.amount),
          account: equityLabel,
        });

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openNew = () => {
    setEntryDate(defaultOpeningDate(years.data));
    setDescription(t('opening.defaultDescription'));
    setLines([emptyLine(1), emptyLine(2)]);
    setFormSeq((s) => s + 1);
    setScreen('entry');
  };
  useNewFromUrl(openNew);

  const openEntry = (id: string) => {
    setViewId(id);
    setScreen('view');
  };
  const backToList = () => {
    setScreen('list');
    setViewId(null);
  };
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
    void queryClient.invalidateQueries({ queryKey: ['journal-entry'] });
  };

  const postOpening = useMutation({
    mutationFn: () =>
      journalControllerOpening(
        {
          entryDate: entryDate.format('YYYY-MM-DD'),
          description: description || undefined,
          lines: filled.map((l) => ({
            accountId: l.accountId,
            debit: l.debit != null && l.debit !== '' ? String(l.debit) : undefined,
            credit: l.credit != null && l.credit !== '' ? String(l.credit) : undefined,
            description: l.description || undefined,
            ...partyFields(l, partyColumn),
          })),
        } as never,
        { headers: { 'Idempotency-Key': idemKey } },
      ),
    onSuccess: (res) => {
      const created = (res as { data?: OpeningEntry }).data;
      apiMessage.success(t('opening.posted', { entryNo: created?.entryNo ?? '' }));
      invalidate();
      if (created?.id) openEntry(created.id);
      else backToList();
    },
    onError,
  });

  const reverse = useMutation({
    mutationFn: (v: { id: string; date: string }) =>
      journalControllerReverse(v.id, { reversalDate: v.date } as never, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('journal.reversed'));
      invalidate();
    },
    onError,
  });

  const submit = () => {
    if (postOpening.isPending) return;
    if (filled.length === 0) {
      apiMessage.error(t('opening.noLines'));
      return;
    }
    const noParty = filled.find((l) => partyColumn.kindByAccount.has(l.accountId!) && !l.partyId);
    if (noParty) {
      apiMessage.error(t('journal.partyRequired', { line: lines.indexOf(noParty) + 1 }));
      return;
    }
    modal.confirm({
      title: t('opening.confirmTitle'),
      content: (
        <Space direction="vertical" size={2}>
          <span>
            {t('journal.date')}: <strong><Num>{entryDate.format('YYYY-MM-DD')}</Num></strong>
          </span>
          <span>
            {t('journal.debit')}: <Num>{formatAmount(plug.totalDebit)}</Num> — {t('journal.credit')}:{' '}
            <Num>{formatAmount(plug.totalCredit)}</Num>
          </span>
          <span>{plugText}</span>
          <Typography.Text type="secondary">{t('opening.confirmNote')}</Typography.Text>
        </Space>
      ),
      okText: t('journal.post'),
      onOk: () => postOpening.mutate(),
    });
  };

  useDocShortcuts({ onPost: screen === 'entry' ? submit : undefined });

  const stockHint = (
    <Alert
      type="info"
      showIcon
      icon={<InboxOutlined />}
      message={t('opening.stockHintTitle')}
      description={t('opening.stockHint')}
      action={
        <Button size="small" onClick={() => navigate('/stock?tab=adjustments')}>
          {t('opening.openStockAdjustments')}
        </Button>
      }
      style={{ marginBottom: 16 }}
    />
  );

  // ============================ LIST ============================
  if (screen === 'list') {
    return (
      <div>
        {contextHolder}
        <PageHeader
          title={t('opening.title')}
          subtitle={t('opening.subtitle', { account: equityLabel })}
          actions={
            <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
              {t('opening.newEntry')}
            </Button>
          }
        />
        {stockHint}
        <Card>
          <Table
            rowKey="id"
            loading={entries.isLoading}
            dataSource={entries.data ?? []}
            pagination={{ pageSize: 20 }}
            locale={tableLocale(entries, t('opening.empty'))}
            onRow={(e) => ({ onClick: () => openEntry(e.id), style: { cursor: 'pointer' } })}
            columns={[
              {
                title: t('journal.entryNo'),
                dataIndex: 'entryNo',
                className: 'nowrap',
                width: 170,
                render: (v: string | null) => v ?? '—',
              },
              {
                title: t('journal.date'),
                dataIndex: 'entryDate',
                width: 120,
                render: (v: string) => day(v),
              },
              {
                title: t('common.description'),
                dataIndex: 'description',
                render: (v: string | null) => v ?? '—',
              },
              {
                title: t('common.status'),
                width: 110,
                render: (_: unknown, e: OpeningEntry) =>
                  e.postingKind === 'REVERSAL' ? (
                    <Tag color="orange">{t('opening.reversal')}</Tag>
                  ) : e.reversals?.length ? (
                    <Tag color="orange">{t('journal.reversedStatus')}</Tag>
                  ) : (
                    <Tag color="green">{t('journal.postedStatus')}</Tag>
                  ),
              },
              {
                title: t('journal.debit'),
                dataIndex: 'totalDebit',
                width: 140,
                align: 'right',
                render: amountCell,
              },
            ]}
          />
        </Card>
      </div>
    );
  }

  // ============================ VIEW ============================
  if (screen === 'view') {
    const entry = detail.data;
    return (
      <div>
        {contextHolder}
        <DocLayout
          title={t('opening.entryTitle')}
          docNo={entry?.entryNo}
          status={entry?.status}
          onBack={backToList}
          actions={
            entry &&
            entry.status === 'POSTED' &&
            entry.postingKind !== 'REVERSAL' &&
            !entry.reversals?.length && (
              <ReverseButton
                size="middle"
                loading={reverse.isPending}
                onReverse={(date) => reverse.mutate({ id: entry.id, date })}
              />
            )
          }
        >
          <DocFields>
            <DocField label={t('journal.date')}>
              <DocValue>{entry ? day(entry.entryDate) : '—'}</DocValue>
            </DocField>
            <DocField label={t('common.description')} wide>
              <DocValue>{entry?.description ?? '—'}</DocValue>
            </DocField>
            {entry?.reversalOf && (
              <DocField label={t('journal.reversalOf')}>
                <DocValue>
                  <span className="doc-no">{entry.reversalOf.entryNo ?? '—'}</span>
                </DocValue>
              </DocField>
            )}
          </DocFields>
          <Table
            rowKey="id"
            size="small"
            loading={detail.isLoading}
            pagination={false}
            dataSource={entry?.lines ?? []}
            columns={[
              { title: '#', width: 50, render: (_: unknown, __: OpeningLine, i: number) => i + 1 },
              {
                title: t('journal.account'),
                render: (_: unknown, l: OpeningLine) => (l.account ? codeAndName(l.account) : '—'),
              },
              {
                title: t('journal.party'),
                render: (_: unknown, l: OpeningLine) => partyName(l.partyId) ?? '—',
              },
              {
                title: t('common.description'),
                dataIndex: 'description',
                render: (v: string | null) => v ?? '—',
              },
              { title: t('journal.debit'), dataIndex: 'debit', width: 130, align: 'right', render: amountOrBlankCell },
              { title: t('journal.credit'), dataIndex: 'credit', width: 130, align: 'right', render: amountOrBlankCell },
            ]}
            summary={() => (
              <Table.Summary.Row style={{ fontWeight: 600 }}>
                <Table.Summary.Cell index={0} colSpan={4}>
                  {t('journal.total')}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={1} align="right">
                  {entry ? <Num>{formatAmount(entry.totalDebit)}</Num> : ''}
                </Table.Summary.Cell>
                <Table.Summary.Cell index={2} align="right">
                  {entry ? <Num>{formatAmount(entry.totalCredit)}</Num> : ''}
                </Table.Summary.Cell>
              </Table.Summary.Row>
            )}
          />
        </DocLayout>
      </div>
    );
  }

  // ============================ NEW ENTRY ============================
  return (
    <div>
      {contextHolder}
      {stockHint}
      <DocLayout
        title={t('opening.newEntry')}
        onBack={backToList}
        actions={
          <Button type="primary" icon={<SendOutlined />} loading={postOpening.isPending} onClick={submit}>
            {t('journal.post')}
            <span className="doc-kbd">Ctrl+Enter</span>
          </Button>
        }
      >
        <DocFields>
          <DocField
            field="date"
            label={t('journal.date')}
            onKeyDown={enterTo(() => focusNamedField('description'))}
          >
            <DatePicker value={entryDate} allowClear={false} onChange={(d) => d && setEntryDate(d)} />
          </DocField>
          <DocField
            field="description"
            wide
            label={t('common.description')}
            onKeyDown={enterTo(focusFirstGridCell)}
          >
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder={t('common.description')}
            />
          </DocField>
        </DocFields>
        <JournalLinesGrid
          lines={lines}
          onChange={setLines}
          accountOptions={accountOptions}
          focusSignal={formSeq}
          partyColumn={partyColumn}
          footerNote={
            plug.totalDebit.isZero() && plug.totalCredit.isZero() ? null : (
              <Typography.Text type={plug.side === null ? 'success' : 'secondary'}>{plugText}</Typography.Text>
            )
          }
        />
      </DocLayout>
    </div>
  );
}
