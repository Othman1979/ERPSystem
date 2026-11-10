import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BankOutlined, PlusOutlined, PrinterOutlined, SaveOutlined, WalletOutlined } from '@ant-design/icons';
import {
  Button,
  Radio,
  Checkbox,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
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
  treasuryControllerAllocatePayment,
  treasuryControllerAllocateReceipt,
  treasuryControllerCancelAllocation,
  treasuryControllerReversePayment,
  treasuryControllerReverseReceipt,
} from '@erp/api-client';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { codeAndName, displayName } from '../i18n/displayName';
import { EnterNav } from '../components/EnterNav';
import { ReverseButton } from '../components/ReverseButton';
import { idemHeaders } from '../idempotency';
import { useNewFromUrl } from '../useNewFromUrl';
import { useSearchParams } from 'react-router';
import { BalancesTab } from './treasury/BalancesTab';
import { TransfersTab } from './treasury/TransfersTab';
import { enterTo, focusNamedField, GridSelect } from '../components/GridSelect';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { amountCell } from '../format/cells';
import { dec, formatAmount, sum } from '../format/number';

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
  referenceNo?: string | null;
  description?: string | null;
  party?: { code: string; nameAr: string; partyType: string } | null;
  cashAccount?: { code: string; nameAr: string };
  status?: string;
  /** Set once the voucher is reversed (Phase 6); it then stays read-only. */
  reversedAt?: string | null;
  allocations?: {
    id: string;
    amount: string;
    documentType: string;
    documentId: string;
    cancelledAt: string | null;
  }[];
  /** Active allocations only (cancelled ones are history). */
  allocatedAmount?: string;
  unallocatedAmount?: string;
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
  // ?tab=receipts (home quick actions) opens straight on that tab.
  const [params] = useSearchParams();
  const [tab, setTab] = useState(() => params.get('tab') ?? 'boxes');
  const lookups = useTreasuryLookups();
  return (
    <div>
      <PageHeader title={t('nav.treasury')} />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyOnHidden
        items={[
          { key: 'boxes', label: t('treasury.cashBoxes'), children: <CashBoxesTab /> },
          { key: 'banks', label: t('treasury.bankAccounts'), children: <BankAccountsTab /> },
          { key: 'receipts', label: t('treasury.receipts'), children: <ReceiptsTab /> },
          { key: 'payments', label: t('treasury.payments'), children: <PaymentsTab /> },
          {
            key: 'transfers',
            label: t('treasury.transfers'),
            children: <TransfersTab cashAccounts={lookups.cashAccounts} />,
          },
          { key: 'balances', label: t('treasury.balances'), children: <BalancesTab /> },
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
  const [search, setSearch] = useState('');
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

  const shown = (boxes ?? []).filter((b) =>
    matchesSearch(search, b.code, b.name, b.account ? codeAndName(b.account) : null),
  );

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('treasury.newCashBox')}</Button>}
      />
      <Table rowKey="id" loading={isLoading} dataSource={shown} columns={columns} size="small" pagination={false} />
      <FormDialog open={modalOpen} title={editing ? t('treasury.editCashBox') : t('treasury.newCashBox')} onCancel={() => setModalOpen(false)} onSave={() => form.submit()} saving={save.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection
            title={t('treasury.cashBoxDetails')}
            icon={<WalletOutlined />}
            extra={
              <>
                {t('common.active')}
                <Form.Item name="isActive" valuePropName="checked" noStyle>
                  <Switch size="small" />
                </Form.Item>
              </>
            }
          >
          {!editing && (
            <Form.Item name="code" label={t('treasury.code')} rules={[{ required: true }]}>
              <Input maxLength={50} />
            </Form.Item>
          )}
          <Form.Item name="name" label={t('treasury.name')} rules={[{ required: true }]} className="span-2">
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="accountId" label={t('treasury.linkedAccount')} rules={[{ required: true }]} extra={editing ? t('treasury.accountLocked') : undefined} className="span-all">
            <Select
              showSearch
              optionFilterProp="label"
              disabled={!!editing}
              options={lookups.cashAccounts}
            />
          </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </div>
  );
}

// ------------------------------------------------------------- bank accounts

function BankAccountsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState('');
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

  const shown = (banks ?? []).filter((b) =>
    matchesSearch(search, b.bankName, b.accountNoMasked, b.account ? codeAndName(b.account) : null),
  );

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={<Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>{t('treasury.newBankAccount')}</Button>}
      />
      <Table rowKey="id" loading={isLoading} dataSource={shown} columns={columns} size="small" pagination={false} />
      <FormDialog open={modalOpen} title={editing ? t('treasury.editBankAccount') : t('treasury.newBankAccount')} onCancel={() => setModalOpen(false)} onSave={() => form.submit()} saving={save.isPending} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection
            title={t('treasury.bankAccountDetails')}
            icon={<BankOutlined />}
            extra={
              <>
                {t('common.active')}
                <Form.Item name="isActive" valuePropName="checked" noStyle>
                  <Switch size="small" />
                </Form.Item>
              </>
            }
          >
            <Form.Item name="bankName" label={t('treasury.bankName')} rules={[{ required: true }]} className="span-all">
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="accountNoMasked" label={t('treasury.accountNo')}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="ibanMasked" label={t('treasury.iban')} className="span-2">
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="accountId" label={t('treasury.linkedAccount')} rules={[{ required: true }]} extra={t('treasury.accountLocked')} className="span-all">
              <Select showSearch optionFilterProp="label" disabled={!!editing} options={lookups.cashAccounts} />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </div>
  );
}

// ------------------------------------------------------------- vouchers

