import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Input,
  InputNumber,
  Radio,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useRef, useState } from 'react';
import { selectCashBank, useAccounts } from '../hooks/useAccounts';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { PartyFormDialog } from '../components/PartyFormDialog';
import { ItemFormDialog } from '../components/ItemFormDialog';
import { useCompany } from '../components/CompanyProfileForm';
import { isAuthoredBy } from './procurement/orderPayload';
import { invalidateSalesCycle, salesCycleKeys } from './sales/cycleQueryKeys';
import { linesBelowOrder } from './sales/salesLines';
import { PostedRecipeComponents, RecipeIngredientsPanel } from './sales/RecipeIngredients';
import { StatusTag } from '../components/StatusTag';
import {
  emptyInvoiceLine,
  InvoiceLinesGrid,
  type InvoiceItemOption,
  type InvoiceLineDraft,
} from '../components/InvoiceLinesGrid';
import {
  enterTo,
  focusCellEl,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { ListToolbar } from '../components/ListToolbar';
import { RemoteSelect, PICKER_PAGE_SIZE } from '../components/RemoteSelect';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { LIVE_REFRESH_MS, PICKER_FRESH_MS, refetchIfOlderThan } from '../liveRefresh';
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { entryDraftStorageKey, useEntryDraft } from '../hooks/useEntryDraft';
import { documentLockHeaders, useDocumentLock } from '../hooks/useDocumentLock';
import { useDocumentLockStatus } from '../hooks/useDocumentLockStatus';
import { DocumentLockBanner } from '../components/DocumentLockBanner';
import { useCostCenters } from '../hooks/useCostCenters';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { useNewFromUrl } from '../useNewFromUrl';
import { salesInvoiceBody, salesInvoiceFormDefaults } from './sales/invoicePayload';
import { InvoiceDiscountField } from './sales/InvoiceDiscountField';
import {
  ApiError,
  catalogControllerListItems,
  warehousesControllerList,
  partiesControllerList,
  salesControllerCreateInvoice,
  salesControllerCreateReturn,
  salesControllerDeleteInvoice,
  salesControllerDeleteReturn,
  salesControllerGetInvoice,
  salesControllerGetReturn,
  salesControllerListInvoices,
  salesControllerListReturns,
  salesControllerPostInvoice,
  salesControllerPostReturn,
  salesControllerUpdateInvoice,
  salesControllerPreviewInvoice,
  salesCycleControllerApproveInvoicePrice,
  salesCycleControllerGetOrder,
  settingsControllerListTaxCategories,
  type ItemListItemDto,
  type SalesControllerListInvoicesPaymentType,
  type SalesControllerListInvoicesSort,
  type SalesControllerListInvoicesStatus,
  type SalesControllerListReturnsSort,
  type SalesControllerListReturnsStatus,
  type SalesInvoiceLineViewDto,
  type SalesInvoiceDetailDto,
  type SalesInvoiceListItemDto,
  type SalesInvoicePreviewDto,
  type SalesReturnLineViewDto,
  type SalesReturnListItemDto,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import { invalidateStockDocument } from '../stockQueries';
import {
  EInvoiceNotice,
  EInvoiceQrPanel,
  EInvoiceStatusTag,
  isInFlight,
} from './einvoice/EInvoiceStatus';

// ------------------------------------------------------------------ types

/** Lines as the detail endpoints return them. */
type InvoiceLine = SalesInvoiceLineViewDto;
type ReturnLine = SalesReturnLineViewDto;

/**
 * An item as the item picker holds it: a search result, or a line taken from a saved
 * invoice (which carries its own tax rate; the search response does not).
 */
type ItemRow = Pick<
  ItemListItemDto,
  'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'salePrice' | 'taxCategoryId'
> & { taxRate?: string };

interface SalesInvoiceDraft {
  invoiceDate: string;
  dueDate: string | null;
  customerId: string | null;
  customerOption: { value: string; label: string } | null;
  warehouseId: string | null;
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId: string | null;
  cashAccountLabel: string | null;
  costCenterId: string | null;
  invoiceDiscountType: 'PERCENT' | 'AMOUNT';
  invoiceDiscountValue: string | null;
  lines: InvoiceLineDraft[];
  selectedItems: ItemRow[];
}

const money = (v?: string | null) => formatAmount(v);

// ------------------------------------------------------------------ page

export function SalesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('invoices');
  return (
    <div>
      <PageHeader title={t('nav.sales')} />
      <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: 'invoices', label: t('sales.invoices'), children: <InvoicesTab /> },
        { key: 'returns', label: t('sales.returns'), children: <ReturnsTab /> },
      ]}
      />
    </div>
  );
}

// ------------------------------------------------------------- shared data

/** Picker option for an item row; without its own rate, the item's tax category's, then the default's. */
function itemOption(
  row: ItemRow,
  taxRateById: ReadonlyMap<string, string>,
  defaultTaxId?: string,
): InvoiceItemOption {
  return {
    id: row.id,
    label: codeAndName(row),
    price: row.salePrice ?? null,
    taxRate:
      row.taxRate ??
      taxRateById.get(row.taxCategoryId ?? '') ??
      taxRateById.get(defaultTaxId ?? '') ??
      '0',
    itemKind: row.itemKind,
  };
}

/** Small reference lists only; customers and items are searched on the server (ADR-022 §8). */
function useSalesLookups() {
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) =>
      warehousesControllerList({ signal }).then((r) => r.data),
  });
  const taxes = useQuery({
    queryKey: ['tax-categories'],
    queryFn: ({ signal }) =>
      settingsControllerListTaxCategories({ signal }).then((r) => r.data),
  });
  const accounts = useAccounts(selectCashBank);

  const taxRateById = useMemo(() => {
    const m = new Map<string, string>();
    for (const tc of taxes.data ?? []) m.set(tc.id, tc.rate);
    return m;
  }, [taxes.data]);
  const defaultTaxId = useMemo(
    () => (taxes.data ?? []).find((x) => x.isDefault)?.id,
    [taxes.data],
  );

  const cashAccountOptions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) })),
    [accounts.data],
  );

  return {
    warehouses: warehouses.data ?? [],
    taxRateById,
    defaultTaxId,
    cashAccountOptions,
    accountsQuery: accounts,
  };
}

/** The sales order an invoice was made from (shared with the order screen's cache). */
function useSalesOrder(orderId: string | null | undefined) {
  return useQuery({
    queryKey: salesCycleKeys.order(orderId ?? undefined),
    queryFn: ({ signal }) => salesCycleControllerGetOrder(orderId!, { signal }).then((r) => r.data),
    enabled: !!orderId,
  });
}

// ------------------------------------------------------------- invoices tab

function InvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [statusFilter, setStatusFilter] = useState<SalesControllerListInvoicesStatus | undefined>(
    () => (params.get('status') === 'DRAFT' ? 'DRAFT' : undefined),
  );
  // A sales order opens its new draft invoice here with ?invoiceId=...; it opens in the view.
  const linkedInvoiceId = params.get('invoiceId');
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>(linkedInvoiceId ? 'view' : 'list');
  const [invoiceId, setInvoiceId] = useState<string | null>(linkedInvoiceId);
  useEffect(() => {
    if (!linkedInvoiceId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('invoiceId');
        return next;
      },
      { replace: true },
    );
  }, [linkedInvoiceId, setParams]);
  const { can, me, companyId } = useAuth();
  const lockHeaders = documentLockHeaders();
  const company = useCompany();
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useSalesLookups();
  useNewFromUrl(() => {
    setInvoiceId(null);
    setScreen('form');
  });

  const [paymentFilter, setPaymentFilter] = useState<SalesControllerListInvoicesPaymentType | undefined>(undefined);
  // Server-paged (ADR-022): search, filters, sort and page go to the API.
  const list = usePagedQuery<
    SalesInvoiceListItemDto,
    { status?: SalesControllerListInvoicesStatus; paymentType?: SalesControllerListInvoicesPaymentType },
    SalesControllerListInvoicesSort
  >({
    key: ['sales-invoices', 'list'],
    filters: { status: statusFilter, paymentType: paymentFilter },
    defaultSort: '-invoiceDate',
    fetch: (params, signal) => salesControllerListInvoices(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
    refetchInterval: LIVE_REFRESH_MS,
  });
  const invoicesQuery = list.query;
  const { isLoading } = invoicesQuery;

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: ({ signal }) =>
      salesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
    enabled: (screen === 'view' || screen === 'form') && !!invoiceId,
    // Just posted: follow the e-invoice until JoFotara answers, so the QR shows up.
    refetchInterval: (query) =>
      screen !== 'view'
        ? false
        : isInFlight(query.state.data?.einvoice?.status)
          ? 4000
          : LIVE_REFRESH_MS,
  });
  const lockStatus = useDocumentLockStatus('SALES_INVOICE', invoiceId, screen === 'view');
  const lockedByOther = !!lockStatus.data?.holder && !lockStatus.data.holder.mine;
  const lockActionTooltip = lockedByOther ? t('common.documentLockActionDisabled') : undefined;
  useEffect(() => {
    if (screen !== 'view' || !invoiceId || detailLoading || !detail || detail.status === 'DRAFT') return;
    const key = entryDraftStorageKey({
      userId: me?.user.id,
      tenantId: me?.currentTenant?.tenantId,
      companyId,
      screenKey: `sales-invoice:${invoiceId}`,
    });
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }, [companyId, detail, detailLoading, invoiceId, me?.currentTenant?.tenantId, me?.user.id, screen]);

  // A posted invoice moves its order's invoiced quantities and the reservations too.
  const invalidate = () => {
    invalidateStockDocument(queryClient, 'salesInvoice');
    void invalidateSalesCycle(queryClient);
  };
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, {
            userName: String(err.details?.userName ?? ''),
            defaultValue: err.message,
          })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) =>
      salesControllerPostInvoice(id, { headers: { ...idemHeaders(), ...lockHeaders } }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => salesControllerDeleteInvoice(id, { headers: lockHeaders }),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      setScreen('list');
      invalidate();
    },
    onError,
  });

  // Approves a draft priced below its order (ADR-027 §4): sales.approve, never by its author.
  const approvePrice = useMutation({
    mutationFn: (id: string) =>
      salesCycleControllerApproveInvoicePrice(id, { headers: { ...idemHeaders(), ...lockHeaders } }),
    onSuccess: () => {
      apiMessage.success(t('salesCycle.priceApproved'));
      void invalidateSalesCycle(queryClient);
    },
    onError,
  });

  const columns = [
    {
      title: t('sales.invoiceNo'),
      dataIndex: 'invoiceNo',
      key: 'invoiceNo',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesInvoiceListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'invoiceDate',
      key: 'invoiceDate',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesInvoiceListItemDto) => displayName(r.customer) ?? '—',
    },
    {
      title: t('sales.paymentType'),
      dataIndex: 'paymentType',
      width: 110,
      render: (v: string) => (
        <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`sales.${v}`)}</Tag>
      ),
    },
    {
      title: t('sales.grandTotal'),
      dataIndex: 'grandTotal',
      key: 'grandTotal',
      sorter: true,
      sortOrder: list.sortOrderOf('grandTotal'),
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('sales.paid'),
      dataIndex: 'paidAmount',
      width: 110,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'POSTED' ? 'green' : 'default'}>{t(`common.${v === 'POSTED' ? 'posted' : 'draft'}`)}</Tag>
      ),
    },
  ];

  if (screen === 'form') {
    return (
      <InvoiceForm
        lookups={lookups}
        invoice={invoiceId ? detail : undefined}
        loading={detailLoading}
        isNew={!invoiceId}
        onLockBlocked={() => setScreen('view')}
        onBack={() => {
          setScreen('list');
          setInvoiceId(null);
        }}
        onSaved={(id) => {
          invalidate();
          setInvoiceId(id);
          setScreen('view');
        }}
      />
    );
  }

  if (screen === 'view' && invoiceId) {
    return (
      <div>
        <DocumentLockBanner docType="SALES_INVOICE" id={invoiceId} query={lockStatus} />
        <InvoiceView
          invoice={detail}
          loading={detailLoading}
          lockedByOther={lockedByOther}
          lockActionTooltip={lockActionTooltip}
          onBack={() => {
            setScreen('list');
            setInvoiceId(null);
          }}
          onEdit={() => setScreen('form')}
          onPost={(id) => post.mutate(id)}
          onDelete={(id) => del.mutate(id)}
          posting={post.isPending}
          onApprovePrice={(id) => approvePrice.mutate(id)}
          approvingPrice={approvePrice.isPending}
          canApprovePrice={can(PERMISSIONS.SALES_APPROVE)}
          userId={me?.user.id}
          salesPriceLocked={company.data?.salesPriceLocked === true}
          salesOrderRequired={company.data?.salesOrderRequired === true}
        />
      </div>
    );
  }

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('sales.searchPlaceholder')}
        filters={
          <>
            <Select
              allowClear
              placeholder={t('common.status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: 'DRAFT', label: t('common.draft') },
                { value: 'POSTED', label: t('common.posted') },
              ]}
            />
            <Select
              allowClear
              placeholder={t('sales.paymentType')}
              value={paymentFilter}
              onChange={setPaymentFilter}
              options={[
                { value: 'CREDIT', label: t('sales.CREDIT') },
                { value: 'CASH', label: t('sales.CASH') },
              ]}
            />
          </>
        }
        count={list.total}
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              setInvoiceId(null);
              setScreen('form');
            }}
          >
            {t('sales.newInvoice')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(invoicesQuery)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
        onRow={(r) => ({ onClick: () => { setInvoiceId(r.id); setScreen('view'); }, style: { cursor: 'pointer' } })}
      />
    </div>
  );
}

