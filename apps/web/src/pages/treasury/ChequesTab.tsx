import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Checkbox, Form, Input, Modal, Select, Space, Table, Tag, Timeline, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  chequesControllerClear,
  chequesControllerCollect,
  chequesControllerDeposit,
  chequesControllerDetail,
  chequesControllerList,
  chequesControllerReturnCheque,
  chequesControllerUndo,
  type ChequeDto,
  type ChequesControllerListParams,
} from '@erp/api-client';
import { DatePicker } from '../../components/DatePicker';
import { ExportButtons } from '../../components/ExportButtons';
import { FormDialog } from '../../components/FormDialog';
import { tableLocale } from '../../components/QueryState';
import { amountCell } from '../../format/cells';
import { formatAmount } from '../../format/number';
import { idemHeaders } from '../../idempotency';

const DAY = 'YYYY-MM-DD';
type Step = 'deposit' | 'collect' | 'clear' | 'return' | 'undo';

const STATUS_COLORS: Record<string, string> = {
  IN_HAND: 'gold',
  DEPOSITED: 'blue',
  COLLECTED: 'green',
  ISSUED: 'orange',
  CLEARED: 'green',
  RETURNED: 'red',
  CANCELLED: 'default',
};

/** The steps a cheque in its status can take (ADR-037 §2); undo is offered once it moved. */
function stepsFor(c: ChequeDto): Step[] {
  if (c.direction === 'INCOMING') {
    if (c.status === 'IN_HAND') return ['deposit', 'return'];
    if (c.status === 'DEPOSITED') return ['collect', 'return', 'undo'];
    if (c.status === 'COLLECTED' || c.status === 'RETURNED') return ['undo'];
    return [];
  }
  if (c.status === 'ISSUED') return ['clear', 'return'];
  if (c.status === 'CLEARED' || c.status === 'RETURNED') return ['undo'];
  return [];
}