function VouchersTab({ kind }: { kind: 'receipt' | 'payment' }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  useNewFromUrl(() => setModalOpen(true));
  const [search, setSearch] = useState('');
  const [viewId, setViewId] = useState<string | null>(null);
  const [api, contextHolder] = message.useMessage();
  const onError = (err: unknown) =>
    api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

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
    void queryClient.invalidateQueries({ queryKey: [kind] });
    void queryClient.invalidateQueries({ queryKey: ['sales-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['treasury-balances'] });
  };

  // Phase 6: reverse, allocate the remainder (oldest first), cancel an allocation.
  const reverse = useMutation({
    mutationFn: (v: { id: string; reversalDate: string }) =>
      (kind === 'receipt' ? treasuryControllerReverseReceipt : treasuryControllerReversePayment)(
        v.id,
        { reversalDate: v.reversalDate },
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      api.success(t('treasury.reversed'));
      invalidate();
    },
    onError,
  });
  const allocateRest = useMutation({
    mutationFn: (id: string) =>
      (kind === 'receipt' ? treasuryControllerAllocateReceipt : treasuryControllerAllocatePayment)(
        id,
        { auto: true },
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      api.success(t('common.saved'));
      invalidate();
    },
    onError,
  });
  const cancelAllocation = useMutation({
    mutationFn: (allocationId: string) =>
      treasuryControllerCancelAllocation(allocationId, { headers: idemHeaders() }),
    onSuccess: () => {
      api.success(t('common.done'));
      invalidate();
    },
    onError,
  });

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
      title: t('common.status'),
      width: 100,
      render: (_: unknown, v: Voucher) =>
        v.reversedAt ? (
          <Tag color="orange">{t('journal.reversedStatus')}</Tag>
        ) : (
          <Tag color="green">{t('journal.postedStatus')}</Tag>
        ),
    },
    {
      title: '',
      width: 90,
      render: (_: unknown, v: Voucher) => <Button size="small" onClick={() => setViewId(v.id)}>{t('common.view')}</Button>,
    },
  ];

  const voucherTitle = kind === 'receipt' ? t('journal.typeReceipt') : t('journal.typePayment');

  // A new voucher and an existing voucher each open as a full document page.
  if (modalOpen) {
    return (
      <VoucherForm
        kind={kind}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          invalidate();
        }}
      />
    );
  }

  if (viewId) {
    return (
      <>
        {contextHolder}
        <DocLayout
          title={voucherTitle}
          docNo={view?.receiptNo ?? view?.paymentNo ?? `#${viewId}`}
          status={view ? 'POSTED' : undefined}
          onBack={() => setViewId(null)}
          actions={
            view && (
              <>
                {!view.reversedAt && view.party && dec(view.unallocatedAmount).gt(0) && (
                  <Button loading={allocateRest.isPending} onClick={() => allocateRest.mutate(view.id)}>
                    {t('treasury.allocateRemaining')}
                  </Button>
                )}
                {!view.reversedAt && (
                  <ReverseButton
                    size="middle"
                    loading={reverse.isPending}
                    onReverse={(reversalDate) => reverse.mutate({ id: view.id, reversalDate })}
                  />
                )}
                <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
                  {t('common.print')}
                </Button>
              </>
            )
          }
        >
          {view ? (
            <>
              <DocFields>
                <DocField label={t('treasury.date')}>
                  <DocValue>{dayjs(view.receiptDate ?? view.paymentDate).format('YYYY-MM-DD')}</DocValue>
                </DocField>
                <DocField label={t('parties.name')}>
                  <DocValue>{view.party ? displayName(view.party) : '—'}</DocValue>
                </DocField>
                <DocField label={t('treasury.cashAccount')}>
                  <DocValue>{view.cashAccount ? codeAndName(view.cashAccount) : '—'}</DocValue>
                </DocField>
                <DocField label={t('treasury.amount')}>
                  <DocValue>{amountCell(view.amount)}</DocValue>
                </DocField>
                {view.party && (
                  <DocField label={`${t('treasury.allocated')} / ${t('treasury.unallocated')}`}>
                    <DocValue>
                      {amountCell(view.allocatedAmount)}
                      <span style={{ margin: '0 6px' }}>/</span>
                      {amountCell(view.unallocatedAmount)}
                    </DocValue>
                  </DocField>
                )}
                <DocField label={t('treasury.referenceNo')}>
                  <DocValue>{view.referenceNo || '—'}</DocValue>
                </DocField>
                {view.reversedAt && (
                  <DocField label={t('common.status')}>
                    <DocValue>
                      <Tag color="orange">{t('journal.reversedStatus')}</Tag>
                    </DocValue>
                  </DocField>
                )}
                <DocField label={t('common.description')} wide>
                  <DocValue>{view.description || '—'}</DocValue>
                </DocField>
              </DocFields>
              {(view.allocations?.length ?? 0) > 0 && (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={view.allocations}
                columns={[
                  {
                    title: t('treasury.documentType'),
                    width: 200,
                    render: (_: unknown, a: NonNullable<Voucher['allocations']>[number]) =>
                      `${t(`treasury.doc_${a.documentType}`, { defaultValue: a.documentType })} #${a.documentId}`,
                  },
                  { title: t('treasury.amount'), dataIndex: 'amount', width: 120, align: 'right' as const, render: amountCell },
                  {
                    title: '',
                    render: (_: unknown, a: NonNullable<Voucher['allocations']>[number]) =>
                      a.cancelledAt ? (
                        <Tag>{t('treasury.cancelled')}</Tag>
                      ) : view.reversedAt ? null : (
                        <Popconfirm
                          title={t('treasury.cancelAllocationConfirm')}
                          okText={t('treasury.cancelAllocation')}
                          cancelText={t('common.cancel')}
                          onConfirm={() => cancelAllocation.mutate(a.id)}
                        >
                          <Button size="small" loading={cancelAllocation.isPending && cancelAllocation.variables === a.id}>
                            {t('treasury.cancelAllocation')}
                          </Button>
                        </Popconfirm>
                      ),
                  },
                ]}
              />
              )}
            </>
          ) : (
            <div className="doc-section">{t('common.loading')}</div>
          )}
        </DocLayout>
      </>
    );
  }

  const shown = (vouchers ?? []).filter((v) =>
    matchesSearch(
      search,
      v.receiptNo,
      v.paymentNo,
      v.party ? codeAndName(v.party) : null,
      v.cashAccount ? codeAndName(v.cashAccount) : null,
      v.description,
    ),
  );

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            {kind === 'receipt' ? t('treasury.newReceipt') : t('treasury.newPayment')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
        onRow={(v) => ({ onClick: () => setViewId(v.id), style: { cursor: 'pointer' } })}
      />
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

function VoucherForm({
  kind,
  onClose,
  onCreated,
}: {
  kind: 'receipt' | 'payment';
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
  const [autoAllocate, setAutoAllocate] = useState(false);
  // One key per opened form: a double-click or retry replays, never posts twice.
  const idemKey = useMemo(() => crypto.randomUUID(), []);

  const lookups = useTreasuryLookups();

  const parties = lookups.parties.filter(
    (p) => p.partyType === partyType || p.partyType === 'BOTH',
  );
  const partyOptions = parties.map((p) => ({ value: p.id, label: codeAndName(p) }));

  // Open invoices for allocations
  const { data: salesInvoices } = useQuery({
    queryKey: ['sales-invoices', 'POSTED'],
    queryFn: () => listSalesInvoices({ status: 'POSTED', paymentType: 'CREDIT', customerId: '' }).then((r) => r.data as unknown as OpenInvoice[]),
    enabled: kind === 'receipt',
  });
  const { data: purchaseInvoices } = useQuery({
    queryKey: ['purchase-invoices', 'POSTED'],
    queryFn: () => listPurchaseInvoices({ status: 'POSTED', paymentType: 'CREDIT', supplierId: '' }).then((r) => r.data as unknown as OpenInvoice[]),
    enabled: kind === 'payment',
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
        autoAllocate: autoAllocate && !allocations.some((a) => a.documentId) ? true : undefined,
      };
      return kind === 'receipt'
        ? treasuryControllerCreateReceipt(base as never, { headers: { 'Idempotency-Key': idemKey } })
        : treasuryControllerCreatePayment(base as never, { headers: { 'Idempotency-Key': idemKey } });
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      onCreated();
    },
    onError: (err) =>
      apiMessage.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL')),
  });

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const missing = {
    party: !partyId,
    cashAccount: !cashAccountId,
    amount: !dec(amount).gt(0),
  };
  const trySave = () => {
    if (create.isPending) return;
    const firstMissing = (['party', 'cashAccount', 'amount'] as const).find((k) => missing[k]);
    if (firstMissing) {
      setTried(true);
      focusNamedField(firstMissing);
      return;
    }
    create.mutate();
  };
  useDocShortcuts({ onSave: trySave });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);
  const allocatedSum = sum(allocations.map((a) => a.amount));

  return (
    <DocLayout
      title={kind === 'receipt' ? t('treasury.newReceipt') : t('treasury.newPayment')}
      onBack={onClose}
      actions={
        <Button type="primary" icon={<SaveOutlined />} loading={create.isPending} onClick={trySave}>
          {t('common.save')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      {contextHolder}
      <EnterNav autoFocusWhen>
      <DocFields>
        <DocField label={t('treasury.date')}>
          <DatePicker value={voucherDate} onChange={(d) => d && setVoucherDate(d)} />
        </DocField>
        <DocField
          field="partyType"
          label={t('parties.type')}
          onKeyDown={enterTo(() => focusNamedField('party'))}
        >
          {/* Arrow keys switch between the two options (native radio group). */}
          <Radio.Group
            name="partyType"
            optionType="button"
            buttonStyle="solid"
            value={partyType}
            onChange={(e) => {
              setPartyType(e.target.value);
              setPartyId(undefined);
              setAllocations([]);
            }}
            options={[
              { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
              { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
            ]}
          />
        </DocField>
        <DocField field="party" label={t('parties.name')} required error={requiredError(missing.party)}>
          <GridSelect
            enterOpens
            status={requiredError(missing.party) ? 'error' : undefined}
            options={partyOptions}
            value={partyId}
            onChange={(v) => {
              setPartyId(v);
              setAllocations([]);
            }}
          />
        </DocField>
        <DocField
          field="cashAccount"
          label={t('treasury.cashAccount')}
          required
          error={requiredError(missing.cashAccount)}
        >
          <GridSelect
            enterOpens
            status={requiredError(missing.cashAccount) ? 'error' : undefined}
            options={lookups.cashAccounts}
            value={cashAccountId}
            onChange={setCashAccountId}
          />
        </DocField>
        <DocField field="amount" label={t('treasury.amount')} required error={requiredError(missing.amount)}>
          <InputNumber<string>
            className="doc-amount"
            stringMode
            min="0"
            status={requiredError(missing.amount) ? 'error' : undefined}
            value={amount}
            onChange={(v) => setAmount(v)}
          />
        </DocField>
        <DocField label={t('treasury.referenceNo')}>
          <Input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)} maxLength={100} />
        </DocField>
        <DocField label={t('common.description')} wide>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>

      {partyId && openInvoices.length > 0 && (
        <>
          <div className="doc-subbar">
            <span className="doc-subbar-title">{t('treasury.allocations')}</span>
            <Checkbox
              checked={autoAllocate}
              disabled={allocations.some((a) => a.documentId)}
              onChange={(e) => setAutoAllocate(e.target.checked)}
            >
              {t('treasury.autoAllocate')}
            </Checkbox>
            <span className="doc-subbar-total">
              {t('treasury.allocated')}: {amountCell(allocatedSum)}
              {dec(amount).gt(0) && (
                <>
                  {' / '}
                  {amountCell(amount)}
                </>
              )}
            </span>
          </div>
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
          <div className="doc-section">
            <Button
              size="small"
              icon={<PlusOutlined />}
              onClick={() => setAllocations((rows) => [...rows, { documentId: '', amount: null }])}
            >
              {t('treasury.addAllocation')}
            </Button>
          </div>
        </>
      )}
      </EnterNav>
    </DocLayout>
  );
}
