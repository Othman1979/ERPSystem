import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
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
import { idemHeaders } from '../idempotency';

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
  entryNo: string;
  entryDate: string;
  description: string | null;
  status: 'DRAFT' | 'POSTED';
  voucherType?: 'JOURNAL' | 'RECEIPT_VOUCHER' | 'PAYMENT_VOUCHER';
  totalDebit: string;
  totalCredit: string;
  lines?: JournalLine[];
  reversalOf?: { entryNo: string } | null;
  reversals?: { entryNo: string; status: string }[];
}

const VOUCHER_TYPES = ['JOURNAL', 'RECEIPT_VOUCHER', 'PAYMENT_VOUCHER'] as const;
type VoucherType = (typeof VOUCHER_TYPES)[number];

const VOUCHER_TYPE_LABEL: Record<VoucherType, string> = {
  JOURNAL: 'journal.typeJournal',
  RECEIPT_VOUCHER: 'journal.typeReceipt',
  PAYMENT_VOUCHER: 'journal.typePayment',
};

export function JournalPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reverseTarget, setReverseTarget] = useState<JournalEntry | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [lines, setLines] = useState<JournalLineDraft[]>([emptyLine(1), emptyLine(2)]);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const { data: entries, isLoading } = useQuery({
    queryKey: ['journal-entries', statusFilter],
    queryFn: () =>
      journalControllerList(statusFilter ? { status: statusFilter } : { status: '' }).then(
        (r) => r.data as unknown as JournalEntry[],
      ),
  });

  const { data: accounts } = useQuery({
    queryKey: ['accounts-postable'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as Account[]),
  });

  const accountOptions = (accounts ?? [])
    .filter((a) => a.isActive && a.isPostable)
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }));

  const { data: detail } = useQuery({
    queryKey: ['journal-entry', detailId],
    queryFn: () => journalControllerGet(detailId!).then((r) => r.data as unknown as JournalEntry),
    enabled: !!detailId,
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['journal-entries'] });
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const createDraft = useMutation({
    mutationFn: (v: {
      entryDate: Dayjs;
      description?: string;
      voucherType: VoucherType;
      lines: JournalLineDraft[];
    }) =>
      journalControllerCreateDraft({
        entryDate: v.entryDate.format('YYYY-MM-DD'),
        description: v.description || undefined,
        voucherType: v.voucherType,
        lines: v.lines
          .filter((l) => l.accountId)
          .map((l) => ({
            accountId: l.accountId,
            debit: l.debit != null ? String(l.debit) : undefined,
            credit: l.credit != null ? String(l.credit) : undefined,
            description: l.description || undefined,
          })),
      } as never),
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      form.resetFields();
      setLines([emptyLine(1), emptyLine(2)]);
      invalidate();
    },
    onError,
  });

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
        {
          reversalDate: v.date.format('YYYY-MM-DD'),
        } as never,
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
    },
    onError,
  });

  return (
    <Card
      title={t('journal.title')}
      extra={
        <Space>
          <Select
            allowClear
            placeholder={t('journal.allStatuses')}
            style={{ width: 140 }}
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            options={[
              { value: 'DRAFT', label: t('journal.draft') },
              { value: 'POSTED', label: t('journal.postedStatus') },
            ]}
          />
          <Button type="primary" onClick={() => setModalOpen(true)}>
            {t('journal.newEntry')}
          </Button>
        </Space>
      }
    >
      {contextHolder}
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={entries ?? []}
        pagination={{ pageSize: 20 }}
        onRow={(e) => ({ onClick: () => setDetailId(e.id), style: { cursor: 'pointer' } })}
        columns={[
          {
            title: t('journal.entryNo'),
            dataIndex: 'entryNo',
            width: 110,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('journal.date'),
            dataIndex: 'entryDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          {
            title: t('journal.voucherType'),
            dataIndex: 'voucherType',
            width: 110,
            render: (v: VoucherType | undefined) => {
              if (v === 'RECEIPT_VOUCHER')
                return <Tag color="blue">{t('journal.typeReceipt')}</Tag>;
              if (v === 'PAYMENT_VOUCHER')
                return <Tag color="orange">{t('journal.typePayment')}</Tag>;
              return <Tag>{t('journal.typeJournal')}</Tag>;
            },
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
            render: (v: string) => Number(v).toFixed(3),
          },
          {
            title: t('common.actions'),
            width: 220,
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

      <Modal
        title={t('journal.newEntry')}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setLines([emptyLine(1), emptyLine(2)]);
        }}
        onOk={() => form.submit()}
        confirmLoading={createDraft.isPending}
        width={900}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => {
            const filled = lines.filter((l) => l.accountId);
            if (filled.length < 2) {
              apiMessage.error(t('journal.minLines'));
              return;
            }
            createDraft.mutate({
              entryDate: v.entryDate,
              description: v.description,
              voucherType: v.voucherType ?? 'JOURNAL',
              lines,
            });
          }}
          initialValues={{ entryDate: dayjs(), voucherType: 'JOURNAL' }}
          requiredMark={false}
        >
          <Space style={{ display: 'flex' }} align="start" wrap>
            <Form.Item
              name="entryDate"
              label={t('journal.date')}
              rules={[{ required: true }]}
              style={{ width: 160 }}
            >
              <DatePicker />
            </Form.Item>
            <Form.Item
              name="voucherType"
              label={t('journal.voucherType')}
              rules={[{ required: true }]}
              style={{ width: 160 }}
            >
              <Select
                options={VOUCHER_TYPES.map((vt) => ({
                  value: vt,
                  label: t(VOUCHER_TYPE_LABEL[vt]),
                }))}
              />
            </Form.Item>
            <Form.Item name="description" label={t('common.description')} style={{ flex: 1 }}>
              <Input maxLength={500} />
            </Form.Item>
          </Space>
          <Form.Item style={{ marginBottom: 8 }}>
            <JournalLinesGrid
              lines={lines}
              onChange={setLines}
              accountOptions={accountOptions}
            />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer
        title={detail ? `${t('journal.title')} ${detail.entryNo}` : ''}
        open={!!detailId}
        onClose={() => setDetailId(null)}
        width={640}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label={t('journal.entryNo')}>{detail.entryNo}</Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                {detail.status === 'POSTED'
                  ? t('journal.postedStatus')
                  : t('journal.draft')}
              </Descriptions.Item>
              <Descriptions.Item label={t('journal.date')}>
                {dayjs(detail.entryDate).format('YYYY-MM-DD')}
              </Descriptions.Item>
              <Descriptions.Item label={t('journal.voucherType')}>
                {detail.voucherType && detail.voucherType !== 'JOURNAL'
                  ? t(VOUCHER_TYPE_LABEL[detail.voucherType])
                  : t('journal.typeJournal')}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.description')}>
                {detail.description ?? '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey={(r) => r.id ?? `${r.account?.code}-${r.debit}-${r.credit}`}
              size="small"
              pagination={false}
              style={{ marginTop: 16 }}
              dataSource={detail.lines ?? []}
              columns={[
                {
                  title: t('journal.account'),
                  render: (_: unknown, l: JournalLine) =>
                    l.account ? `${l.account.code} — ${l.account.nameAr}` : '—',
                },
                {
                  title: t('common.description'),
                  dataIndex: 'description',
                  render: (v: string | null) => v ?? '—',
                },
                {
                  title: t('journal.debit'),
                  dataIndex: 'debit',
                  align: 'right',
                  render: (v: string | null) => (v ? Number(v).toFixed(3) : ''),
                },
                {
                  title: t('journal.credit'),
                  dataIndex: 'credit',
                  align: 'right',
                  render: (v: string | null) => (v ? Number(v).toFixed(3) : ''),
                },
              ]}
            />
          </>
        )}
      </Drawer>

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
        <Form layout="vertical" requiredMark={false}>
          <Form.Item label={t('journal.reversalDate')} required>
            <DatePicker value={reverseDate} onChange={setReverseDate} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