/** Phase 22 (ADR-037): incoming and outgoing cheques by due date, and their steps. */
export function ChequesTab({ bankAccounts }: { bankAccounts: { value: string; label: string }[] }) {
  const { t, i18n } = useTranslation();
  const [api, holder] = message.useMessage();
  const qc = useQueryClient();
  const [direction, setDirection] = useState<'INCOMING' | 'OUTGOING' | undefined>();
  const [status, setStatus] = useState<ChequeDto['status'] | undefined>();
  const [openOnly, setOpenOnly] = useState(true);
  const [dueTo, setDueTo] = useState<Dayjs | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [step, setStep] = useState<{ cheque: ChequeDto; step: Step } | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);

  const params: ChequesControllerListParams = {
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
    ...(openOnly && !status ? { open: true } : {}),
    ...(dueTo ? { dueTo: dueTo.format(DAY) } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
    page,
    pageSize: 50,
  };
  const listQuery = useQuery({
    queryKey: ['cheques', params],
    queryFn: ({ signal }) => chequesControllerList(params, { signal }).then((r) => r.data),
  });
  const reportParams: Record<string, string> = {
    ...(direction ? { direction } : {}),
    ...(status ? { status } : {}),
    ...(dueTo ? { dueTo: dueTo.format(DAY) } : {}),
    ...(search.trim() ? { q: search.trim() } : {}),
  };
  const name = (r: { nameAr: string; nameEn?: string | null } | null) =>
    r ? (i18n.language === 'en' ? r.nameEn || r.nameAr : r.nameAr) : '';

  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {holder}
      <Space wrap>
        <Select
          style={{ width: 140 }}
          allowClear
          placeholder={t('cheques.direction')}
          value={direction}
          onChange={(v) => {
            setDirection(v);
            setPage(1);
          }}
          options={[
            { value: 'INCOMING', label: t('cheques.INCOMING') },
            { value: 'OUTGOING', label: t('cheques.OUTGOING') },
          ]}
        />
        <Select
          style={{ width: 160 }}
          allowClear
          placeholder={t('cheques.status')}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          options={Object.keys(STATUS_COLORS).map((s) => ({ value: s, label: t(`cheques.statuses.${s}`) }))}
        />
        <DatePicker
          placeholder={t('cheques.dueTo')}
          value={dueTo}
          onChange={(d) => {
            setDueTo(d);
            setPage(1);
          }}
        />
        <Input.Search
          style={{ width: 180 }}
          allowClear
          placeholder={t('cheques.chequeNo')}
          onSearch={(v) => {
            setSearch(v);
            setPage(1);
          }}
        />
        <Checkbox checked={openOnly} disabled={!!status} onChange={(e) => setOpenOnly(e.target.checked)}>
          {t('cheques.openOnly')}
        </Checkbox>
        <ExportButtons path="/cheques/outstanding" params={reportParams} />
      </Space>
      {listQuery.data && (
        <span>{t('cheques.total', { amount: formatAmount(listQuery.data.totalAmount), count: listQuery.data.total })}</span>
      )}
      <Table<ChequeDto>
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        dataSource={listQuery.data?.items ?? []}
        locale={tableLocale(listQuery)}
        pagination={{
          current: page,
          pageSize: 50,
          total: listQuery.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: t('cheques.dueDate'), dataIndex: 'dueDate', width: 110 },
          { title: t('cheques.direction'), dataIndex: 'direction', width: 80, render: (v: string) => t(`cheques.${v}`) },
          { title: t('cheques.chequeNo'), dataIndex: 'chequeNo', width: 120 },
          {
            title: t('cheques.bankName'),
            key: 'bank',
            render: (_: unknown, c) => c.bankName || name(c.bankAccount),
          },
          { title: t('cheques.party'), key: 'party', render: (_: unknown, c) => name(c.party) },
          { title: t('cheques.voucher'), dataIndex: 'voucherNo', width: 120 },
          { title: t('cheques.amount'), dataIndex: 'amount', align: 'end', width: 120, render: amountCell },
          {
            title: t('cheques.status'),
            dataIndex: 'status',
            width: 120,
            render: (v: string) => <Tag color={STATUS_COLORS[v]}>{t(`cheques.statuses.${v}`)}</Tag>,
          },
          {
            title: '',
            key: 'actions',
            render: (_: unknown, c) => (
              <Space size={4} wrap>
                {stepsFor(c).map((s) => (
                  <Button key={s} size="small" onClick={() => setStep({ cheque: c, step: s })}>
                    {t(`cheques.${s}`)}
                  </Button>
                ))}
                <Button size="small" type="link" onClick={() => setHistoryOf(c.id)}>
                  {t('cheques.history')}
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {step && (
        <StepDialog
          cheque={step.cheque}
          step={step.step}
          bankAccounts={bankAccounts}
          onClose={() => setStep(null)}
          onDone={() => {
            setStep(null);
            api.success(t('common.saved'));
            void qc.invalidateQueries({ queryKey: ['cheques'] });
          }}
          onError={(err) =>
            api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'))
          }
        />
      )}
      {historyOf && <HistoryDialog id={historyOf} onClose={() => setHistoryOf(null)} />}
    </Space>
  );
}

function StepDialog({
  cheque,
  step,
  bankAccounts,
  onClose,
  onDone,
  onError,
}: {
  cheque: ChequeDto;
  step: Step;
  bankAccounts: { value: string; label: string }[];
  onClose: () => void;
  onDone: () => void;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ date: Dayjs; bankAccountId?: string; notes?: string }>();
  // One key per opened dialog: a retry replays, never posts twice.
  const [headers] = useState(idemHeaders);
  const run = useMutation({
    mutationFn: async (v: { date: Dayjs; bankAccountId?: string; notes?: string }) => {
      const date = v.date.format(DAY);
      const opts = { headers };
      if (step === 'deposit') return chequesControllerDeposit(cheque.id, { date, bankAccountId: v.bankAccountId!, notes: v.notes }, opts);
      if (step === 'collect') return chequesControllerCollect(cheque.id, { date, notes: v.notes }, opts);
      if (step === 'clear') return chequesControllerClear(cheque.id, { date, notes: v.notes }, opts);
      if (step === 'return') return chequesControllerReturnCheque(cheque.id, { date, notes: v.notes }, opts);
      return chequesControllerUndo(cheque.id, { date }, opts);
    },
    onSuccess: onDone,
    onError,
  });
  // Collecting or clearing usually happens on the due date.
  const initialDate = step === 'collect' || step === 'clear' ? dayjs(cheque.dueDate) : dayjs();
  return (
    <FormDialog
      open
      title={`${t(`cheques.${step}`)} — ${cheque.chequeNo}`}
      onCancel={onClose}
      onSave={() => form.submit()}
      saving={run.isPending}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ date: initialDate, bankAccountId: cheque.bankAccount?.id }}
        onFinish={(v) => run.mutate(v)}
      >
        <Form.Item name="date" label={t('cheques.date')} rules={[{ required: true, message: t('common.requiredField') }]}>
          <DatePicker />
        </Form.Item>
        {step === 'deposit' && (
          <Form.Item
            name="bankAccountId"
            label={t('cheques.bankAccount')}
            rules={[{ required: true, message: t('common.requiredField') }]}
          >
            <Select showSearch optionFilterProp="label" options={bankAccounts} />
          </Form.Item>
        )}
        {step !== 'undo' && (
          <Form.Item name="notes" label={t('cheques.notes')}>
            <Input maxLength={500} />
          </Form.Item>
        )}
      </Form>
    </FormDialog>
  );
}

function HistoryDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useQuery({
    queryKey: ['cheques', 'detail', id],
    queryFn: ({ signal }) => chequesControllerDetail(id, { signal }).then((r) => r.data),
  });
  return (
    <Modal open title={t('cheques.history')} onCancel={onClose} footer={null}>
      <Timeline
        items={(detail.data?.events ?? []).map((e) => ({
          color: e.undoneAt ? 'gray' : 'blue',
          children: (
            <span>
              {e.eventDate} — {t(`cheques.actions.${e.action}`)} → {t(`cheques.statuses.${e.toStatus}`)}
              {e.journalEntry?.entryNo ? ` (${t('cheques.entry')} ${e.journalEntry.entryNo})` : ''}
              {e.undoneAt ? ` — ${t('cheques.undone')}` : ''}
              {e.notes ? ` — ${e.notes}` : ''}
            </span>
          ),
        }))}
      />
    </Modal>
  );
}
