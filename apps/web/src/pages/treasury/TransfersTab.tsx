import { useMutation, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined, SwapOutlined } from '@ant-design/icons';
import { Button, DatePicker, Form, Input, InputNumber, Table, Tag, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  treasuryControllerCreateCashTransfer,
  treasuryControllerListCashTransfers,
  treasuryControllerReverseCashTransfer,
} from '@erp/api-client';
import { EnterNav } from '../../components/EnterNav';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { GridSelect } from '../../components/GridSelect';
import { ListToolbar } from '../../components/ListToolbar';
import { tableLocale } from '../../components/QueryState';
import { ReverseButton } from '../../components/ReverseButton';
import { usePagedQuery, type Page } from '../../hooks/usePagedQuery';
import { amountCell } from '../../format/cells';
import { dec } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';
import { idemHeaders } from '../../idempotency';

interface Transfer {
  id: string;
  transferNo: string | null;
  transferDate: string;
  amount: string;
  description: string | null;
  reversedAt: string | null;
  fromAccount: { code: string; nameAr: string; nameEn: string | null };
  toAccount: { code: string; nameAr: string; nameEn: string | null };
}

/** Phase 6: money moved between cash boxes and bank accounts. */
export function TransfersTab({ cashAccounts }: { cashAccounts: { value: string; label: string }[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [api, contextHolder] = message.useMessage();
  const [open, setOpen] = useState(false);

  // Server-paged (ADR-022): search (transfer number, accounts, description), sort and page go to the API.
  const list = usePagedQuery<Transfer, Record<string, string | undefined>>({
    key: ['cash-transfers', 'list'],
    filters: {},
    defaultSort: '-transferDate',
    fetch: (params, signal) =>
      treasuryControllerListCashTransfers(params as Parameters<typeof treasuryControllerListCashTransfers>[0], {
        signal,
      }).then((r) => r.data as unknown as Page<Transfer>),
  });
  const listQuery = list.query;

  const onError = (err: unknown) =>
    api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['cash-transfers'] });
    void queryClient.invalidateQueries({ queryKey: ['treasury-balances'] });
  };

  const reverse = useMutation({
    mutationFn: (v: { id: string; reversalDate: string }) =>
      treasuryControllerReverseCashTransfer(v.id, { reversalDate: v.reversalDate }, { headers: idemHeaders() }),
    onSuccess: () => {
      api.success(t('treasury.reversed'));
      refresh();
    },
    onError,
  });

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
            {t('treasury.newTransfer')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={listQuery.isLoading}
        dataSource={list.rows}
        locale={tableLocale(listQuery)}
        pagination={list.pagination}
        onChange={list.onTableChange}
        columns={[
          {
            title: t('treasury.transferNo'),
            dataIndex: 'transferNo',
            key: 'transferNo',
            sorter: true,
            sortOrder: list.sortOrderOf('transferNo'),
            width: 150,
            className: 'nowrap',
            render: (v: string | null, r: Transfer) => v ?? `#${r.id}`,
          },
          {
            title: t('treasury.date'),
            dataIndex: 'transferDate',
            key: 'transferDate',
            sorter: true,
            sortOrder: list.sortOrderOf('transferDate'),
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          { title: t('treasury.fromAccount'), render: (_: unknown, r: Transfer) => codeAndName(r.fromAccount) },
          { title: t('treasury.toAccount'), render: (_: unknown, r: Transfer) => codeAndName(r.toAccount) },
          {
            title: t('treasury.amount'),
            dataIndex: 'amount',
            key: 'amount',
            sorter: true,
            sortOrder: list.sortOrderOf('amount'),
            width: 120,
            align: 'right' as const,
            render: amountCell,
          },
          { title: t('common.description'), dataIndex: 'description', ellipsis: true },
          {
            title: t('common.status'),
            width: 100,
            render: (_: unknown, r: Transfer) =>
              r.reversedAt ? (
                <Tag color="orange">{t('journal.reversedStatus')}</Tag>
              ) : (
                <Tag color="green">{t('journal.postedStatus')}</Tag>
              ),
          },
          {
            title: '',
            width: 90,
            render: (_: unknown, r: Transfer) =>
              r.reversedAt ? null : (
                <ReverseButton
                  loading={reverse.isPending && reverse.variables?.id === r.id}
                  onReverse={(reversalDate) => reverse.mutate({ id: r.id, reversalDate })}
                />
              ),
          },
        ]}
      />
      <TransferModal
        open={open}
        cashAccounts={cashAccounts}
        onClose={() => setOpen(false)}
        onCreated={() => {
          setOpen(false);
          refresh();
        }}
      />
    </div>
  );
}

