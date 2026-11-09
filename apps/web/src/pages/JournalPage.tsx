import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
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
  type JournalLineDraft,
} from '../components/JournalLinesGrid';
import {
  ApiError,
  accountingControllerListAccounts,
  journalControllerCreateDraft,
  journalControllerDeleteDraft,
  journalControllerGet,
  journalControllerList,
  journalControllerPost,
  journalControllerReverse,
} from '@erp/api-client';
import i18n from '../i18n';
import { idemHeaders } from '../idempotency';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { StatusBar } from '../components/StatusBar';
import { PageHeader } from '../components/PageHeader';
import { codeAndName } from '../i18n/displayName';
import { Num } from '../components/Num';
import { amountCell, amountOrBlankCell } from '../format/cells';
import { formatAmount } from '../format/number';

interface Account {
  id: string;
  code: string;
  nameAr: string;
  isPostable: boolean;
  isActive: boolean;
}

interface JournalLine {
  id?: string;
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  description?: string | null;
  account?: { code: string; nameAr: string };
}

interface JournalEntry {
  id: string;
  entryNo: string | null;
  entryDate: string;
  description: string | null;
  status: 'DRAFT' | 'POSTED';
  voucherType?: 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
  totalDebit: string;
  totalCredit: string;
  lines?: JournalLine[];
  reversalOf?: { entryNo: string | null } | null;
  reversals?: { entryNo: string | null; status: string }[];
}

