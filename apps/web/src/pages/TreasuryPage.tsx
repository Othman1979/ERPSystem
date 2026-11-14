import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BankOutlined, PlusOutlined, SaveOutlined, WalletOutlined } from '@ant-design/icons';
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
  branchesControllerList,
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
  treasuryControllerUpdateBankAccount,
  treasuryControllerUpdateCashBox,
  type AllocationDto,
  type BankAccountListItemDto,
  type CashBoxListItemDto,
  type PartyDto,
  type PaymentDetailDto,
  type PaymentListItemDto,
  type PurchaseInvoiceListItemDto,
  type ReceiptDetailDto,
  type ReceiptListItemDto,
  type SalesInvoiceListItemDto,
  type TreasuryAllocationDto,
  type TreasuryControllerListPaymentsSort,
  type TreasuryControllerListReceiptsSort,
} from '@erp/api-client';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { codeAndName, displayName } from '../i18n/displayName';
import { EnterNav } from '../components/EnterNav';
import { ReverseButton } from '../components/ReverseButton';
import { idemHeaders } from '../idempotency';
import { useNewFromUrl } from '../useNewFromUrl';
import { useSearchParams } from 'react-router';
import { selectCashBank, useAccounts } from '../hooks/useAccounts';
import { BalancesTab } from './treasury/BalancesTab';
import { TransfersTab } from './treasury/TransfersTab';
import { enterTo, focusNamedField, GridSelect } from '../components/GridSelect';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { amountCell } from '../format/cells';
import { dec, formatAmount, sum } from '../format/number';
import { usePagedQuery, type Page } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';

// ------------------------------------------------------------- types

type Party = PartyDto;
type CashBox = CashBoxListItemDto;
type BankAccount = BankAccountListItemDto;
/** A receipt or a payment in the list. */
type Voucher = ReceiptListItemDto | PaymentListItemDto;
/** A receipt or a payment with its allocations. */
type VoucherDetail = ReceiptDetailDto | PaymentDetailDto;
/** An open invoice to allocate against: a sales invoice for a receipt, a purchase invoice for a payment. */
type OpenInvoice = SalesInvoiceListItemDto | PurchaseInvoiceListItemDto;

/** Receipts and payments name their number and date fields differently. */
const voucherNoOf = (v: Voucher | VoucherDetail) => ('receiptNo' in v ? v.receiptNo : v.paymentNo);
const voucherDateOf = (v: Voucher | VoucherDetail) => ('receiptDate' in v ? v.receiptDate : v.paymentDate);

/** Form values of the cash box dialog. `code` is only shown when creating. */
interface CashBoxForm {
  code?: string;
  name: string;
  accountId: string;
  /** Empty = every branch. */
  branchId?: string;
  isActive?: boolean;
}
/** Form values of the bank account dialog. */
interface BankAccountForm {
  bankName: string;
  accountNoMasked?: string;
  ibanMasked?: string;
  accountId: string;
  isActive?: boolean;
}

// ------------------------------------------------------------- lookups

/** Open invoices are read in pages of this size (the API's maximum). */
const OPEN_INVOICE_PAGE_SIZE = 100;

/**
 * Every row of a numbered list, page by page, until the server's total is in.
 * Stops on an empty page too, so a total that moved cannot loop forever.
 */
async function fetchAllOpenInvoices<T extends OpenInvoice>(
  fetchPage: (page: number, signal: AbortSignal) => Promise<Page<T>>,
  signal: AbortSignal,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page += 1) {
    const res = await fetchPage(page, signal);
    rows.push(...res.items);
    if (res.items.length === 0 || rows.length >= res.total) return rows;
  }
}

function useTreasuryLookups() {
  const accounts = useAccounts(selectCashBank);

  const cashAccounts = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) })),
    [accounts.data],
  );

  return { cashAccounts };
}

/**
 * Parties for a voucher's picker: the side's own parties plus BOTH ones. The API
 * matches partyType exactly, so this asks twice (a BOTH party can be either side).
 */
