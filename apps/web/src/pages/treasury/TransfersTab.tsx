import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import { Button, DatePicker, Input, InputNumber, Modal, Space, Table, Tag, Typography, message } from 'antd';
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
import { GridSelect } from '../../components/GridSelect';
import { ReverseButton } from '../../components/ReverseButton';
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

  const { data, isLoading } = useQuery({
    queryKey: ['cash-transfers'],
    queryFn: () => treasuryControllerListCashTransfers().then((r) => r.data as unknown as Transfer[]),
  });

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
      <div style={{ marginBottom: 12, textAlign: 'end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          {t('treasury.newTransfer')}
        </Button>
      </div>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: t('treasury.transferNo'),
            dataIndex: 'transferNo',
            width: 150,
            className: 'nowrap',
            render: (v: string | null, r: Transfer) => v ?? `#${r.id}`,
          },
          {
            title: t('treasury.date'),
            dataIndex: 'transferDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          { title: t('treasury.fromAccount'), render: (_: unknown, r: Transfer) => codeAndName(r.fromAccount) },
          { title: t('treasury.toAccount'), render: (_: unknown, r: Transfer) => codeAndName(r.toAccount) },
          { title: t('treasury.amount'), dataIndex: 'amount', width: 120, align: 'right' as const, render: amountCell },
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

  return (
    <Modal
      open={open}
      title={t('treasury.newTransfer')}
      onCancel={onClose}
      onOk={() => create.mutate()}
      okText={t('common.save')}
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !canSave }}
      width={640}
      destroyOnHidden
    >
      {contextHolder}
      <EnterNav autoFocusWhen={open}>
        <Space wrap style={{ marginBottom: 12 }}>
          <div>
            <Typography.Text type="secondary">{t('treasury.date')}</Typography.Text>
            <DatePicker style={{ display: 'block' }} value={date} onChange={(d) => d && setDate(d)} />
          </div>
          <div>
            <Typography.Text type="secondary">{t('treasury.fromAccount')} *</Typography.Text>
            <GridSelect
              enterOpens
              style={{ width: 220, display: 'block' }}
              options={cashAccounts}
              value={fromAccountId}
              onChange={setFrom}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('treasury.toAccount')} *</Typography.Text>
            <GridSelect
              enterOpens
              style={{ width: 220, display: 'block' }}
              options={cashAccounts.filter((a) => a.value !== fromAccountId)}
              value={toAccountId}
              onChange={setTo}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('treasury.amount')} *</Typography.Text>
            <InputNumber<string>
              stringMode
              min="0"
              style={{ width: 140, display: 'block' }}
              value={amount}
              onChange={(v) => setAmount(v)}
            />
          </div>
          <div>
            <Typography.Text type="secondary">{t('treasury.referenceNo')}</Typography.Text>
            <Input
              style={{ width: 140, display: 'block' }}
              value={referenceNo}
              onChange={(e) => setReferenceNo(e.target.value)}
              maxLength={100}
            />
          </div>
        </Space>
        <div>
          <Typography.Text type="secondary">{t('common.description')}</Typography.Text>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
      </EnterNav>
    </Modal>
  );
}
