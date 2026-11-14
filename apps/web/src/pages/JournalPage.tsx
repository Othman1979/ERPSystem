import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DeleteOutlined,
  PlusOutlined,
  PrinterOutlined,
  SaveOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  DatePicker,
  Dropdown,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  emptyLine,
  JournalLinesGrid,
  partyFields,
  type JournalLineDraft,
} from '../components/JournalLinesGrid';
import { usePartyColumn } from '../components/usePartyColumn';
import { selectPostable, useAccounts } from '../hooks/useAccounts';
import {
  ApiError,
  journalControllerCreateDraft,
  journalControllerDeleteDraft,
  journalControllerGet,
  journalControllerList,
  journalControllerPost,
  journalControllerReverse,
  type JournalControllerListSort,
  type JournalControllerListStatus,
  type JournalControllerListVoucherType,
  type JournalEntryDetailDto,
  type JournalEntryLineDto,
  type JournalEntryListItemDto,
  type JournalVoucherType,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { useNewFromUrl } from '../useNewFromUrl';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ListToolbar } from '../components/ListToolbar';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { codeAndName } from '../i18n/displayName';
import { Num } from '../components/Num';
import { amountCell, amountOrBlankCell } from '../format/cells';
import { formatAmount } from '../format/number';

type JournalEntry = JournalEntryDetailDto;

/** A line of a draft that has its account chosen (the lines the API receives). */
type FilledLine = JournalLineDraft & { accountId: string };

function filledLines(lines: JournalLineDraft[]): FilledLine[] {
  return lines.filter((l): l is FilledLine => !!l.accountId);
}

/** Only manual entries reverse here; document entries reverse through their document. */
const REVERSIBLE_HERE = new Set(['MANUAL_JOURNAL', 'OPENING_ENTRY']);

const VOUCHER_TYPES = ['JOURNAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER'] as const;
type VoucherType = JournalVoucherType;

const VOUCHER_TYPE_LABEL: Record<VoucherType, string> = {
  JOURNAL: 'journal.typeJournal',
  RECEIPT_VOUCHER: 'journal.typeReceipt',
  PAYMENT_VOUCHER: 'journal.typePayment',
};

const VOUCHER_TAG_COLOR: Record<VoucherType, string> = {
  JOURNAL: 'default',
  RECEIPT_VOUCHER: 'blue',
  PAYMENT_VOUCHER: 'orange',
};

function VoucherTag({ type }: { type?: VoucherType }) {
  const { t } = useTranslation();
  const vt = type ?? 'JOURNAL';
  return <Tag color={VOUCHER_TAG_COLOR[vt]}>{t(VOUCHER_TYPE_LABEL[vt])}</Tag>;
}

