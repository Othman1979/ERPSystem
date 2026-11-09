import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import {
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  apiFetch,
  accountingControllerListAccounts,
  partiesControllerList,
  purchasesControllerListInvoices as listPurchaseInvoices,
  salesControllerListInvoices as listSalesInvoices,
  treasuryControllerCreateBankAccount,
  treasuryControllerCreateCashBox,
  treasuryControllerCreatePayment,
  treasuryControllerCreateReceipt,
  treasuryControllerGetPayment,
  treasuryControllerGetReceipt,
  treasuryControllerDeleteBankAccount,
  treasuryControllerDeleteCashBox,
  treasuryControllerListBankAccounts,
  treasuryControllerListCashBoxes,
  treasuryControllerListPayments,
  treasuryControllerListReceipts,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { codeAndName, displayName } from '../i18n/displayName';
import { EnterNav } from '../components/EnterNav';
import { GridSelect } from '../components/GridSelect';
import { amountCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';

// ------------------------------------------------------------- types

interface Party {
  id: string;
  code: string;
  nameAr: string;
  partyType: string;
}
interface AccountNode {
  id: string;
  code: string;
  nameAr: string;
  controlType?: string | null;
  children?: AccountNode[];
}
interface CashBox {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  account?: { code: string; nameAr: string };
}
interface BankAccount {
  id: string;
  bankName: string;
  accountNoMasked?: string | null;
  ibanMasked?: string | null;
  isActive: boolean;
  account?: { code: string; nameAr: string };
}
interface Voucher {
  id: string;
  receiptNo?: string | null;
  paymentNo?: string | null;
  receiptDate?: string;
  paymentDate?: string;
  amount: string;
  description?: string | null;
  party?: { code: string; nameAr: string; partyType: string } | null;
  cashAccount?: { code: string; nameAr: string };
  status?: string;
  allocations?: { id: string; amount: string; documentType: string }[];
}
interface OpenInvoice {
  id: string;
  invoiceNo: string | null;
  invoiceDate: string;
  grandTotal: string;
  paidAmount: string;
  /** grand − paid − posted credit returns, computed by the API. */
  outstanding: string;
  customerId?: string;
  supplierId?: string;
}

const money = (v?: string | null) => formatAmount(v);

// ------------------------------------------------------------- lookups

function useTreasuryLookups() {
  const accounts = useQuery({
    queryKey: ['accounts-tree'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as AccountNode[]),
  });
  const parties = useQuery({
    queryKey: ['parties', 'all'],
    queryFn: () => partiesControllerList({ partyType: '', isActive: '' }).then((r) => r.data as unknown as Party[]),
  });

  const cashAccounts = useMemo(() => {
    const flat: { value: string; label: string }[] = [];
    const walk = (ns: AccountNode[]) => {
      for (const n of ns) {
        if ((n.controlType === 'CASH' || n.controlType === 'BANK') && !n.children?.length) {
          flat.push({ value: n.id, label: codeAndName(n) });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(accounts.data ?? []);
    return flat;
  }, [accounts.data]);

  return {
    cashAccounts,
    parties: parties.data ?? [],
  };
}

// ------------------------------------------------------------- page

export function TreasuryPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('boxes');
  return (
    <div>
      <PageHeader title={t('nav.treasury')} />
      <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: 'boxes', label: t('treasury.cashBoxes'), children: <CashBoxesTab /> },
        { key: 'banks', label: t('treasury.bankAccounts'), children: <BankAccountsTab /> },
        { key: 'receipts', label: t('treasury.receipts'), children: <ReceiptsTab /> },
        { key: 'payments', label: t('treasury.payments'), children: <PaymentsTab /> },
      ]}
      />
    </div>
  );
}

// ------------------------------------------------------------- cash boxes

function CashBoxesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CashBox | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useTreasuryLookups();

  const { data: boxes, isLoading } = useQuery({
    queryKey: ['cash-boxes'],
    queryFn: () => treasuryControllerListCashBoxes().then((r) => r.data as unknown as CashBox[]),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['cash-boxes'] });
  const onError = (err: unknown) =>
    apiMessage.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true });
    setModalOpen(true);
  };
  const openEdit = (b: CashBox) => {
    setEditing(b);
    form.setFieldsValue({ code: b.code, name: b.name, accountId: undefined, isActive: b.isActive });
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      const payload = {
        code: values.code,
        name: values.name,
        accountId: values.accountId,
        isActive: values.isActive,
      } as never;
      return editing
        ? apiFetch(`/api/v1/cash-boxes/${editing.id}`, { method: 'PUT', body: JSON.stringify({ name: values.name, accountId: values.accountId, isActive: values.isActive }) })
        : treasuryControllerCreateCashBox(payload);
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => treasuryControllerDeleteCashBox(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
    },
    onError,
  });

  const columns = [
    { title: t('treasury.code'), dataIndex: 'code', width: 110 },
    { title: t('treasury.name'), dataIndex: 'name' },
    {
      title: t('treasury.linkedAccount'),
      dataIndex: 'account',
      render: (_: unknown, b: CashBox) => (b.account ? codeAndName(b.account) : '—'),
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('common.active') : t('common.inactive')}</Tag>,
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, b: CashBox) => (
        <Space>
          <Button size="small" onClick={() => openEdit(b)}>{t('common.edit')}</Button>
          <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => del.mutate(b.id)}>
            <Button size="small" danger>{t('common.delete')}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {contextHolder}
      <div style={{ marginBottom: 12, textAlign: 'end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('treasury.newCashBox')}</Button>
      </div>
      <Table rowKey="id" loading={isLoading} dataSource={boxes ?? []} columns={columns} size="small" pagination={false} />
      <Modal open={modalOpen} title={editing ? t('treasury.editCashBox') : t('treasury.newCashBox')} onCancel={() => setModalOpen(false)} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          {!editing && (
            <Form.Item name="code" label={t('treasury.code')} rules={[{ required: true }]}>
              <Input maxLength={50} />
            </Form.Item>
          )}
          <Form.Item name="name" label={t('treasury.name')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="accountId" label={t('treasury.linkedAccount')} rules={[{ required: true }]} extra={editing ? t('treasury.accountLocked') : undefined}>
            <Select
              showSearch
              optionFilterProp="label"
              disabled={!!editing}
              options={lookups.cashAccounts}
            />
          </Form.Item>
          <Form.Item name="isActive" label={t('common.active')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------- bank accounts

function BankAccountsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccount | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useTreasuryLookups();

  const { data: banks, isLoading } = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => treasuryControllerListBankAccounts().then((r) => r.data as unknown as BankAccount[]),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
  const onError = (err: unknown) =>
    apiMessage.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ isActive: true });
    setModalOpen(true);
  };
  const openEdit = (b: BankAccount) => {
    setEditing(b);
    form.setFieldsValue({
      bankName: b.bankName,
      accountNoMasked: b.accountNoMasked ?? undefined,
      ibanMasked: b.ibanMasked ?? undefined,
      accountId: undefined,
      isActive: b.isActive,
    });
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: (values: Record<string, unknown>) => {
      if (editing) {
        return apiFetch(`/api/v1/bank-accounts/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            bankName: values.bankName,
            accountNoMasked: values.accountNoMasked,
            ibanMasked: values.ibanMasked,
            accountId: values.accountId,
            isActive: values.isActive,
          }),
        });
      }
      return treasuryControllerCreateBankAccount({
        bankName: values.bankName,
        accountNoMasked: values.accountNoMasked,
        ibanMasked: values.ibanMasked,
        accountId: values.accountId,
        isActive: values.isActive,
      } as never);
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => treasuryControllerDeleteBankAccount(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
    },
    onError,
  });

  const columns = [
    { title: t('treasury.bankName'), dataIndex: 'bankName' },
    { title: t('treasury.accountNo'), dataIndex: 'accountNoMasked', width: 140, render: (v?: string | null) => v ?? '—' },
    { title: t('treasury.iban'), dataIndex: 'ibanMasked', width: 180, render: (v?: string | null) => v ?? '—' },
    {
      title: t('treasury.linkedAccount'),
      dataIndex: 'account',
      render: (_: unknown, b: BankAccount) => (b.account ? codeAndName(b.account) : '—'),
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('common.active') : t('common.inactive')}</Tag>,
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, b: BankAccount) => (
        <Space>
          <Button size="small" onClick={() => openEdit(b)}>{t('common.edit')}</Button>
          <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => del.mutate(b.id)}>
            <Button size="small" danger>{t('common.delete')}</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      {contextHolder}
      <div style={{ marginBottom: 12, textAlign: 'end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('treasury.newBankAccount')}</Button>
      </div>
      <Table rowKey="id" loading={isLoading} dataSource={banks ?? []} columns={columns} size="small" pagination={false} />
      <Modal open={modalOpen} title={editing ? t('treasury.editBankAccount') : t('treasury.newBankAccount')} onCancel={() => setModalOpen(false)} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="bankName" label={t('treasury.bankName')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="accountNoMasked" label={t('treasury.accountNo')} style={{ flex: 1 }}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="ibanMasked" label={t('treasury.iban')} style={{ flex: 1 }}>
              <Input maxLength={50} />
            </Form.Item>
          </Space>
          <Form.Item name="accountId" label={t('treasury.linkedAccount')} rules={[{ required: true }]} extra={t('treasury.accountLocked')}>
            <Select showSearch optionFilterProp="label" disabled={!!editing} options={lookups.cashAccounts} />
          </Form.Item>
          <Form.Item name="isActive" label={t('common.active')} valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------- vouchers

function VouchersTab({ kind }: { kind: 'receipt' | 'payment' }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [, contextHolder] = message.useMessage();

  const listFn = kind === 'receipt' ? treasuryControllerListReceipts : treasuryControllerListPayments;
  const getFn = kind === 'receipt'
    ? (id: string) => treasuryControllerGetReceipt(id)
    : (id: string) => treasuryControllerGetPayment(id);

  const { data: vouchers, isLoading } = useQuery({
    queryKey: [kind === 'receipt' ? 'receipts' : 'payments'],
    queryFn: () => listFn().then((r) => r.data as unknown as Voucher[]),
  });
  const { data: view } = useQuery({
    queryKey: [kind, viewId],
    queryFn: () => getFn(viewId!).then((r: { data: unknown }) => r.data as unknown as Voucher),
    enabled: !!viewId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [kind === 'receipt' ? 'receipts' : 'payments'] });
    void queryClient.invalidateQueries({ queryKey: ['sales-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
  };

  const columns = [
    {
      title: kind === 'receipt' ? t('treasury.receiptNo') : t('treasury.paymentNo'),
      width: 140,
      render: (_: unknown, v: Voucher) => v.receiptNo ?? v.paymentNo ?? `#${v.id}`,
    },
    {
      title: t('treasury.date'),
      width: 110,
      render: (_: unknown, v: Voucher) => dayjs(v.receiptDate ?? v.paymentDate).format('YYYY-MM-DD'),
    },
    {
      title: t('parties.name'),
      render: (_: unknown, v: Voucher) => (v.party ? codeAndName(v.party) : '—'),
    },
    {
      title: t('treasury.cashAccount'),
      render: (_: unknown, v: Voucher) => (v.cashAccount ? codeAndName(v.cashAccount) : '—'),
    },
    { title: t('treasury.amount'), dataIndex: 'amount', width: 120, align: 'right' as const, render: amountCell },
    { title: t('common.description'), dataIndex: 'description', ellipsis: true },
    {
      title: '',
      width: 90,
      render: (_: unknown, v: Voucher) => <Button size="small" onClick={() => setViewId(v.id)}>{t('common.view')}</Button>,
    },
  ];

  return (
    <div>
      {contextHolder}
      <div style={{ marginBottom: 12, textAlign: 'end' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          {kind === 'receipt' ? t('treasury.newReceipt') : t('treasury.newPayment')}
        </Button>
      </div>
      <Table rowKey="id" loading={isLoading} dataSource={vouchers ?? []} columns={columns} size="small" pagination={{ pageSize: 20 }} />
      <VoucherModal
        kind={kind}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          invalidate();
        }}
      />
      <Modal
        open={!!viewId}
        title={view?.receiptNo ?? view?.paymentNo ?? `#${viewId}`}
        onCancel={() => setViewId(null)}
        footer={null}
        width={640}
      >
        {view && (
          <>
            <Typography.Paragraph>
              <strong>{t('treasury.amount')}:</strong> {money(view.amount)}
              {view.party && <> — <strong>{t('parties.name')}:</strong> {displayName(view.party)}</>}
              {view.cashAccount && <> — <strong>{t('treasury.cashAccount')}:</strong> {codeAndName(view.cashAccount)}</>}
            </Typography.Paragraph>
            {view.description && <Typography.Paragraph type="secondary">{view.description}</Typography.Paragraph>}
            {(view.allocations?.length ?? 0) > 0 && (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={view.allocations}
                columns={[
                  { title: t('treasury.documentType'), dataIndex: 'documentType', width: 160 },
                  { title: t('treasury.amount'), dataIndex: 'amount', width: 120, align: 'right' as const, render: amountCell },
                ]}
              />
            )}
          </>
        )}
      </Modal>
    </div>
  );
}

function ReceiptsTab() {
  return <VouchersTab kind="receipt" />;
}
function PaymentsTab() {
  return <VouchersTab kind="payment" />;
}

// ------------------------------------------------------------- voucher modal

function VoucherModal({
  kind,
  open,
  onClose,
  onCreated,
}: {
  kind: 'receipt' | 'payment';
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const [voucherDate, setVoucherDate] = useState<Dayjs>(dayjs());
  const [partyType, setPartyType] = useState<'CUSTOMER' | 'SUPPLIER'>('CUSTOMER');
  const [partyId, setPartyId] = useState<string | undefined>();
  const [cashAccountId, setCashAccountId] = useState<string | undefined>();
  const [amount, setAmount] = useState<string | null>(null);
  const [referenceNo, setReferenceNo] = useState('');
  const [description, setDescription] = useState('');
  const [allocations, setAllocations] = useState<{ documentId: string; amount: string | null }[]>([]);

  const lookups = useTreasuryLookups();

  const parties = lookups.parties.filter(
    (p) => p.partyType === partyType || p.partyType === 'BOTH',
  );
  const partyOptions = parties.map((p) => ({ value: p.id, label: codeAndName(p) }));

  // Open invoices for allocations
  const { data: salesInvoices } = useQuery({
    queryKey: ['sales-invoices', 'POSTED'],
    queryFn: () => listSalesInvoices({ status: 'POSTED', paymentType: '', customerId: '' }).then((r) => r.data as unknown as OpenInvoice[]),
    enabled: open && kind === 'receipt',
  });
  const { data: purchaseInvoices } = useQuery({
    queryKey: ['purchase-invoices', 'POSTED'],
    queryFn: () => listPurchaseInvoices({ status: 'POSTED', paymentType: '', supplierId: '' }).then((r) => r.data as unknown as OpenInvoice[]),
    enabled: open && kind === 'payment',
  });

  const openInvoices = useMemo(() => {
    const src = kind === 'receipt' ? salesInvoices ?? [] : purchaseInvoices ?? [];
    return src.filter((i) => {
      if (!partyId) return false;
      const pid = kind === 'receipt' ? i.customerId : i.supplierId;
      return pid === partyId && dec(i.outstanding).gt(0);
    });
  }, [kind, salesInvoices, purchaseInvoices, partyId]);

  const invoiceOptions = openInvoices.map((i) => ({
    value: i.id,
    label: `${i.invoiceNo ?? `#${i.id}`} — ${t('treasury.remaining', { amount: formatAmount(i.outstanding) })}`,
  }));

  const docType = kind === 'receipt' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';

  const create = useMutation({
    mutationFn: () => {
      const base = {
        [kind === 'receipt' ? 'receiptDate' : 'paymentDate']: voucherDate.format('YYYY-MM-DD'),
        partyType,
        partyId,
        cashAccountId,
        amount: amount ?? undefined,
        referenceNo: referenceNo || undefined,
        description: description || undefined,
        allocations: allocations
          .filter((a) => a.documentId && dec(a.amount).gt(0))
          .map((a) => ({ documentType: docType, documentId: a.documentId, amount: a.amount as string })),
      };
      return kind === 'receipt'
        ? treasuryControllerCreateReceipt(base as never)
        : treasuryControllerCreatePayment(base as never);
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      onCreated();
    },
    onError: (err) =>
      apiMessage.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  const canSave = !!partyId && !!cashAccountId && dec(amount).gt(0);

  return (
    <Modal
      open={open}
      title={kind === 'receipt' ? t('treasury.newReceipt') : t('treasury.newPayment')}
      onCancel={onClose}
      onOk={() => create.mutate()}
      okText={t('common.save')}
      confirmLoading={create.isPending}
      okButtonProps={{ disabled: !canSave }}
      width={720}
      destroyOnHidden
    >
      {contextHolder}
      <EnterNav autoFocusWhen={open}>
      <Space wrap style={{ marginBottom: 12 }}>
        <div>
          <Typography.Text type="secondary">{t('treasury.date')}</Typography.Text>
          <DatePicker style={{ display: 'block' }} value={voucherDate} onChange={(d) => d && setVoucherDate(d)} />
        </div>
        <div>
          <Typography.Text type="secondary">{t('parties.type')}</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 130, display: 'block' }}
            value={partyType}
            onChange={(v) => {
              setPartyType(v);
              setPartyId(undefined);
              setAllocations([]);
            }}
            options={[
              { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
              { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
            ]}
          />
        </div>
        <div>
          <Typography.Text type="secondary">{t('parties.name')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 240, display: 'block' }}
            options={partyOptions}
            value={partyId}
            onChange={(v) => {
              setPartyId(v);
              setAllocations([]);
            }}
          />
        </div>
        <div>
          <Typography.Text type="secondary">{t('treasury.cashAccount')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 220, display: 'block' }}
            options={lookups.cashAccounts}
            value={cashAccountId}
            onChange={setCashAccountId}
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
          <Input style={{ width: 140, display: 'block' }} value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} maxLength={100} />
        </div>
        <div style={{ flex: 1, minWidth: 200 }}>
          <Typography.Text type="secondary">{t('common.description')}</Typography.Text>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
      </Space>

      {partyId && openInvoices.length > 0 && (
        <>
          <Typography.Text strong>{t('treasury.allocations')}</Typography.Text>
          <Table
            rowKey={(_r, i) => String(i)}
            size="small"
            pagination={false}
            dataSource={allocations.length ? allocations : [{ documentId: '', amount: null }]}
            columns={[
              {
                title: t('treasury.invoice'),
                render: (_: unknown, _a: { documentId: string; amount: string | null }, idx: number) => (
                  <GridSelect
                    enterOpens
                    style={{ width: '100%' }}
                    placeholder={t('treasury.selectInvoice')}
                    options={invoiceOptions}
                    value={allocations[idx]?.documentId || undefined}
                    onChange={(v) =>
                      setAllocations((rows) => {
                        const next = [...rows];
                        next[idx] = { ...next[idx], documentId: v };
                        return next;
                      })
                    }
                  />
                ),
              },
              {
                title: t('treasury.amount'),
                width: 140,
                render: (_: unknown, _a: { documentId: string; amount: string | null }, idx: number) => (
                  <InputNumber<string>
                    stringMode
                    min="0"
                    style={{ width: '100%' }}
                    value={allocations[idx]?.amount ?? null}
                    onChange={(v) =>
                      setAllocations((rows) => {
                        const next = [...rows];
                        next[idx] = { ...next[idx], amount: v };
                        return next;
                      })
                    }
                  />
                ),
              },
              {
                title: '',
                width: 50,
                render: (_: unknown, _a: unknown, idx: number) => (
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<PlusOutlined rotate={45} />}
                    onClick={() => setAllocations((rows) => rows.filter((_, i) => i !== idx))}
                  />
                ),
              },
            ]}
          />
          <Button
            size="small"
            style={{ marginTop: 8 }}
            icon={<PlusOutlined />}
            onClick={() => setAllocations((rows) => [...rows, { documentId: '', amount: null }])}
          >
            {t('treasury.addAllocation')}
          </Button>
        </>
      )}
      </EnterNav>
    </Modal>
  );
}