function TransferModal({
  open,
  cashAccounts,
  onClose,
  onCreated,
}: {
  open: boolean;
  cashAccounts: { value: string; label: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [api, contextHolder] = message.useMessage();
  const [date, setDate] = useState<Dayjs>(dayjs());
  const [fromAccountId, setFrom] = useState<string | undefined>();
  const [toAccountId, setTo] = useState<string | undefined>();
  const [amount, setAmount] = useState<string | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [description, setDescription] = useState('');
  // One key per opened dialog: a double-click or retry replays, never posts twice.
  const idemKey = useMemo(() => crypto.randomUUID(), [open]);

  const create = useMutation({
    mutationFn: () =>
      treasuryControllerCreateCashTransfer(
        {
          transferDate: date.format('YYYY-MM-DD'),
          fromAccountId: fromAccountId!,
          toAccountId: toAccountId!,
          amount: amount!,
          referenceNo: referenceNo || undefined,
          description: description || undefined,
        },
        { headers: { 'Idempotency-Key': idemKey } },
      ),
    onSuccess: () => {
      api.success(t('common.saved'));
      setTried(false);
      setFrom(undefined);
      setTo(undefined);
      setAmount(null);
      setReferenceNo('');
      setDescription('');
      onCreated();
    },
    onError: (err) =>
      api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  const canSave = !!fromAccountId && !!toAccountId && fromAccountId !== toAccountId && dec(amount).gt(0);

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const gap = (missing: boolean) =>
    tried && missing ? { validateStatus: 'error' as const, help: t('common.requiredField') } : {};
  const trySave = () => {
    if (!canSave) {
      setTried(true);
      return;
    }
    create.mutate();
  };
  const close = () => {
    setTried(false);
    onClose();
  };

  return (
    <FormDialog
      open={open}
      title={t('treasury.newTransfer')}
      onCancel={close}
      onSave={trySave}
      saving={create.isPending}
      destroyOnHidden
    >
      {contextHolder}
      <EnterNav autoFocusWhen={open}>
        {/* Fields keep their own state; the Form only lays them out. */}
        <Form layout="vertical" component="div">
          <FormSection title={t('treasury.transferDetails')} icon={<SwapOutlined />}>
            <Form.Item label={t('treasury.date')}>
              <DatePicker value={date} onChange={(d) => d && setDate(d)} />
            </Form.Item>
            <Form.Item label={t('treasury.fromAccount')} required {...gap(!fromAccountId)}>
              <GridSelect enterOpens options={cashAccounts} value={fromAccountId} onChange={setFrom} />
            </Form.Item>
            <Form.Item label={t('treasury.toAccount')} required {...gap(!toAccountId)}>
              <GridSelect
                enterOpens
                options={cashAccounts.filter((a) => a.value !== fromAccountId)}
                value={toAccountId}
                onChange={setTo}
              />
            </Form.Item>
            <Form.Item label={t('treasury.amount')} required {...gap(!dec(amount).gt(0))}>
              <InputNumber<string> stringMode min="0" value={amount} onChange={(v) => setAmount(v)} />
            </Form.Item>
            <Form.Item label={t('treasury.referenceNo')}>
              <Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} maxLength={100} />
            </Form.Item>
            <Form.Item label={t('common.description')} className="span-all">
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
            </Form.Item>
          </FormSection>
        </Form>
      </EnterNav>
    </FormDialog>
  );
}