export function JournalPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<JournalControllerListStatus | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<JournalControllerListVoucherType | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'entry'>('list');
  const [entryId, setEntryId] = useState<string | null>(null); // null → new entry
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  // ---- new-entry form state ----
  const [newDate, setNewDate] = useState<Dayjs>(dayjs());
  const [newVoucherType, setNewVoucherType] = useState<VoucherType>('JOURNAL');
  const [newDescription, setNewDescription] = useState('');
  const [lines, setLines] = useState<JournalLineDraft[]>([emptyLine(1), emptyLine(2)]);
  const [gridFocus, setGridFocus] = useState(0);

  // Server-paged (ADR-022): search (entry number, description), filters, sort and page go to the API.
  const list = usePagedQuery<
    JournalEntryListItemDto,
    { status?: JournalControllerListStatus; voucherType?: JournalControllerListVoucherType },
    JournalControllerListSort
  >({
    key: ['journal-entries', 'list'],
    filters: { status: statusFilter, voucherType: typeFilter },
    defaultSort: '-entryDate',
    fetch: (params, signal) => journalControllerList(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });

  const { data: accounts } = useAccounts();

  const accountOptions = selectPostable(accounts ?? []).map((a) => ({ value: a.id, label: codeAndName(a) }));

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['journal-entry', entryId],
    queryFn: ({ signal }) => journalControllerGet(entryId!, { signal }).then((r) => r.data),
    enabled: screen === 'entry' && !!entryId,
  });

  // The picker and labels follow the lines on screen: the draft's, or a saved entry's.
  const { partyColumn, partyName } = usePartyColumn(accounts, {
    shownPartyIds: entryId ? (detail?.lines ?? []).map((l) => l.partyId) : lines.map((l) => l.partyId),
    enabled: screen === 'entry' && !entryId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
    void queryClient.invalidateQueries({ queryKey: ['journal-entry'] });
  };
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openNew = (voucherType: VoucherType = 'JOURNAL') => {
    setEntryId(null);
    setNewDate(dayjs());
    setNewVoucherType(voucherType);
    setNewDescription('');
    setLines([emptyLine(1), emptyLine(2)]);
    setGridFocus((g) => g + 1);
    setScreen('entry');
  };
  useNewFromUrl(() => openNew('JOURNAL'));

  const openEntry = (id: string) => {
    setEntryId(id);
    setScreen('entry');
  };

  const backToList = () => {
    setScreen('list');
    setEntryId(null);
  };

  const createDraft = useMutation({
    mutationFn: () =>
      journalControllerCreateDraft({
        entryDate: newDate.format('YYYY-MM-DD'),
        description: newDescription || undefined,
        voucherType: newVoucherType,
        lines: filledLines(lines).map((l) => ({
          accountId: l.accountId,
          debit: l.debit ?? undefined,
          credit: l.credit ?? undefined,
          description: l.description || undefined,
          ...partyFields(l, partyColumn),
        })),
      }),
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      invalidate();
      setEntryId(res.data.id);
    },
    onError,
  });

  const saveNew = () => {
    const filled = filledLines(lines);
    if (filled.length < 2) {
      apiMessage.error(t('journal.minLines'));
      return;
    }
    const noParty = filled.findIndex(
      (l) => partyColumn.kindByAccount.has(l.accountId) && !l.partyId,
    );
    if (noParty >= 0) {
      apiMessage.error(t('journal.partyRequired', { line: lines.indexOf(filled[noParty]) + 1 }));
      return;
    }
    createDraft.mutate();
  };

  const postEntry = useMutation({
    mutationFn: (id: string) => journalControllerPost(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('journal.posted'));
      invalidate();
    },
    onError,
  });

  const reverseEntry = useMutation({
    mutationFn: (v: { id: string; date: Dayjs }) =>
      journalControllerReverse(
        v.id,
        { reversalDate: v.date.format('YYYY-MM-DD') },
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      apiMessage.success(t('journal.reversed'));
      setReverseTarget(null);
      invalidate();
    },
    onError,
  });

  const deleteDraft = useMutation({
    mutationFn: (id: string) => journalControllerDeleteDraft(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
      backToList();
    },
    onError,
  });

  // Shortcuts on an open entry: Ctrl+S saves a new draft, Ctrl+Enter posts a
  // saved draft (behind the same confirmation as the button).
  const { modal } = App.useApp();
  const openDraft = screen === 'entry' && detail?.status === 'DRAFT' ? detail : null;
  useDocShortcuts({
    onSave: screen === 'entry' && !entryId ? () => !createDraft.isPending && saveNew() : undefined,
    onPost: openDraft
      ? () => {
          if (postEntry.isPending) return;
          modal.confirm({
            title: t('journal.confirmPost'),
            onOk: () => postEntry.mutate(openDraft.id),
          });
        }
      : undefined,
  });

  // ============================ LIST VIEW ============================
  if (screen === 'list') {
    return (
      <div>
        <PageHeader title={t('journal.title')} />
        <Card>
        {contextHolder}
        <ListToolbar
          search={list.search}
          onSearch={list.setSearch}
          filters={
            <>
                <Select
                  allowClear
                  placeholder={t('journal.allStatuses')}
                  value={statusFilter}
                  onChange={(v) => setStatusFilter(v)}
                  options={[
                    { value: 'DRAFT', label: t('journal.draft') },
                    { value: 'POSTED', label: t('journal.postedStatus') },
                  ]}
                />
                <Select
                  allowClear
                  placeholder={t('journal.voucherType')}
                  value={typeFilter}
                  onChange={(v) => setTypeFilter(v)}
                  options={VOUCHER_TYPES.map((vt) => ({
                    value: vt,
                    label: t(VOUCHER_TYPE_LABEL[vt]),
                  }))}
                />
            </>
          }
          count={list.total}
          actions={
              <Dropdown.Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => openNew()}
                menu={{
                  items: VOUCHER_TYPES.map((vt) => ({
                    key: vt,
                    label: t(VOUCHER_TYPE_LABEL[vt]),
                  })),
                  onClick: ({ key }) => openNew(key as VoucherType),
                }}
              >
                {t('journal.newEntry')}
              </Dropdown.Button>
          }
        />
        <Table
          rowKey="id"
          loading={list.query.isLoading}
          dataSource={list.rows}
          locale={tableLocale(list.query)}
          pagination={list.pagination}
          onChange={list.onTableChange}
          onRow={(e) => ({ onClick: () => openEntry(e.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('journal.entryNo'),
              dataIndex: 'entryNo',
              key: 'entryNo',
              sorter: true,
              sortOrder: list.sortOrderOf('entryNo'),
              className: 'nowrap',
              width: 160,
              render: (v: string | null) => v ?? '—',
            },
            {
              title: t('journal.voucherType'),
              dataIndex: 'voucherType',
              width: 110,
              render: (v: VoucherType | undefined) => <VoucherTag type={v} />,
            },
            {
              title: t('journal.date'),
              dataIndex: 'entryDate',
              key: 'entryDate',
              sorter: true,
              sortOrder: list.sortOrderOf('entryDate'),
              width: 110,
              render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
            },
            {
              title: t('common.description'),
              dataIndex: 'description',
              render: (v: string | null) => v ?? '—',
            },
            {
              title: t('common.status'),
              dataIndex: 'status',
              width: 100,
              // BUILD_PLAN §16: fixed colours for draft / posted / reversed.
              render: (v: string, e: JournalEntryListItemDto) =>
                v !== 'POSTED' ? (
                  <Tag>{t('journal.draft')}</Tag>
                ) : e.reversals?.length ? (
                  <Tag color="orange">{t('journal.reversedStatus')}</Tag>
                ) : (
                  <Tag color="green">{t('journal.postedStatus')}</Tag>
                ),
            },
            {
              title: t('journal.debit'),
              dataIndex: 'totalDebit',
              width: 110,
              align: 'right',
              render: amountCell,
            },
            {
              title: t('common.actions'),
              width: 160,
              render: (_: unknown, e: JournalEntryListItemDto) => (
                <Space onClick={(ev) => ev.stopPropagation()}>
                  {e.status === 'DRAFT' && (
                    <>
                      <Popconfirm
                        title={t('journal.confirmPost')}
                        onConfirm={() => postEntry.mutate(e.id)}
                      >
                        <Button size="small" type="primary">
                          {t('journal.post')}
                        </Button>
                      </Popconfirm>
                      <Popconfirm
                        title={t('common.confirmDelete')}
                        onConfirm={() => deleteDraft.mutate(e.id)}
                      >
                        <Button size="small" danger>
                          {t('common.delete')}
                        </Button>
                      </Popconfirm>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
        </Card>
      </div>
    );
  }

  // ============================ ENTRY VIEW ============================
  const isNew = !entryId;
  const entry = detail ?? null;

  return (
    <div>
      {contextHolder}
      <DocLayout
        title={
          isNew
            ? t('journal.newEntry')
            : t(VOUCHER_TYPE_LABEL[entry?.voucherType ?? 'JOURNAL'])
        }
        docNo={entry?.entryNo}
        status={isNew ? 'DRAFT' : entry?.status}
        onBack={backToList}
        actions={
          isNew ? (
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={createDraft.isPending}
              onClick={saveNew}
            >
              {t('journal.saveDraft')}
              <span className="doc-kbd">Ctrl+S</span>
            </Button>
          ) : (
            entry && (
              <>
                {entry.status === 'DRAFT' && (
                  <>
                    <Popconfirm
                      title={t('journal.confirmPost')}
                      onConfirm={() => postEntry.mutate(entry.id)}
                    >
                      <Button type="primary" loading={postEntry.isPending}>
                        {t('journal.post')}
                        <span className="doc-kbd">Ctrl+Enter</span>
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title={t('common.confirmDelete')}
                      onConfirm={() => deleteDraft.mutate(entry.id)}
                    >
                      <Button danger icon={<DeleteOutlined />}>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  </>
                )}
                {entry.status === 'POSTED' && !entry.reversals?.length && REVERSIBLE_HERE.has(entry.sourceType ?? 'MANUAL_JOURNAL') && (
                  <Button icon={<SwapOutlined />} onClick={() => setReverseTarget(entry)}>
                    {t('journal.reverse')}
                  </Button>
                )}
                <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
                  {t('common.print')}
                </Button>
              </>
            )
          )
        }
      >
        {isNew ? (
          <DocFields>
            <DocField
              field="voucherType"
              label={t('journal.voucherType')}
              onKeyDown={enterTo(() => focusNamedField('date'))}
            >
              <GridSelect
                enterOpens
                value={newVoucherType}
                onChange={setNewVoucherType}
                options={VOUCHER_TYPES.map((vt) => ({
                  value: vt,
                  label: t(VOUCHER_TYPE_LABEL[vt]),
                }))}
              />
            </DocField>
            <DocField
              field="date"
              label={t('journal.date')}
              onKeyDown={enterTo(() => focusNamedField('description'))}
            >
              <DatePicker value={newDate} onChange={(d) => d && setNewDate(d)} />
            </DocField>
            <DocField
              field="description"
              wide
              label={t('common.description')}
              onKeyDown={enterTo(focusFirstGridCell)}
            >
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
                placeholder={t('common.description')}
              />
            </DocField>
          </DocFields>
        ) : (
          <DocFields>
            <DocField label={t('journal.voucherType')}>
              <DocValue>{entry ? <VoucherTag type={entry.voucherType} /> : '—'}</DocValue>
            </DocField>
            <DocField label={t('journal.date')}>
              <DocValue>{entry ? dayjs(entry.entryDate).format('YYYY-MM-DD') : '—'}</DocValue>
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
        )}

        {isNew ? (
          <JournalLinesGrid
            lines={lines}
            onChange={setLines}
            accountOptions={accountOptions}
            focusSignal={gridFocus}
            partyColumn={partyColumn}
          />
        ) : detailLoading ? (
          <div className="doc-section">{t('common.loading')}</div>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={entry?.lines ?? []}
            columns={[
              {
                title: '#',
                width: 50,
                render: (_: unknown, __: JournalEntryLineDto, i: number) => i + 1,
              },
              {
                title: t('journal.account'),
                render: (_: unknown, l: JournalEntryLineDto) => codeAndName(l.account),
              },
              {
                title: t('journal.party'),
                render: (_: unknown, l: JournalEntryLineDto) => partyName(l.partyId) ?? '—',
              },
              {
                title: t('common.description'),
                dataIndex: 'description',
                render: (v: string | null) => v ?? '—',
              },
              {
                title: t('journal.debit'),
                dataIndex: 'debit',
                width: 130,
                align: 'right',
                render: amountOrBlankCell,
              },
              {
                title: t('journal.credit'),
                dataIndex: 'credit',
                width: 130,
                align: 'right',
                render: amountOrBlankCell,
              },
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
        )}
      </DocLayout>

      {/* Reverse modal */}
      <Modal
        title={t('journal.reverseTitle')}
        open={!!reverseTarget}
        onCancel={() => setReverseTarget(null)}
        onOk={() =>
          reverseTarget &&
          reverseDate &&
          reverseEntry.mutate({ id: reverseTarget.id, date: reverseDate })
        }
        confirmLoading={reverseEntry.isPending}
      >
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">
            {reverseTarget?.entryNo} — {reverseTarget?.description}
          </Typography.Text>
        </div>
        <div>
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>
            {t('journal.reversalDate')}
          </Typography.Text>
          <DatePicker
            value={reverseDate}
            onChange={setReverseDate}
            style={{ width: '100%' }}
          />
        </div>
      </Modal>
    </div>
  );
}