// --------------------------------------------------------- invoice form

function InvoiceForm({
  lookups,
  invoice,
  loading,
  isNew,
  onBack,
  onSaved,
  onLockBlocked,
}: {
  lookups: ReturnType<typeof useSalesLookups>;
  invoice?: SalesInvoiceDetailDto;
  loading: boolean;
  isNew: boolean;
  onBack: () => void;
  onSaved: (id: string) => void;
  onLockBlocked?: () => void;
}) {
  const { t } = useTranslation();
  const { can, me, companyId } = useAuth();
  const editLock = useDocumentLock('SALES_INVOICE', isNew ? null : invoice?.id, !isNew && !loading && invoice?.status === 'DRAFT');
  useEffect(() => {
    if (editLock.state.status === 'locked' && invoice?.id) {
      onLockBlocked?.();
    }
  }, [editLock.state, invoice?.id, onLockBlocked]);
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [quickCreate, setQuickCreate] = useState<
    | { kind: 'party'; typedText: string }
    | { kind: 'item'; lineKey: number; row: number; typedText: string }
    | null
  >(null);
  const [createdCustomer, setCreatedCustomer] = useState<{ value: string; label: string }>();
  const [restoredCashAccount, setRestoredCashAccount] = useState<{ value: string; label: string }>();
  // An invoice made from a sales order (ADR-027 §4) keeps its customer, warehouse and items; only lowering is allowed.
  const orderLinked = !!invoice?.salesOrderId;
  const linkedOrder = useSalesOrder(invoice?.salesOrderId);
  const savedQtyByKey = new Map((invoice?.lines ?? []).map((l, i) => [i + 1, l.qtyBase]));
  // Keyboard entry starts at the first field the user must fill.
  useEffect(() => {
    if (loading) return;
    const id = requestAnimationFrame(() => focusNamedField('customer'));
    return () => cancelAnimationFrame(id);
  }, [loading]);
  const [invoiceDate, setInvoiceDate] = useState<Dayjs>(
    invoice ? dayjs(invoice.invoiceDate) : dayjs(),
  );
  const [dueDate, setDueDate] = useState<Dayjs | null>(
    invoice?.dueDate ? dayjs(invoice.dueDate) : null,
  );
  const [customerId, setCustomerId] = useState<string | undefined>(invoice?.customerId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(invoice?.warehouseId);
  const formDefaults = salesInvoiceFormDefaults(invoice);
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>(formDefaults.paymentType);
  const [cashAccountId, setCashAccountId] = useState<string | undefined>(formDefaults.cashAccountId);
  const costCenters = useCostCenters();
  const [costCenterId, setCostCenterId] = useState<string | undefined>(formDefaults.costCenterId);
  const [invoiceDiscountType, setInvoiceDiscountType] = useState<'PERCENT' | 'AMOUNT'>(formDefaults.invoiceDiscountType);
  const [invoiceDiscountValue, setInvoiceDiscountValue] = useState<string | undefined>(formDefaults.invoiceDiscountValue);
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => {
    if (invoice?.lines.length) {
      return invoice.lines.map((l, i) => ({
        key: i + 1,
        itemId: l.itemId,
        qty: l.qtyBase,
        price: l.unitPrice,
        discountPct: l.discountPct,
      }));
    }
    return [emptyInvoiceLine(1), emptyInvoiceLine(2)];
  });

  const warehouseOptions = lookups.warehouses.map((w) => ({
    value: w.id,
    label: codeAndName(w),
  }));
  const cashAccountOptions = [...lookups.cashAccountOptions];
  if (
    restoredCashAccount &&
    !cashAccountOptions.some((option) => option.value === restoredCashAccount.value)
  ) {
    cashAccountOptions.push(restoredCashAccount);
  }

  // Items are searched on the server; the lines' own items stay labelled and priced.
  const items = useRemoteOptions<ItemRow>({
    key: ['items', 'pick', { isActive: 'true' }],
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}), isActive: 'true' },
        { signal },
      ).then((r) => r.data.items),
  });
  const { remember: rememberItems } = items;
  useEffect(() => {
    if (!invoice) return;
    rememberItems(
      invoice.lines.flatMap((l): ItemRow[] =>
        l.item
          ? [
              {
                id: l.itemId,
                code: l.item.code,
                nameAr: l.item.nameAr,
                nameEn: null,
                itemKind: l.item.itemKind,
                salePrice: l.unitPrice,
                taxCategoryId: null,
                taxRate: l.taxRate,
              },
            ]
          : [],
      ),
    );
  }, [invoice, rememberItems]);
  const itemOptions = items
    .withSelected(lines.map((l) => l.itemId))
    .map((row) => itemOption(row, lookups.taxRateById, lookups.defaultTaxId));
  const selectedItems = items.withSelected(lines.map((line) => line.itemId)).filter((row) =>
    lines.some((line) => line.itemId === row.id),
  );
  const customerOption =
    createdCustomer ??
    (invoice?.customer ? { value: invoice.customer.id, label: codeAndName(invoice.customer) } : null);
  const draftValue: SalesInvoiceDraft = {
    invoiceDate: invoiceDate.format('YYYY-MM-DD'),
    dueDate: dueDate?.format('YYYY-MM-DD') ?? null,
    customerId: customerId ?? null,
    customerOption: customerOption ?? null,
    warehouseId: warehouseId ?? null,
    paymentType,
    cashAccountId: cashAccountId ?? null,
    cashAccountLabel:
      cashAccountOptions.find((option) => option.value === cashAccountId)?.label ?? null,
    costCenterId: costCenterId ?? null,
    invoiceDiscountType,
    invoiceDiscountValue: invoiceDiscountValue ?? null,
    lines,
    selectedItems,
  };
  const initialDraft = useRef<SalesInvoiceDraft | null>(null);
  initialDraft.current ??= draftValue;
  const initialBusinessValue = {
    invoiceDate: initialDraft.current.invoiceDate,
    dueDate: initialDraft.current.dueDate,
    customerId: initialDraft.current.customerId,
    warehouseId: initialDraft.current.warehouseId,
    paymentType: initialDraft.current.paymentType,
    cashAccountId: initialDraft.current.cashAccountId,
    costCenterId: initialDraft.current.costCenterId,
    invoiceDiscountType: initialDraft.current.invoiceDiscountType,
    invoiceDiscountValue: initialDraft.current.invoiceDiscountValue,
    lines: initialDraft.current.lines,
  };
  const { clear: clearEntryDraft, confirmLeave } = useEntryDraft({
    scope: {
      userId: me?.user.id,
      tenantId: me?.currentTenant?.tenantId,
      companyId,
      screenKey: `sales-invoice:${isNew ? 'new' : invoice?.id ?? 'pending'}`,
    },
    value: draftValue,
    initialValue: initialDraft.current,
    dirtyValue: {
      invoiceDate: draftValue.invoiceDate,
      dueDate: draftValue.dueDate,
      customerId: draftValue.customerId,
      warehouseId: draftValue.warehouseId,
      paymentType: draftValue.paymentType,
      cashAccountId: draftValue.cashAccountId,
      costCenterId: draftValue.costCenterId,
      invoiceDiscountType: draftValue.invoiceDiscountType,
      invoiceDiscountValue: draftValue.invoiceDiscountValue,
      lines: draftValue.lines,
    },
    initialDirtyValue: initialBusinessValue,
    enabled: !loading && (isNew || invoice?.status === 'DRAFT'),
    discardWhenDisabled: !loading && !isNew && !!invoice && invoice.status !== 'DRAFT',
    onRestore: (draft) => {
      setInvoiceDate(dayjs(draft.invoiceDate));
      setDueDate(draft.dueDate ? dayjs(draft.dueDate) : null);
      setCustomerId(draft.customerId ?? undefined);
      setCreatedCustomer(draft.customerOption ?? undefined);
      setWarehouseId(draft.warehouseId ?? undefined);
      setPaymentType(draft.paymentType);
      setCashAccountId(draft.cashAccountId ?? undefined);
      setRestoredCashAccount(
        draft.cashAccountId && draft.cashAccountLabel
          ? { value: draft.cashAccountId, label: draft.cashAccountLabel }
          : undefined,
      );
      setCostCenterId(draft.costCenterId ?? undefined);
      setInvoiceDiscountType(draft.invoiceDiscountType);
      setInvoiceDiscountValue(draft.invoiceDiscountValue ?? undefined);
      setLines(draft.lines);
      items.remember(draft.selectedItems);
    },
  });

  const previewLineKeys = lines.flatMap((line) => line.itemId && line.qty && line.price?.trim() ? [line.key] : []);
  const hasUnpricedLine = lines.some((line) => line.itemId && line.qty && !line.price?.trim());
  const previewPayload = useMemo(() => {
    if (previewLineKeys.length === 0 || hasUnpricedLine) return null;
    return {
      ...(invoice?.id ? { invoiceId: invoice.id } : {}),
      ...(invoiceDiscountValue?.trim()
        ? invoiceDiscountType === 'PERCENT'
          ? { invoiceDiscountPct: invoiceDiscountValue.trim() }
          : { invoiceDiscountAmount: invoiceDiscountValue.trim() }
        : {}),
      lines: lines.flatMap((line) =>
        line.itemId && line.qty
          ? [{
              itemId: line.itemId,
              qty: line.qty,
              unitPrice: line.price ?? '0',
              ...(line.discountPct?.trim() ? { discountPct: line.discountPct.trim() } : {}),
            }]
          : [],
      ),
    };
  }, [invoice?.id, invoiceDiscountType, invoiceDiscountValue, lines, previewLineKeys.length, hasUnpricedLine]);
  const preview = useQuery({
    queryKey: ['sales-invoice-preview', previewPayload],
    queryFn: () => {
      if (!previewPayload) throw new Error('invoice preview is not ready');
      return salesControllerPreviewInvoice(previewPayload).then((response) => response.data);
    },
    enabled: previewPayload !== null,
  });
  const serverAmounts = lines.map((line) => {
    const index = previewLineKeys.indexOf(line.key);
    return index >= 0 ? preview.data?.lines[index] : undefined;
  });
  const serverSummary: SalesInvoicePreviewDto | undefined = preview.data;

  const save = useMutation({
    mutationFn: async () => {
      // trySave checks these before it saves; this narrows them for the request type.
      if (!customerId || !warehouseId) throw new Error('customer and warehouse are required');
      const payload = salesInvoiceBody(
        {
          invoiceDate: invoiceDate.format('YYYY-MM-DD'),
          dueDate: dueDate?.format('YYYY-MM-DD'),
          customerId,
          warehouseId,
          paymentType,
          cashAccountId,
          // A draft keeps its centre while centres are off (ADR-024 §1.6): hidden, still sent.
          costCenterId,
          invoiceDiscountType,
          invoiceDiscountValue,
          lines,
        },
        invoice,
      );
      const res = isNew
        ? await salesControllerCreateInvoice(payload)
        : await salesControllerUpdateInvoice(invoice!.id, payload, { headers: editLock.headers });
      return res;
    },
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      clearEntryDraft();
      onSaved(res.data.id);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, {
              userName: String(err.details?.userName ?? ''),
              defaultValue: err.message,
            })
          : t('errors.INTERNAL'),
      ),
  });

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const missing = {
    customer: !customerId,
    warehouse: !warehouseId,
    cashAccount: paymentType === 'CASH' && !cashAccountId,
    lines: !lines.some((l) => l.itemId && l.qty),
  };
  const trySave = () => {
    if (
      save.isPending ||
      (!isNew && editLock.state.status !== 'held' && editLock.state.status !== 'reconnecting')
    ) return;
    const firstMissing = (['customer', 'warehouse', 'cashAccount'] as const).find((k) => missing[k]);
    if (firstMissing || missing.lines) {
      setTried(true);
      if (firstMissing) focusNamedField(firstMissing);
      else apiMessage.warning(t('stock.minLines'));
      return;
    }
    save.mutate();
  };
  useDocShortcuts({ onSave: trySave });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);

  if (loading || (!isNew && editLock.state.status === 'acquiring')) {
    return <Typography.Text role="status">{loading ? t('common.loading') : t('common.documentLockAcquiring')}</Typography.Text>;
  }
  if (editLock.state.status === 'locked') {
    return <Typography.Text role="status">{t('common.documentLockAcquiring')}</Typography.Text>;
  }

  return (
    <DocLayout
      title={isNew ? t('sales.newInvoice') : t('sales.invoiceTitle')}
      docNo={invoice?.invoiceNo}
      status="DRAFT"
      onBack={() => confirmLeave(onBack)}
      actions={
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={save.isPending}
          disabled={!isNew && editLock.state.status !== 'held' && editLock.state.status !== 'reconnecting'}
          onClick={trySave}
        >
          {isNew ? t('common.saveDraft') : t('common.save')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      {contextHolder}
      {editLock.state.status === 'reconnecting' && (
        <Alert className="doc-section" type="warning" showIcon message={t('common.documentLockReconnecting')} />
      )}
      {editLock.state.status === 'lost' && (
        <Alert className="doc-section" type="error" showIcon message={t('common.documentLockLost')} />
      )}
      {editLock.state.status === 'error' && (
        <Alert className="doc-section" type="error" showIcon message={t('errors.INTERNAL')} />
      )}
      <DocFields>
        {orderLinked && (
          <DocField label={t('salesCycle.orderNoLabel')}>
            <DocValue>
              <Link to={`/sales-orders?orderId=${invoice!.salesOrderId}`}>
                {linkedOrder.data?.orderNo ?? `#${invoice!.salesOrderId}`}
              </Link>
            </DocValue>
          </DocField>
        )}
        <DocField
          field="customer"
          label={t('sales.customer')}
          required
          error={requiredError(missing.customer)}
          onKeyDown={enterTo(() => focusNamedField('warehouse'))}
        >
          {/* Searches customers on the server by code or name (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['parties', 'pick', 'CUSTOMER']}
            fetchOptions={(q, signal) =>
              partiesControllerList(
                { partyType: 'CUSTOMER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
                { signal },
              ).then((r) =>
                r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
              )
            }
            selected={
              createdCustomer ??
              (invoice?.customer
                ? { value: invoice.customer.id, label: codeAndName(invoice.customer) }
                : undefined)
            }
            status={requiredError(missing.customer) ? 'error' : undefined}
            disabled={orderLinked}
            value={customerId}
            onChange={setCustomerId}
            onCreateNew={
              can(PERMISSIONS.PARTIES_MANAGE)
                ? (typedText) => setQuickCreate({ kind: 'party', typedText })
                : undefined
            }
            createNewLabel={t('parties.new')}
          />
        </DocField>
        <DocField
          field="warehouse"
          label={t('sales.warehouse')}
          required
          error={requiredError(missing.warehouse)}
          onKeyDown={enterTo(() => focusNamedField('invoiceDate'))}
        >
          <GridSelect
            status={requiredError(missing.warehouse) ? 'error' : undefined}
            disabled={orderLinked}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </DocField>
        <DocField
          field="invoiceDate"
          label={t('sales.invoiceDate')}
          onKeyDown={enterTo(() => focusNamedField('dueDate'))}
        >
          <DatePicker value={invoiceDate} onChange={(d) => d && setInvoiceDate(d)} />
        </DocField>
        <DocField
          field="dueDate"
          label={t('sales.dueDate')}
          onKeyDown={enterTo(() => focusNamedField(costCenters.enabled ? 'costCenter' : 'paymentType'))}
        >
          <DatePicker value={dueDate} onChange={setDueDate} allowClear />
        </DocField>
        {costCenters.enabled && (
          <DocField
            field="costCenter"
            label={<CostCenterLabel />}
            onKeyDown={enterTo(() => focusNamedField('paymentType'))}
          >
            <CostCenterSelect
              rows={costCenters.rows}
              value={costCenterId}
              onChange={setCostCenterId}
            />
          </DocField>
        )}
        <DocField
          field="paymentType"
          label={t('sales.paymentType')}
          onKeyDown={enterTo(() =>
            paymentType === 'CASH' ? focusNamedField('cashAccount') : focusFirstGridCell(),
          )}
        >
          {/* Arrow keys switch between the two options (native radio group). */}
          <Radio.Group
            name="paymentType"
            optionType="button"
            buttonStyle="solid"
            value={paymentType}
            onChange={(e) => setPaymentType(e.target.value)}
            options={[
              { value: 'CREDIT', label: t('sales.CREDIT') },
              { value: 'CASH', label: t('sales.CASH') },
            ]}
          />
        </DocField>
        {paymentType === 'CASH' && (
          <DocField
            field="cashAccount"
            label={t('sales.cashAccount')}
            required
            error={requiredError(missing.cashAccount)}
            onKeyDown={enterTo(focusFirstGridCell)}
          >
            <GridSelect
              status={requiredError(missing.cashAccount) ? 'error' : undefined}
              options={cashAccountOptions}
              onOpen={() => refetchIfOlderThan(lookups.accountsQuery, PICKER_FRESH_MS)}
              value={cashAccountId}
              onChange={setCashAccountId}
            />
          </DocField>
        )}
      </DocFields>

      <InvoiceLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
        onItemOpen={items.onOpen}
        onCreateItem={
          can(PERMISSIONS.ITEM_MANAGE)
            ? (lineKey, row, typedText) => setQuickCreate({ kind: 'item', lineKey, row, typedText })
            : undefined
        }
        lockedItems={orderLinked}
        maxQtyOf={orderLinked ? (key) => savedQtyByKey.get(key) : undefined}
        serverAmounts={serverAmounts}
        serverSummary={serverSummary}
        serverPreviewRequired
      />
      <PartyFormDialog
        open={quickCreate?.kind === 'party'}
        initialValues={quickCreate?.kind === 'party' ? { nameAr: quickCreate.typedText, partyType: 'CUSTOMER' } : undefined}
        lockPartyType
        onCancel={() => {
          setQuickCreate(null);
          requestAnimationFrame(() => focusNamedField('customer'));
        }}
        onSaved={(created) => {
          setCreatedCustomer({ value: created.id, label: codeAndName(created) });
          setCustomerId(created.id);
          void queryClient.invalidateQueries({ queryKey: ['parties'] });
          setQuickCreate(null);
          requestAnimationFrame(() => focusNamedField('customer'));
        }}
      />
      <ItemFormDialog
        open={quickCreate?.kind === 'item'}
        initialValues={quickCreate?.kind === 'item' ? { nameAr: quickCreate.typedText } : undefined}
        onCancel={() => {
          const row = quickCreate?.kind === 'item' ? quickCreate.row : undefined;
          setQuickCreate(null);
          if (row !== undefined) requestAnimationFrame(() => focusCellEl(document.querySelector<HTMLElement>(`[data-cell="${row}-1"]`)));
        }}
        onSaved={(created) => {
          const row: ItemRow = {
            id: created.id,
            code: created.code,
            nameAr: created.nameAr,
            nameEn: created.nameEn,
            itemKind: created.itemKind,
            salePrice: created.salePrice,
            taxCategoryId: created.taxCategoryId,
          };
          items.remember([row]);
          void queryClient.invalidateQueries({ queryKey: ['items'] });
          const pending = quickCreate;
          setQuickCreate(null);
          if (pending?.kind === 'item') {
            const option = itemOption(row, lookups.taxRateById, lookups.defaultTaxId);
            setLines((current) =>
              current.map((line) =>
                line.key === pending.lineKey
                  ? { ...line, itemId: created.id, ...(line.price == null && option.price != null ? { price: option.price } : {}) }
                  : line,
              ),
            );
            requestAnimationFrame(() => focusCellEl(document.querySelector<HTMLElement>(`[data-cell="${pending.row}-1"]`)));
          }
        }}
      />
      <DocFields>
        <DocField label={t('sales.invoiceDiscount')}>
          <InvoiceDiscountField
            type={invoiceDiscountType}
            value={invoiceDiscountValue}
            onTypeChange={setInvoiceDiscountType}
            onValueChange={setInvoiceDiscountValue}
          />
        </DocField>
      </DocFields>
      {preview.isError && preview.error instanceof ApiError && (
        <Alert
          type="warning"
          showIcon
          message={t(`errors.${preview.error.code}`, { defaultValue: preview.error.message })}
        />
      )}
    </DocLayout>
  );
}

// ----------------------------------------------------------- invoice view

function InvoiceView({
  invoice,
  loading,
  lockedByOther,
  lockActionTooltip,
  onBack,
  onEdit,
  onPost,
  onDelete,
  posting,
  onApprovePrice,
  approvingPrice,
  canApprovePrice,
  userId,
  salesPriceLocked,
  salesOrderRequired,
}: {
  invoice?: SalesInvoiceDetailDto;
  loading: boolean;
  lockedByOther: boolean;
  lockActionTooltip?: string;
  onBack: () => void;
  onEdit: () => void;
  onPost: (id: string) => void;
  onDelete: (id: string) => void;
  posting: boolean;
  onApprovePrice: (id: string) => void;
  approvingPrice: boolean;
  canApprovePrice: boolean;
  userId?: string;
  salesPriceLocked: boolean;
  salesOrderRequired: boolean;
}) {
  const { t } = useTranslation();
  const [, contextHolder] = message.useMessage();
  const { modal } = App.useApp();
  const costCenters = useCostCenters();
  const isDraft = invoice?.status === 'DRAFT';
  const linkedOrder = useSalesOrder(invoice?.salesOrderId);
  // A draft priced below its order needs a price approval before posting, when the company locks prices (ADR-027 §4).
  const belowOrder =
    salesPriceLocked && invoice?.salesOrderId && !invoice.priceApprovedAt && linkedOrder.data
      ? linesBelowOrder(
          invoice.lines.map((l) => ({
            orderLineId: l.orderLineId,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            qty: l.qty,
            invoiceDiscountShare: l.invoiceDiscountShare,
          })),
          linkedOrder.data.lines,
        ).size > 0
      : false;
  const priceNeedsApproval = isDraft && belowOrder;
  const canApproveHere = canApprovePrice && !!invoice && !isAuthoredBy(invoice, userId);
  // Ctrl+Enter posts a draft, behind the same confirmation as the button.
  const confirmPost = () => {
    if (!invoice || !isDraft || posting || lockedByOther) return;
    modal.confirm({ title: t('sales.postConfirm'), onOk: () => onPost(invoice.id) });
  };
  useDocShortcuts({ onPost: confirmPost });
  if (loading || !invoice) {
    return <Typography.Text>{t('common.loading')}</Typography.Text>;
  }
  const remaining = dec(invoice.grandTotal).minus(dec(invoice.paidAmount));
  return (
    <DocLayout
      title={t('sales.invoiceTitle')}
      docNo={invoice.invoiceNo ?? `#${invoice.id}`}
      status={invoice.status}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          {isDraft && (
            <>
              <Tooltip title={lockActionTooltip}>
                <span>
                  <Button onClick={onEdit} disabled={lockedByOther}>{t('common.edit')}</Button>
                </span>
              </Tooltip>
              <Tooltip title={lockActionTooltip}>
                <span>
                  <Popconfirm
                    disabled={lockedByOther}
                    title={t('sales.postConfirm')}
                    onConfirm={() => onPost(invoice.id)}
                  >
                    <Button type="primary" loading={posting} disabled={lockedByOther}>
                      {t('common.post')}
                      <span className="doc-kbd">Ctrl+Enter</span>
                    </Button>
                  </Popconfirm>
                </span>
              </Tooltip>
              <Tooltip title={lockActionTooltip}>
                <span>
                  <Popconfirm
                    disabled={lockedByOther}
                    title={t('common.deleteConfirm')}
                    onConfirm={() => onDelete(invoice.id)}
                  >
                    <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={lockedByOther} />
                  </Popconfirm>
                </span>
              </Tooltip>
            </>
          )}
          {priceNeedsApproval && canApproveHere && (
            <Tooltip title={lockActionTooltip}>
              <span>
                <Button onClick={() => onApprovePrice(invoice.id)} loading={approvingPrice} disabled={posting || lockedByOther}>
                  {t('salesCycle.approvePrice')}
                </Button>
              </span>
            </Tooltip>
          )}
          <PrintPdfButton path={`/sales-invoices/${invoice.id}/pdf`} />
        </>
      }
    >
      <EInvoiceNotice einvoice={invoice.einvoice} />
      {priceNeedsApproval && (
        <Alert
          type="warning"
          showIcon
          message={canApproveHere ? t('salesCycle.priceNeedsApproval') : t('salesCycle.priceNeedsApprovalOther')}
        />
      )}
      {isDraft && salesOrderRequired && !invoice.salesOrderId && (
        <Alert type="warning" showIcon message={t('salesCycle.directInvoiceBlocked')} />
      )}
      <DocFields>
        {invoice.salesOrderId && (
          <DocField label={t('salesCycle.orderNoLabel')}>
            <DocValue>
              <Link to={`/sales-orders?orderId=${invoice.salesOrderId}`}>
                {linkedOrder.data?.orderNo ?? `#${invoice.salesOrderId}`}
              </Link>
            </DocValue>
          </DocField>
        )}
        <DocField label={t('sales.customer')}>
          <DocValue>{displayName(invoice.customer)}</DocValue>
        </DocField>
        <DocField label={t('sales.paymentType')}>
          <DocValue>
            <Tag color={invoice.paymentType === 'CASH' ? 'green' : 'blue'}>
              {t(`sales.${invoice.paymentType}`)}
            </Tag>
          </DocValue>
        </DocField>
        <DocField label={t('sales.invoiceDate')}>
          <DocValue>{dayjs(invoice.invoiceDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('sales.dueDate')}>
          <DocValue>{invoice.dueDate ? dayjs(invoice.dueDate).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        {costCenters.enabled && invoice.costCenterId && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{costCenters.nameOf(invoice.costCenterId)}</DocValue>
          </DocField>
        )}
        <DocField label={t('sales.net')}>
          <DocValue>{amountCell(invoice.netTotal)}</DocValue>
        </DocField>
        {dec(invoice.invoiceDiscountAmount).gt(0) && (
          <DocField label={t('sales.invoiceDiscount')}>
            <DocValue>{amountCell(invoice.invoiceDiscountAmount)}</DocValue>
          </DocField>
        )}
        <DocField label={t('sales.tax')}>
          <DocValue>{amountCell(invoice.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('sales.grandTotal')}>
          <DocValue>{amountCell(invoice.grandTotal)}</DocValue>
        </DocField>
        <DocField label={`${t('sales.paid')} / ${t('sales.remaining')}`}>
          <DocValue>
            {amountCell(invoice.paidAmount)}
            <span style={{ margin: '0 6px' }}>/</span>
            <Typography.Text type={remaining.gt(0) && !isDraft ? 'danger' : undefined}>
              {amountCell(remaining)}
            </Typography.Text>
          </DocValue>
        </DocField>
        {dec(invoice.costTotal).gt(0) && (
          <DocField label={t('sales.costTotal')}>
            <DocValue>{amountCell(invoice.costTotal)}</DocValue>
          </DocField>
        )}
        {invoice.einvoice && (
          <DocField label={t('einvoice.field')}>
            <DocValue>
              <EInvoiceStatusTag status={invoice.einvoice.status} />
            </DocValue>
          </DocField>
        )}
      </DocFields>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        scroll={{ x: 'max-content' }}
        dataSource={invoice.lines ?? []}
        // A posted recipe line opens onto the components it took (ADR-032 §12).
        expandable={
          isDraft
            ? undefined
            : {
                rowExpandable: (l: InvoiceLine) => l.components.length > 0,
                expandedRowRender: (l: InvoiceLine) => <PostedRecipeComponents components={l.components} />,
              }
        }
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          {
            title: t('items.title'),
            render: (_: unknown, l: InvoiceLine) => (
              <Space wrap size={6}>
                {l.item ? codeAndName(l.item) : l.itemId}
                {l.recipeBomMissing && <StatusTag tone="warning">{t('sales.recipe.bomMissing')}</StatusTag>}
              </Space>
            ),
          },
          { title: t('stock.qty'), dataIndex: 'qtyBase', width: 90, align: 'right' as const, render: qtyCell },
          { title: t('sales.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('sales.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('sales.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('sales.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('sales.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
          // The cost of a posted line (ADR-032 §12): a draft has none yet.
          ...(isDraft
            ? []
            : [
                { title: t('sales.recipe.unitCost'), dataIndex: 'unitCost', width: 110, align: 'right' as const, render: unitCostCell },
                { title: t('sales.recipe.lineCost'), dataIndex: 'costTotal', width: 110, align: 'right' as const, render: amountCell },
              ]),
        ]}
      />
      {isDraft && <RecipeIngredientsPanel invoiceId={invoice.id} />}
      <EInvoiceQrPanel einvoice={invoice.einvoice} />
    </DocLayout>
  );
}

// ------------------------------------------------------------- returns tab

function ReturnsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<SalesControllerListReturnsStatus | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const costCenters = useCostCenters();
  const [apiMessage, contextHolder] = message.useMessage();

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    SalesReturnListItemDto,
    { status?: SalesControllerListReturnsStatus },
    SalesControllerListReturnsSort
  >({
    key: ['sales-returns', 'list'],
    filters: { status: statusFilter },
    defaultSort: '-returnDate',
    fetch: (params, signal) => salesControllerListReturns(params, { signal }).then((r) => r.data),
    enabled: !modalOpen && !viewId,
  });

  const { data: view } = useQuery({
    queryKey: ['sales-return', viewId],
    queryFn: ({ signal }) =>
      salesControllerGetReturn(viewId!, { signal }).then((r) => r.data),
    enabled: !!viewId,
    refetchInterval: (query) => (isInFlight(query.state.data?.einvoice?.status) ? 4000 : false),
  });

  const invalidate = () => invalidateStockDocument(queryClient, 'salesReturn');
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) => salesControllerPostReturn(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => salesControllerDeleteReturn(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
    },
    onError,
  });

  const columns = [
    {
      title: t('sales.returnNo'),
      dataIndex: 'returnNo',
      key: 'returnNo',
      sorter: true,
      sortOrder: list.sortOrderOf('returnNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesReturnListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'returnDate',
      key: 'returnDate',
      sorter: true,
      sortOrder: list.sortOrderOf('returnDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.invoice'),
      dataIndex: 'originalInvoice',
      render: (_: unknown, r: SalesReturnListItemDto) => r.originalInvoice?.invoiceNo ?? `#${r.originalInvoiceId}`,
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesReturnListItemDto) => displayName(r.customer) ?? '—',
    },
    {
      title: t('sales.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`sales.${v}`)}</Tag>,
    },
    {
      title: t('sales.grandTotal'),
      dataIndex: 'grandTotal',
      key: 'grandTotal',
      sorter: true,
      sortOrder: list.sortOrderOf('grandTotal'),
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'POSTED' ? 'green' : 'default'}>{v === 'POSTED' ? t('common.posted') : t('common.draft')}</Tag>
      ),
    },
    {
      title: '',
      width: 200,
      render: (_: unknown, r: SalesReturnListItemDto) => (
        <Space>
          <Button size="small" onClick={() => setViewId(r.id)}>{t('common.view')}</Button>
          {r.status === 'DRAFT' && (
            <>
              <Popconfirm title={t('common.confirmPost')} onConfirm={() => post.mutate(r.id)}>
<Button size="small" type="primary" >
                {t('common.post')}
              </Button>
</Popconfirm>
              <Popconfirm title={t('common.confirmDelete')} onConfirm={() => del.mutate(r.id)}>
<Button size="small" danger >
                {t('common.delete')}
              </Button>
</Popconfirm>
            </>
          )}
        </Space>
      ),
    },
  ];

  // A new return and an existing return each open as a full document page.
  if (modalOpen) {
    return (
      <ReturnForm
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
          title={t('sales.returnDetail')}
          docNo={view?.returnNo}
          status={view?.status}
          onBack={() => setViewId(null)}
          actions={<PrintPdfButton path={`/sales-returns/${viewId}/pdf`} />}
        >
          {view ? (
            <>
              <EInvoiceNotice einvoice={view.einvoice} />
              <DocFields>
                <DocField label={t('sales.invoice')}>
                  <DocValue>
                    <span className="doc-no">{view.originalInvoice?.invoiceNo ?? '—'}</span>
                  </DocValue>
                </DocField>
                <DocField label={t('sales.customer')}>
                  <DocValue>{displayName(view.customer)}</DocValue>
                </DocField>
                <DocField label={t('sales.date')}>
                  <DocValue>{dayjs(view.returnDate).format('YYYY-MM-DD')}</DocValue>
                </DocField>
                <DocField label={t('sales.refundType')}>
                  <DocValue>{t(`sales.${view.refundType}`)}</DocValue>
                </DocField>
                {costCenters.enabled && view.costCenterId && (
                  <DocField label={t('costCenters.documentField')}>
                    <DocValue>{costCenters.nameOf(view.costCenterId)}</DocValue>
                  </DocField>
                )}
                <DocField label={t('sales.grandTotal')}>
                  <DocValue>{amountCell(view.grandTotal)}</DocValue>
                </DocField>
                {view.reason && (
                  <DocField label={t('common.reason')}>
                    <DocValue>{view.reason}</DocValue>
                  </DocField>
                )}
                {view.einvoice && (
                  <DocField label={t('einvoice.field')}>
                    <DocValue>
                      <EInvoiceStatusTag status={view.einvoice.status} />
                    </DocValue>
                  </DocField>
                )}
              </DocFields>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={view.lines ?? []}
                columns={[
                  { title: '#', width: 50, render: (_: unknown, l: ReturnLine) => l.originalLine.lineNo },
                  {
                    title: t('items.title'),
                    render: (_: unknown, l: ReturnLine) =>
                      l.item ? codeAndName(l.item) : l.itemId,
                  },
                  { title: t('stock.qty'), dataIndex: 'qtyBase', width: 100, align: 'right' as const, render: qtyCell },
                  { title: t('sales.total'), dataIndex: 'lineTotal', width: 120, align: 'right' as const, render: amountCell },
                ]}
              />
              <EInvoiceQrPanel einvoice={view.einvoice} />
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
        searchPlaceholder={t('sales.searchPlaceholder')}
        filters={
          <Select
            allowClear
            placeholder={t('common.status')}
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'DRAFT', label: t('common.draft') },
              { value: 'POSTED', label: t('common.posted') },
            ]}
          />
        }
        count={list.total}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            {t('sales.newReturn')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={list.query.isLoading}
        dataSource={list.rows}
        locale={tableLocale(list.query)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
      />
    </div>
  );
}

function ReturnForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const [invoiceId, setInvoiceId] = useState<string | undefined>();
  const [returnDate, setReturnDate] = useState<Dayjs>(dayjs());
  const [refundType, setRefundType] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [cashAccountId, setCashAccountId] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});
  const costCenters = useCostCenters();
  const [costCenterId, setCostCenterId] = useState<string | undefined>();
  // Until the user picks or clears a centre, it follows the original invoice's.
  const [costCenterTouched, setCostCenterTouched] = useState(false);

  const lookups = useSalesLookups();
  const { data: invoice } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: ({ signal }) =>
      salesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
    enabled: !!invoiceId,
  });

  useEffect(() => {
    if (costCenterTouched || !invoice || invoice.id !== invoiceId) return;
    setCostCenterId(invoice.costCenterId ?? undefined);
  }, [invoice, invoiceId, costCenterTouched]);
  const pickCostCentre = (id: string | undefined) => {
    setCostCenterTouched(true);
    setCostCenterId(id);
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('return needs an invoice');
      return salesControllerCreateReturn({
        returnDate: returnDate.format('YYYY-MM-DD'),
        originalInvoiceId: invoiceId,
        refundType,
        cashAccountId: refundType === 'CASH' ? cashAccountId : undefined,
        reason: reason || undefined,
        // A new return: a centre only while centres are on (the prefill stays hidden otherwise).
        costCenterId: costCenters.enabled ? costCenterId || undefined : undefined,
        lines: (invoice?.lines ?? [])
          .filter((l) => dec(qtyByLine[l.id]).gt(0))
          .map((l) => ({ originalLineId: l.id, qty: qtyByLine[l.id] })),
      });
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      onCreated();
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const postCreated = useMutation({
    mutationFn: async () => {
      const created = await create.mutateAsync();
      await salesControllerPostReturn(created.data.id, { headers: idemHeaders() });
    },
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      onCreated();
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const hasLines = Object.values(qtyByLine).some((q) => dec(q).gt(0));
  // Save stays enabled: a save attempt with gaps marks what's missing instead.
  const [tried, setTried] = useState(false);
  const busy = create.isPending || postCreated.isPending;
  const trySave = (andPost: boolean) => {
    if (busy) return;
    if (!invoiceId || !hasLines) {
      setTried(true);
      if (invoiceId) apiMessage.warning(t('stock.minLines'));
      return;
    }
    if (andPost) postCreated.mutate();
    else create.mutate();
  };
  useDocShortcuts({ onSave: () => trySave(false) });
  const invoiceError = tried && !invoiceId ? t('common.requiredField') : undefined;

  return (
    <DocLayout
      title={t('sales.newReturn')}
      status="DRAFT"
      onBack={onClose}
      actions={
        <>
          <Button loading={create.isPending} onClick={() => trySave(false)}>
            {t('common.saveDraft')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          <Button type="primary" loading={postCreated.isPending} onClick={() => trySave(true)}>
            {t('sales.createAndPost')}
          </Button>
        </>
      }
    >
      {contextHolder}
      <DocFields>
        <DocField label={t('sales.invoice')} required error={invoiceError}>
          {/* Searches posted invoices on the server by number or customer (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['sales-invoices', 'pick-posted']}
            placeholder={t('sales.searchPlaceholder')}
            fetchOptions={(q, signal) =>
              salesControllerListInvoices({ status: 'POSTED', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
                (r) =>
                  r.data.items.map((i) => ({
                    value: i.id,
                    label: `${i.invoiceNo ?? `#${i.id}`} — ${displayName(i.customer) ?? ''} — ${money(i.grandTotal)}`,
                  })),
              )
            }
            status={invoiceError ? 'error' : undefined}
            value={invoiceId}
            onChange={(v) => {
              setInvoiceId(v);
              setQtyByLine({});
            }}
          />
        </DocField>
        <DocField label={t('sales.date')}>
          <DatePicker value={returnDate} onChange={(d) => d && setReturnDate(d)} />
        </DocField>
        {costCenters.enabled && (
          <DocField label={<CostCenterLabel />}>
            <CostCenterSelect
              rows={costCenters.rows}
              value={costCenterId}
              onChange={pickCostCentre}
            />
          </DocField>
        )}
        <DocField label={t('sales.refundType')}>
          <Radio.Group
            name="refundType"
            optionType="button"
            buttonStyle="solid"
            value={refundType}
            onChange={(e) => setRefundType(e.target.value)}
            options={[
              { value: 'CREDIT', label: t('sales.CREDIT') },
              { value: 'CASH', label: t('sales.CASH') },
            ]}
          />
        </DocField>
        {refundType === 'CASH' && (
          <DocField label={t('sales.cashAccount')}>
            <Select
              showSearch
              optionFilterProp="label"
              options={lookups.cashAccountOptions}
              value={cashAccountId}
              onChange={setCashAccountId}
            />
          </DocField>
        )}
        <DocField label={t('common.reason')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>

      {invoice?.lines && invoice.lines.length > 0 && (
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={invoice.lines}
          columns={[
            { title: '#', dataIndex: 'lineNo', width: 50 },
            {
              title: t('items.title'),
              render: (_: unknown, l: InvoiceLine) =>
                l.item ? codeAndName(l.item) : l.itemId,
            },
            {
              title: t('stock.qty'),
              dataIndex: 'qtyBase',
              width: 100,
              align: 'right' as const,
              render: qtyCell,
            },
            {
              title: t('sales.returnQty'),
              width: 130,
              render: (_: unknown, l: InvoiceLine) => (
                <InputNumber<string>
                  stringMode
                  min="0"
                  max={l.qtyBase}
                  value={qtyByLine[l.id] ?? '0'}
                  onChange={(v) => setQtyByLine((m) => ({ ...m, [l.id]: v ?? '0' }))}
                  style={{ width: '100%' }}
                  size="small"
                />
              ),
            },
            {
              title: t('sales.total'),
              dataIndex: 'lineTotal',
              width: 110,
              align: 'right' as const,
              render: amountCell,
            },
          ]}
        />
      )}
    </DocLayout>
  );
}