function pickParties(side: 'CUSTOMER' | 'SUPPLIER', q: string | undefined, signal: AbortSignal): Promise<Party[]> {
  const types = [side, 'BOTH'] as const;
  return Promise.all(
    types.map((partyType) =>
      partiesControllerList({ partyType, pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
        (r) => r.data.items,
      ),
    ),
  ).then((pages) => pages.flat());
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

  const boxesQuery = useQuery({
    queryKey: ['cash-boxes'],
    queryFn: ({ signal }) => treasuryControllerListCashBoxes({ signal }).then((r) => r.data),
  });
  const { data: boxes, isLoading } = boxesQuery;

  // Same query key as the Branches page, so the list is shared.
  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: ({ signal }) => branchesControllerList({ signal }).then((r) => r.data),
  });
  const branchOptions = (branchesQuery.data ?? []).map((b) => ({ value: b.id, label: displayName(b) }));

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
    form.setFieldsValue({
      code: b.code,
      name: b.name,
      accountId: undefined,
      branchId: b.branchId ?? undefined,
      isActive: b.isActive,
    });
    setModalOpen(true);
  };

  const save = useMutation({
    // Create and update answer different statuses (201, 200): the result is not read, so it is unknown.
    mutationFn: (values: CashBoxForm): Promise<unknown> => {
      if (editing) {
        // An emptied branch is null: the box goes back to every branch.
        return treasuryControllerUpdateCashBox(editing.id, {
          name: values.name,
          accountId: values.accountId,
          isActive: values.isActive,
          branchId: values.branchId ?? null,
        });
      }
      // The form requires `code` when creating, so it is set here.
      return treasuryControllerCreateCashBox({
        code: values.code!,
        name: values.name,
        accountId: values.accountId,
        branchId: values.branchId,
        isActive: values.isActive,
      });
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
      <Table rowKey="id" loading={isLoading} dataSource={shown} locale={tableLocale(boxesQuery)} columns={columns} size="small" pagination={false} />
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
          <Form.Item name="branchId" label={t('treasury.branch')} className="span-all">
            <Select allowClear showSearch optionFilterProp="label" placeholder={t('treasury.allBranches')} options={branchOptions} />
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

  const banksQuery = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: ({ signal }) => treasuryControllerListBankAccounts({ signal }).then((r) => r.data),
  });
  const { data: banks, isLoading } = banksQuery;

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
    mutationFn: (values: BankAccountForm): Promise<unknown> => {
      if (editing) {
        // An emptied account number or IBAN is null, which clears it.
        return treasuryControllerUpdateBankAccount(editing.id, {
          bankName: values.bankName,
          accountNoMasked: values.accountNoMasked?.trim() || null,
          ibanMasked: values.ibanMasked?.trim() || null,
          accountId: values.accountId,
          isActive: values.isActive,
        });
      }
      return treasuryControllerCreateBankAccount({
        bankName: values.bankName,
        accountNoMasked: values.accountNoMasked,
        ibanMasked: values.ibanMasked,
        accountId: values.accountId,
        isActive: values.isActive,
      });
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
      <Table rowKey="id" loading={isLoading} dataSource={shown} locale={tableLocale(banksQuery)} columns={columns} size="small" pagination={false} />
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
  const [viewId, setViewId] = useState<string | null>(null);
  const [api, contextHolder] = message.useMessage();
  const onError = (err: unknown) =>
    api.error(err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'));

  // Server-paged (ADR-022): search (number, party, cash account, description), sort and page go to the API.
  const numberKey = kind === 'receipt' ? 'receiptNo' : 'paymentNo';
  const dateKey = kind === 'receipt' ? 'receiptDate' : 'paymentDate';
  const list = usePagedQuery<
    Voucher,
    Record<string, string | undefined>,
    TreasuryControllerListReceiptsSort | TreasuryControllerListPaymentsSort
  >({
    key: [kind === 'receipt' ? 'receipts' : 'payments', 'list'],
    filters: {},
    defaultSort: `-${dateKey}`,
    fetch: async (params, signal) => {
      // The hook's `sort` is the union of both kinds' keys; each branch narrows it to its own enum.
      const sort = params.sort;
      const res =
        kind === 'receipt'
          ? await treasuryControllerListReceipts(
              { ...params, sort: sort as TreasuryControllerListReceiptsSort | undefined },
              { signal },
            )
          : await treasuryControllerListPayments(
              { ...params, sort: sort as TreasuryControllerListPaymentsSort | undefined },
              { signal },
            );
      return res.data;
    },
    enabled: !modalOpen && !viewId,
  });
  const vouchersQuery = list.query;
  const { data: view } = useQuery({
    queryKey: [kind, viewId],
    queryFn: async ({ signal }) => {
      // Enabled only while a voucher is open, so the id is set.
      const res =
        kind === 'receipt'
          ? await treasuryControllerGetReceipt(viewId!, { signal })
          : await treasuryControllerGetPayment(viewId!, { signal });
      return res.data;
    },
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
    mutationFn: async (v: { id: string; reversalDate: string }) => {
      const reverseFn = kind === 'receipt' ? treasuryControllerReverseReceipt : treasuryControllerReversePayment;
      const res = await reverseFn(v.id, { reversalDate: v.reversalDate }, { headers: idemHeaders() });
      return res.data;
    },
    onSuccess: () => {
      api.success(t('treasury.reversed'));
      invalidate();
    },
    onError,
  });
  const allocateRest = useMutation({
    mutationFn: async (id: string) => {
      const allocateFn = kind === 'receipt' ? treasuryControllerAllocateReceipt : treasuryControllerAllocatePayment;
      const res = await allocateFn(id, { auto: true }, { headers: idemHeaders() });
      return res.data;
    },
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
      key: numberKey,
      sorter: true,
      sortOrder: list.sortOrderOf(numberKey),
      width: 140,
      render: (_: unknown, v: Voucher) => voucherNoOf(v) ?? `#${v.id}`,
    },
    {
      title: t('treasury.date'),
      key: dateKey,
      sorter: true,
      sortOrder: list.sortOrderOf(dateKey),
      width: 110,
      render: (_: unknown, v: Voucher) => dayjs(voucherDateOf(v)).format('YYYY-MM-DD'),
    },
    {
      title: t('parties.name'),
      render: (_: unknown, v: Voucher) => (v.party ? codeAndName(v.party) : '—'),
    },
    {
      title: t('treasury.cashAccount'),
      render: (_: unknown, v: Voucher) => (v.cashAccount ? codeAndName(v.cashAccount) : '—'),
    },
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
          docNo={(view && voucherNoOf(view)) ?? `#${viewId}`}
          status={view ? 'POSTED' : undefined}
          onBack={() => setViewId(null)}
          actions={
            view && (
              <>
                {!view.reversedAt &&
                  view.party &&
                  // Refunds the other way (receipt from a supplier, payment to a customer) settle no invoice.
                  view.partyType === (kind === 'receipt' ? 'CUSTOMER' : 'SUPPLIER') &&
                  dec(view.unallocatedAmount).gt(0) && (
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
                <PrintPdfButton path={`/${kind === 'receipt' ? 'receipts' : 'payments'}/${view.id}/pdf`} />
              </>
            )
          }
        >
          {view ? (
            <>
              <DocFields>
                <DocField label={t('treasury.date')}>
                  <DocValue>{dayjs(voucherDateOf(view)).format('YYYY-MM-DD')}</DocValue>
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
                    render: (_: unknown, a: TreasuryAllocationDto) =>
                      `${t(`treasury.doc_${a.documentType}`, { defaultValue: a.documentType })} #${a.documentId}`,
                  },
                  { title: t('treasury.amount'), dataIndex: 'amount', width: 120, align: 'right' as const, render: amountCell },
                  {
                    title: '',
                    render: (_: unknown, a: TreasuryAllocationDto) =>
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

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            {kind === 'receipt' ? t('treasury.newReceipt') : t('treasury.newPayment')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={vouchersQuery.isLoading}
        dataSource={list.rows}
        locale={tableLocale(vouchersQuery)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
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

  // The party picker searches on the server (ADR-022 §8); a chosen party stays labelled.
  const parties = useRemoteOptions<Party>({
    key: ['parties', 'pick-voucher', partyType],
    fetch: (q, signal) => pickParties(partyType, q, signal),
  });
  const partyOptions = parties.withSelected([partyId]).map((p) => ({ value: p.id, label: codeAndName(p) }));

  // Open invoices for allocations: every open credit invoice of the party, oldest
  // first (the server's order), so a party with more than one page still gets all
  // of them. The automatic allocation covers the same invoices on the server.
  const { data: salesInvoices } = useQuery({
    queryKey: ['sales-invoices', 'open', partyId],
    queryFn: ({ signal }) =>
      fetchAllOpenInvoices(
        (page, s) =>
          listSalesInvoices(
            { customerId: partyId!, open: 'true', sort: 'invoiceDate', page, pageSize: OPEN_INVOICE_PAGE_SIZE },
            { signal: s },
          ).then((r) => r.data),
        signal,
      ),
    enabled: kind === 'receipt' && !!partyId && partyType === 'CUSTOMER',
  });
  // The supplier's open credit invoices, same shape as the customer's above.
  const { data: purchaseInvoices } = useQuery({
    queryKey: ['purchase-invoices', 'open', partyId],
    queryFn: ({ signal }) =>
      fetchAllOpenInvoices(
        (page, s) =>
          listPurchaseInvoices(
            { supplierId: partyId!, open: 'true', sort: 'invoiceDate', page, pageSize: OPEN_INVOICE_PAGE_SIZE },
            { signal: s },
          ).then((r) => r.data),
        signal,
      ),
    enabled: kind === 'payment' && !!partyId && partyType === 'SUPPLIER',
  });

  const openInvoices = useMemo((): OpenInvoice[] => {
    // Only a receipt from a customer or a payment to a supplier settles invoices;
    // a refund the other way raises the balance instead (ADR-004).
    if (!partyId || partyType !== (kind === 'receipt' ? 'CUSTOMER' : 'SUPPLIER')) return [];
    const isOpen = (i: OpenInvoice) => i.paymentType === 'CREDIT' && dec(i.outstanding).gt(0);
    if (kind === 'receipt') return (salesInvoices ?? []).filter((i) => i.customerId === partyId && isOpen(i));
    return (purchaseInvoices ?? []).filter((i) => i.supplierId === partyId && isOpen(i));
  }, [kind, salesInvoices, purchaseInvoices, partyId, partyType]);

  const invoiceOptions = openInvoices.map((i) => ({
    value: i.id,
    label: `${i.invoiceNo ?? `#${i.id}`} — ${t('treasury.remaining', { amount: formatAmount(i.outstanding) })}`,
  }));

  const docType = kind === 'receipt' ? 'SALES_INVOICE' : 'PURCHASE_INVOICE';

  const create = useMutation({
    mutationFn: async () => {
      // trySave blocks the save until party, cash account and amount are set, so they are present here.
      const body = {
        partyType,
        partyId: partyId!,
        cashAccountId: cashAccountId!,
        amount: amount!,
        referenceNo: referenceNo || undefined,
        description: description || undefined,
        allocations: allocations.flatMap((a): AllocationDto[] =>
          a.documentId && a.amount && dec(a.amount).gt(0)
            ? [{ documentType: docType, documentId: a.documentId, amount: a.amount }]
            : [],
        ),
        // Only while the allocation section is shown: a refund the other way takes none.
        autoAllocate:
          autoAllocate && openInvoices.length > 0 && !allocations.some((a) => a.documentId) ? true : undefined,
      };
      const headers = { headers: { 'Idempotency-Key': idemKey } };
      const date = voucherDate.format('YYYY-MM-DD');
      const res =
        kind === 'receipt'
          ? await treasuryControllerCreateReceipt({ receiptDate: date, ...body }, headers)
          : await treasuryControllerCreatePayment({ paymentDate: date, ...body }, headers);
      return res.data;
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
              setAutoAllocate(false);
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
            onRemoteSearch={parties.onSearch}
            searching={parties.pending}
            value={partyId}
            onChange={(v) => {
              setPartyId(v);
              setAllocations([]);
              setAutoAllocate(false);
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
            <span>{t('treasury.openInvoicesCount', { count: openInvoices.length })}</span>
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