const VOUCHER_TYPES = ['JOURNAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER'] as const;
type VoucherType = (typeof VOUCHER_TYPES)[number];

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
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
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

  const { data: entries, isLoading } = useQuery({
    queryKey: ['journal-entries', statusFilter, typeFilter],
    queryFn: () =>
      journalControllerList({
        status: statusFilter ?? '',
        voucherType: typeFilter ?? '',
      }).then((r) => r.data as unknown as JournalEntry[]),
    enabled: screen === 'list',
  });

  const { data: accounts } = useQuery({
    queryKey: ['accounts-postable'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as Account[]),
  });

  const accountOptions = (accounts ?? [])
    .filter((a) => a.isActive && a.isPostable)
    .map((a) => ({ value: a.id, label: codeAndName(a) }));

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['journal-entry', entryId],
    queryFn: () => journalControllerGet(entryId!).then((r) => r.data as unknown as JournalEntry),
    enabled: screen === 'entry' && !!entryId,
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
        lines: lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debit: l.debit != null ? String(l.debit) : undefined,
            credit: l.credit != null ? String(l.credit) : undefined,
            description: l.description || undefined,
          })),
      } as never),
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      invalidate();
      const created = (res as { data?: JournalEntry }).data;
      if (created?.id) {
        setEntryId(created.id);
      } else {
        backToList();
      }
    },
    onError,
  });

  const saveNew = () => {
    const filled = lines.filter((l) => l.accountId);
    if (filled.length < 2) {
      apiMessage.error(t('journal.minLines'));
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
        { reversalDate: v.date.format('YYYY-MM-DD') } as never,
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

  // ============================ LIST VIEW ============================
  if (screen === 'list') {
    return (
      <div>
        <PageHeader
          title={t('journal.title')}
          actions={
            <Space>
              <Select
                allowClear
                placeholder={t('journal.allStatuses')}
                style={{ width: 130 }}
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
                style={{ width: 150 }}
                value={typeFilter}
                onChange={(v) => setTypeFilter(v)}
                options={VOUCHER_TYPES.map((vt) => ({
                  value: vt,
                  label: t(VOUCHER_TYPE_LABEL[vt]),
                }))}
              />
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
            </Space>
          }
        />
        <Card>
        {contextHolder}
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={entries ?? []}
          pagination={{ pageSize: 20 }}
          onRow={(e) => ({ onClick: () => openEntry(e.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('journal.entryNo'),
              dataIndex: 'entryNo',
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
              render: (v: string) =>
                v === 'POSTED' ? (
                  <Tag color="green">{t('journal.postedStatus')}</Tag>
                ) : (
                  <Tag>{t('journal.draft')}</Tag>
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
              width: 200,
              render: (_: unknown, e: JournalEntry) => (
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
                  {e.status === 'POSTED' && !e.reversals?.length && (
                    <Button size="small" onClick={() => setReverseTarget(e)}>
                      {t('journal.reverse')}
                    </Button>
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
      {/* Odoo-style control panel */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <Button
          icon={i18n.language === 'ar' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
          onClick={backToList}
        >
          {t('journal.title')}
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {isNew
            ? t('journal.newEntry')
            : `${entry?.entryNo ?? '…'} — ${t(VOUCHER_TYPE_LABEL[entry?.voucherType ?? 'JOURNAL'])}`}
        </Typography.Title>
        {entry && (
          <Space size={8}>
            <VoucherTag type={entry.voucherType} />
            <StatusBar status={entry.status} />
          </Space>
        )}
        <div style={{ flex: 1 }} />
        <Space>
          {isNew ? (
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={createDraft.isPending}
              onClick={saveNew}
            >
              {t('journal.saveDraft')}
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
                {entry.status === 'POSTED' && !entry.reversals?.length && (
                  <Button icon={<SwapOutlined />} onClick={() => setReverseTarget(entry)}>
                    {t('journal.reverse')}
                  </Button>
                )}
              </>
            )
          )}
        </Space>
      </div>

      {/* Header fields */}
      <Card size="small" style={{ marginBottom: 16 }}>
        {isNew ? (
          <Space size={16} wrap>
            <div data-field="voucherType" onKeyDown={enterTo(() => focusNamedField('date'))}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('journal.voucherType')}
              </Typography.Text>
              <GridSelect
                enterOpens
                value={newVoucherType}
                onChange={setNewVoucherType}
                options={VOUCHER_TYPES.map((vt) => ({
                  value: vt,
                  label: t(VOUCHER_TYPE_LABEL[vt]),
                }))}
                style={{ width: 180 }}
              />
            </div>
            <div data-field="date" onKeyDown={enterTo(() => focusNamedField('description'))}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('journal.date')}
              </Typography.Text>
              <DatePicker value={newDate} onChange={(d) => d && setNewDate(d)} />
            </div>
            <div
              data-field="description"
              style={{ flex: 1, minWidth: 220 }}
              onKeyDown={enterTo(focusFirstGridCell)}
            >
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('common.description')}
              </Typography.Text>
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
                placeholder={t('common.description')}
              />
            </div>
          </Space>
        ) : (
          <Space size={24} wrap>
            <span>
              <Typography.Text type="secondary">{t('journal.date')}: </Typography.Text>
              {entry ? dayjs(entry.entryDate).format('YYYY-MM-DD') : '—'}
            </span>
            <span>
              <Typography.Text type="secondary">{t('common.description')}: </Typography.Text>
              {entry?.description ?? '—'}
            </span>
            {entry?.reversalOf && (
              <span>
                <Typography.Text type="secondary">{t('journal.reversalOf')}: </Typography.Text>
                {entry.reversalOf.entryNo ?? '—'}
              </span>
            )}
          </Space>
        )}
      </Card>

      {/* Lines */}
      <Card size="small" loading={detailLoading && !isNew} title={t('journal.linesTitle')}>
        {isNew ? (
          <JournalLinesGrid
            lines={lines}
            onChange={setLines}
            accountOptions={accountOptions}
            focusSignal={gridFocus}
          />
        ) : (
          <Table
            rowKey={(r) => r.id ?? `${r.account?.code}-${r.debit}-${r.credit}`}
            size="small"
            pagination={false}
            dataSource={entry?.lines ?? []}
            columns={[
              {
                title: '#',
                width: 50,
                render: (_: unknown, __: JournalLine, i: number) => i + 1,
              },
              {
                title: t('journal.account'),
                render: (_: unknown, l: JournalLine) =>
                  l.account ? codeAndName(l.account) : '—',
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
                <Table.Summary.Cell index={0} colSpan={3}>
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
      </Card>

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
