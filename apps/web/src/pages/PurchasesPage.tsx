import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, PrinterOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Radio,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import { PartyFormDialog } from '../components/PartyFormDialog';
import { ItemFormDialog } from '../components/ItemFormDialog';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { formatDateTime } from '../format/date';
import { useEffect, useMemo, useRef, useState } from 'react';
import { selectCashBank, useAccounts } from '../hooks/useAccounts';
import { useTranslation } from 'react-i18next';
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
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { entryDraftStorageKey, useEntryDraft } from '../hooks/useEntryDraft';
import { documentLockHeaders, useDocumentLock } from '../hooks/useDocumentLock';
import { useCostCenters } from '../hooks/useCostCenters';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { PrintPdfButton } from '../components/PrintPdfButton';
import {
  ApiError,
  catalogControllerListItems,
  warehousesControllerList,
  partiesControllerList,
  purchasesControllerApprovePrice,
  purchasesControllerCreateInvoice,
  purchasesControllerCreateReturn,
  purchasesControllerDeleteInvoice,
  purchasesControllerDeleteReturn,
  purchasesControllerGetInvoice,
  purchasesControllerGetReturn,
  purchasesControllerListInvoices,
  purchasesControllerListReturns,
  purchasesControllerPostInvoice,
  purchasesControllerPostReturn,
  purchasesControllerUpdateInvoice,
  settingsControllerListTaxCategories,
  type ItemListItemDto,
  type PurchaseInvoiceDetailDto,
  type PurchaseInvoiceLineViewDto,
  type PurchaseInvoiceListItemDto,
  type PurchaseReturnLineViewDto,
  type PurchaseReturnListItemDto,
  type PurchasesControllerListInvoicesPaymentType,
  type PurchasesControllerListInvoicesSort,
  type PurchasesControllerListInvoicesStatus,
  type PurchasesControllerListReturnsSort,
  type PurchasesControllerListReturnsStatus,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { StatusTag } from '../components/StatusTag';
import { approvalBlockedAsOwnDocument } from './procurement/requestPayload';
import { invalidateProcurement } from './procurement/queryKeys';
import { useNewFromUrl } from '../useNewFromUrl';
import { purchaseInvoiceBody, purchaseInvoiceFormDefaults } from './purchases/invoicePayload';
import { purchaseReturnBody } from './purchases/returnPayload';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import { invalidateStockDocument } from '../stockQueries';

// ------------------------------------------------------------------ types

/** Lines as the detail endpoints return them. */
type InvoiceLine = PurchaseInvoiceLineViewDto;
type ReturnLine = PurchaseReturnLineViewDto;

/**
 * An item as the item picker holds it: a search result, or a line taken from a saved
 * invoice (which carries its own tax rate; the search response does not).
 */
type ItemRow = Pick<
  ItemListItemDto,
  'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'purchasePrice' | 'taxCategoryId'
> & { taxRate?: string };

type LockedInvoiceNotice = {
  userName: string;
  acquiredAt: string;
  forceRelease: () => Promise<unknown>;
};

interface PurchaseInvoiceDraft {
  invoiceDate: string;
  dueDate: string | null;
  supplierId: string | null;
  supplierOption: { value: string; label: string } | null;
  supplierInvoiceNo: string | null;
  supplierInvoiceDate: string | null;
  warehouseId: string | null;
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId: string | null;
  cashAccountLabel: string | null;
  costCenterId: string | null;
  lines: InvoiceLineDraft[];
  selectedItems: ItemRow[];
}

const money = (v?: string | null) => formatAmount(v);

// ------------------------------------------------------------------ page

export function PurchasesPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState('invoices');
  return (
    <div>
      <PageHeader title={t('nav.purchases')} />
      <Tabs
      activeKey={tab}
      onChange={setTab}
      items={[
        { key: 'invoices', label: t('purchases.invoices'), children: <PurchaseInvoicesTab /> },
        { key: 'returns', label: t('purchases.returns'), children: <PurchaseReturnsTab /> },
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
    price: row.purchasePrice ?? null,
    taxRate:
      row.taxRate ??
      taxRateById.get(row.taxCategoryId ?? '') ??
      taxRateById.get(defaultTaxId ?? '') ??
      '0',
    itemKind: row.itemKind,
  };
}

/** Small reference lists only; suppliers and items are searched on the server (ADR-022 §8). */
function usePurchaseLookups() {
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
  };
}

// ------------------------------------------------------------- invoices tab

function PurchaseInvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<PurchasesControllerListInvoicesStatus | undefined>(undefined);
  const [paymentFilter, setPaymentFilter] = useState<PurchasesControllerListInvoicesPaymentType | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>('list');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [lockedNotice, setLockedNotice] = useState<LockedInvoiceNotice | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = usePurchaseLookups();
  useNewFromUrl(() => {
    setInvoiceId(null);
    setScreen('form');
  });

  // Server-paged (ADR-022): search, filters, sort and page go to the API.
  const list = usePagedQuery<
    PurchaseInvoiceListItemDto,
    { status?: PurchasesControllerListInvoicesStatus; paymentType?: PurchasesControllerListInvoicesPaymentType },
    PurchasesControllerListInvoicesSort
  >({
    key: ['purchase-invoices', 'list'],
    filters: { status: statusFilter, paymentType: paymentFilter },
    defaultSort: '-invoiceDate',
    fetch: (params, signal) => purchasesControllerListInvoices(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['purchase-invoice', invoiceId],
    queryFn: ({ signal }) =>
      purchasesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
    enabled: (screen === 'view' || screen === 'form') && !!invoiceId,
  });
  const { me: currentUser, companyId, can } = useAuth();
  const lockHeaders = documentLockHeaders();
  useEffect(() => {
    if (screen !== 'view' || !invoiceId || detailLoading || !detail || detail.status === 'DRAFT') return;
    const key = entryDraftStorageKey({
      userId: currentUser?.user.id,
      tenantId: currentUser?.currentTenant?.tenantId,
      companyId,
      screenKey: `purchase-invoice:${invoiceId}`,
    });
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }, [companyId, currentUser?.currentTenant?.tenantId, currentUser?.user.id, detail, detailLoading, invoiceId, screen]);

  const invalidate = () => invalidateStockDocument(queryClient, 'purchaseInvoice');
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
      purchasesControllerPostInvoice(id, { headers: { ...idemHeaders(), ...lockHeaders } }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => purchasesControllerDeleteInvoice(id, { headers: lockHeaders }),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      setScreen('list');
      invalidate();
    },
    onError,
  });

  const columns = [
    {
      title: t('purchases.invoiceNo'),
      dataIndex: 'invoiceNo',
      key: 'invoiceNo',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: PurchaseInvoiceListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('purchases.date'),
      dataIndex: 'invoiceDate',
      key: 'invoiceDate',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('purchases.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseInvoiceListItemDto) => displayName(r.supplier) ?? '—',
    },
    {
      title: t('purchases.paymentType'),
      dataIndex: 'paymentType',
      width: 110,
      render: (v: string) => (
        <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`purchases.${v}`)}</Tag>
      ),
    },
    {
      title: t('purchases.grandTotal'),
      dataIndex: 'grandTotal',
      key: 'grandTotal',
      sorter: true,
      sortOrder: list.sortOrderOf('grandTotal'),
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('purchases.paid'),
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
      <PurchaseInvoiceForm
        lookups={lookups}
        invoice={invoiceId ? detail : undefined}
        loading={detailLoading}
        isNew={!invoiceId}
        onLockBlocked={(notice) => {
          setLockedNotice(notice);
          setScreen('view');
        }}
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
        {lockedNotice && (
          <Alert
            type="warning"
            showIcon
            message={t('common.documentLockLocked', {
              name: lockedNotice.userName,
              time: formatDateTime(lockedNotice.acquiredAt),
            })}
            action={
              can(PERMISSIONS.DOCUMENT_UNLOCK) ? (
                <Button
                  onClick={() =>
                    Modal.confirm({
                      title: t('common.documentLockUnlockConfirm'),
                      onOk: async () => {
                        await lockedNotice.forceRelease();
                        setLockedNotice(null);
                        setScreen('form');
                      },
                    })
                  }
                >
                  {t('common.documentLockUnlock')}
                </Button>
              ) : undefined
            }
          />
        )}
        <PurchaseInvoiceView
          invoice={detail}
          loading={detailLoading}
          onBack={() => {
            setScreen('list');
            setInvoiceId(null);
            setLockedNotice(null);
          }}
          onEdit={() => {
            setLockedNotice(null);
            setScreen('form');
          }}
          onPost={(id) => post.mutate(id)}
          onDelete={(id) => del.mutate(id)}
          posting={post.isPending}
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
              placeholder={t('purchases.paymentType')}
              value={paymentFilter}
              onChange={setPaymentFilter}
              options={[
                { value: 'CREDIT', label: t('purchases.CREDIT') },
                { value: 'CASH', label: t('purchases.CASH') },
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
            {t('purchases.newInvoice')}
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
        onRow={(r) => ({ onClick: () => { setInvoiceId(r.id); setScreen('view'); }, style: { cursor: 'pointer' } })}
      />
    </div>
  );
}

// --------------------------------------------------------- invoice form

function PurchaseInvoiceForm({
  lookups,
  invoice,
  loading,
  isNew,
  onBack,
  onSaved,
  onLockBlocked,
}: {
  lookups: ReturnType<typeof usePurchaseLookups>;
  invoice?: PurchaseInvoiceDetailDto;
  loading: boolean;
  isNew: boolean;
  onBack: () => void;
  onSaved: (id: string) => void;
  onLockBlocked?: (notice: LockedInvoiceNotice) => void;
}) {
  const { t } = useTranslation();
  const { can, me, companyId } = useAuth();
  const editLock = useDocumentLock('PURCHASE_INVOICE', isNew ? null : invoice?.id, !isNew && !loading && invoice?.status === 'DRAFT');
  useEffect(() => {
    if (editLock.state.status === 'locked' && invoice?.id) {
      onLockBlocked?.({
        userName: editLock.state.userName,
        acquiredAt: editLock.state.acquiredAt,
        forceRelease: editLock.forceRelease,
      });
    }
  }, [editLock.forceRelease, editLock.state, invoice?.id, onLockBlocked]);
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [quickCreate, setQuickCreate] = useState<
    | { kind: 'party'; typedText: string }
    | { kind: 'item'; lineKey: number; row: number; typedText: string }
    | null
  >(null);
  const [createdSupplier, setCreatedSupplier] = useState<{ value: string; label: string }>();
  const [restoredCashAccount, setRestoredCashAccount] = useState<{ value: string; label: string }>();
  // Keyboard entry starts at the first field the user must fill.
  useEffect(() => {
    if (loading) return;
    const id = requestAnimationFrame(() => focusNamedField('supplier'));
    return () => cancelAnimationFrame(id);
  }, [loading]);
  const [invoiceDate, setInvoiceDate] = useState<Dayjs>(
    invoice ? dayjs(invoice.invoiceDate) : dayjs(),
  );
  const [dueDate, setDueDate] = useState<Dayjs | null>(
    invoice?.dueDate ? dayjs(invoice.dueDate) : null,
  );
  const [supplierId, setSupplierId] = useState<string | undefined>(invoice?.supplierId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(invoice?.warehouseId ?? undefined);
  const formDefaults = purchaseInvoiceFormDefaults(invoice);
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>(formDefaults.paymentType);
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState<string | undefined>(
    formDefaults.supplierInvoiceNo,
  );
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState<Dayjs | null>(
    formDefaults.supplierInvoiceDate ? dayjs(formDefaults.supplierInvoiceDate) : null,
  );
  const [cashAccountId, setCashAccountId] = useState<string | undefined>(formDefaults.cashAccountId);
  const costCenters = useCostCenters();
  const [costCenterId, setCostCenterId] = useState<string | undefined>(formDefaults.costCenterId);
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => {
    if (invoice?.lines.length) {
      return invoice.lines.map((l, i) => ({
        key: i + 1,
        itemId: l.itemId,
        qty: l.qtyBase,
        price: l.unitCost,
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
        { pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}), isActive: 'true', purchasable: 'true' },
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
                purchasePrice: l.unitCost,
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
  const supplierOption =
    createdSupplier ??
    (invoice?.supplier ? { value: invoice.supplier.id, label: codeAndName(invoice.supplier) } : null);
  const draftValue: PurchaseInvoiceDraft = {
    invoiceDate: invoiceDate.format('YYYY-MM-DD'),
    dueDate: dueDate?.format('YYYY-MM-DD') ?? null,
    supplierId: supplierId ?? null,
    supplierOption: supplierOption ?? null,
    supplierInvoiceNo: supplierInvoiceNo ?? null,
    supplierInvoiceDate: supplierInvoiceDate?.format('YYYY-MM-DD') ?? null,
    warehouseId: warehouseId ?? null,
    paymentType,
    cashAccountId: cashAccountId ?? null,
    cashAccountLabel:
      cashAccountOptions.find((option) => option.value === cashAccountId)?.label ?? null,
    costCenterId: costCenterId ?? null,
    lines,
    selectedItems,
  };
  const initialDraft = useRef<PurchaseInvoiceDraft | null>(null);
  initialDraft.current ??= draftValue;
  const initialBusinessValue = {
    invoiceDate: initialDraft.current.invoiceDate,
    dueDate: initialDraft.current.dueDate,
    supplierId: initialDraft.current.supplierId,
    supplierInvoiceNo: initialDraft.current.supplierInvoiceNo,
    supplierInvoiceDate: initialDraft.current.supplierInvoiceDate,
    warehouseId: initialDraft.current.warehouseId,
    paymentType: initialDraft.current.paymentType,
    cashAccountId: initialDraft.current.cashAccountId,
    costCenterId: initialDraft.current.costCenterId,
    lines: initialDraft.current.lines,
  };
  const { clear: clearEntryDraft, confirmLeave } = useEntryDraft({
    scope: {
      userId: me?.user.id,
      tenantId: me?.currentTenant?.tenantId,
      companyId,
      screenKey: `purchase-invoice:${isNew ? 'new' : invoice?.id ?? 'pending'}`,
    },
    value: draftValue,
    initialValue: initialDraft.current,
    dirtyValue: {
      invoiceDate: draftValue.invoiceDate,
      dueDate: draftValue.dueDate,
      supplierId: draftValue.supplierId,
      supplierInvoiceNo: draftValue.supplierInvoiceNo,
      supplierInvoiceDate: draftValue.supplierInvoiceDate,
      warehouseId: draftValue.warehouseId,
      paymentType: draftValue.paymentType,
      cashAccountId: draftValue.cashAccountId,
      costCenterId: draftValue.costCenterId,
      lines: draftValue.lines,
    },
    initialDirtyValue: initialBusinessValue,
    enabled: !loading && (isNew || invoice?.status === 'DRAFT'),
    discardWhenDisabled: !loading && !isNew && !!invoice && invoice.status !== 'DRAFT',
    onRestore: (draft) => {
      setInvoiceDate(dayjs(draft.invoiceDate));
      setDueDate(draft.dueDate ? dayjs(draft.dueDate) : null);
      setSupplierId(draft.supplierId ?? undefined);
      setCreatedSupplier(draft.supplierOption ?? undefined);
      setSupplierInvoiceNo(draft.supplierInvoiceNo ?? undefined);
      setSupplierInvoiceDate(draft.supplierInvoiceDate ? dayjs(draft.supplierInvoiceDate) : null);
      setWarehouseId(draft.warehouseId ?? undefined);
      setPaymentType(draft.paymentType);
      setCashAccountId(draft.cashAccountId ?? undefined);
      setRestoredCashAccount(
        draft.cashAccountId && draft.cashAccountLabel
          ? { value: draft.cashAccountId, label: draft.cashAccountLabel }
          : undefined,
      );
      setCostCenterId(draft.costCenterId ?? undefined);
      setLines(draft.lines);
      items.remember(draft.selectedItems);
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      // trySave checks the supplier before it saves; this narrows it for the request type.
      if (!supplierId) throw new Error('supplier is required');
      const payload = purchaseInvoiceBody(
        {
          invoiceDate: invoiceDate.format('YYYY-MM-DD'),
          dueDate: dueDate?.format('YYYY-MM-DD'),
          supplierId,
          supplierInvoiceNo,
          supplierInvoiceDate: supplierInvoiceDate?.format('YYYY-MM-DD'),
          warehouseId,
          paymentType,
          cashAccountId,
          // A draft keeps its centre while centres are off (ADR-024 §1.6): hidden, still sent.
          costCenterId,
          lines,
        },
        invoice,
      );
      const res = isNew
        ? await purchasesControllerCreateInvoice(payload)
        : await purchasesControllerUpdateInvoice(invoice!.id, payload, { headers: editLock.headers });
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
    supplier: !supplierId,
    warehouse: !warehouseId,
    cashAccount: paymentType === 'CASH' && !cashAccountId,
    lines: !lines.some((l) => l.itemId && l.qty),
  };
  const trySave = () => {
    if (save.isPending || (!isNew && editLock.state.status !== 'held')) return;
    const firstMissing = (['supplier', 'warehouse', 'cashAccount'] as const).find((k) => missing[k]);
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
      title={isNew ? t('purchases.newInvoice') : t('purchases.invoiceTitle')}
      docNo={invoice?.invoiceNo}
      status="DRAFT"
      onBack={() => confirmLeave(onBack)}
      actions={
        <Button
          type="primary"
          icon={<SaveOutlined />}
          loading={save.isPending}
          disabled={!isNew && editLock.state.status !== 'held'}
          onClick={trySave}
        >
          {isNew ? t('common.saveDraft') : t('common.save')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      {contextHolder}
      {editLock.state.status === 'lost' && (
        <Alert className="doc-section" type="error" showIcon message={t('common.documentLockLost')} />
      )}
      {editLock.state.status === 'error' && (
        <Alert className="doc-section" type="error" showIcon message={t('errors.INTERNAL')} />
      )}
      <DocFields>
        <DocField
          field="supplier"
          label={t('purchases.supplier')}
          required
          error={requiredError(missing.supplier)}
          onKeyDown={enterTo(() => focusNamedField('warehouse'))}
        >
          {/* Searches suppliers on the server by code or name (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['parties', 'pick', 'SUPPLIER']}
            fetchOptions={(q, signal) =>
              partiesControllerList(
                { partyType: 'SUPPLIER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
                { signal },
              ).then((r) =>
                r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
              )
            }
            selected={
              createdSupplier ??
              (invoice?.supplier
                ? { value: invoice.supplier.id, label: codeAndName(invoice.supplier) }
                : undefined)
            }
            status={requiredError(missing.supplier) ? 'error' : undefined}
            value={supplierId}
            onChange={setSupplierId}
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
          label={t('purchases.warehouse')}
          required
          error={requiredError(missing.warehouse)}
          onKeyDown={enterTo(() => focusNamedField('supplierInvoiceNo'))}
        >
          <GridSelect
            status={requiredError(missing.warehouse) ? 'error' : undefined}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </DocField>
        <DocField
          field="supplierInvoiceNo"
          label={t('purchases.supplierInvoiceNo')}
          onKeyDown={enterTo(() => focusNamedField('supplierInvoiceDate'))}
        >
          <Input
            value={supplierInvoiceNo}
            onChange={(e) => setSupplierInvoiceNo(e.target.value)}
            maxLength={100}
          />
        </DocField>
        <DocField
          field="supplierInvoiceDate"
          label={t('purchases.supplierInvoiceDate')}
          onKeyDown={enterTo(() => focusNamedField('invoiceDate'))}
        >
          <DatePicker value={supplierInvoiceDate} onChange={setSupplierInvoiceDate} allowClear />
        </DocField>
        <DocField
          field="invoiceDate"
          label={t('purchases.invoiceDate')}
          onKeyDown={enterTo(() => focusNamedField('dueDate'))}
        >
          <DatePicker value={invoiceDate} onChange={(d) => d && setInvoiceDate(d)} />
        </DocField>
        <DocField
          field="dueDate"
          label={t('purchases.dueDate')}
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
          label={t('purchases.paymentType')}
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
              { value: 'CREDIT', label: t('purchases.CREDIT') },
              { value: 'CASH', label: t('purchases.CASH') },
            ]}
          />
        </DocField>
        {paymentType === 'CASH' && (
          <DocField
            field="cashAccount"
            label={t('purchases.cashAccount')}
            required
            error={requiredError(missing.cashAccount)}
            onKeyDown={enterTo(focusFirstGridCell)}
          >
            <GridSelect
              status={requiredError(missing.cashAccount) ? 'error' : undefined}
              options={cashAccountOptions}
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
        onCreateItem={
          can(PERMISSIONS.ITEM_MANAGE)
            ? (lineKey, row, typedText) => setQuickCreate({ kind: 'item', lineKey, row, typedText })
            : undefined
        }
        priceLabel={t('purchases.unitCost')}
      />
      <PartyFormDialog
        open={quickCreate?.kind === 'party'}
        initialValues={quickCreate?.kind === 'party' ? { nameAr: quickCreate.typedText, partyType: 'SUPPLIER' } : undefined}
        lockPartyType
        onCancel={() => {
          setQuickCreate(null);
          requestAnimationFrame(() => focusNamedField('supplier'));
        }}
        onSaved={(created) => {
          setCreatedSupplier({ value: created.id, label: codeAndName(created) });
          setSupplierId(created.id);
          void queryClient.invalidateQueries({ queryKey: ['parties'] });
          setQuickCreate(null);
          requestAnimationFrame(() => focusNamedField('supplier'));
        }}
      />
      <ItemFormDialog
        open={quickCreate?.kind === 'item'}
        initialValues={quickCreate?.kind === 'item' ? { nameAr: quickCreate.typedText } : undefined}
        excludeKinds={['RECIPE']}
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
            purchasePrice: created.purchasePrice,
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
    </DocLayout>
  );
}

// ----------------------------------------------------------- invoice view

function PurchaseInvoiceView({
  invoice,
  loading,
  onBack,
  onEdit,
  onPost,
  onDelete,
  posting,
}: {
  invoice?: PurchaseInvoiceDetailDto;
  loading: boolean;
  onBack: () => void;
  onEdit: () => void;
  onPost: (id: string) => void;
  onDelete: (id: string) => void;
  posting: boolean;
}) {
  const lockHeaders = documentLockHeaders();
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const { modal } = App.useApp();
  const costCenters = useCostCenters();
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const isDraft = invoice?.status === 'DRAFT';
  const priceLines = invoice?.priceAboveOrderLines ?? [];
  const needsPriceApproval = isDraft && !!invoice?.purchaseOrder && priceLines.length > 0 && !invoice?.priceApprovedAt;
  // Only the owner may approve a bill the signed-in user created or last edited (ADR-025 §2, ADR-026 §2).
  const priceApprovalBlocked = approvalBlockedAsOwnDocument({
    createdBy: invoice?.createdBy,
    updatedBy: invoice?.updatedBy,
    submittedBy: null,
    userId: me?.user.id,
    isOwner: me?.currentMembership?.roleCode === 'OWNER',
  });
  // ADR-026 §2: the approver accepts the price difference of a bill above its order.
  const approvePrice = useMutation({
    mutationFn: (id: string) =>
      purchasesControllerApprovePrice(id, { headers: { ...idemHeaders(), ...lockHeaders } }),
    onSuccess: (_data, id) => {
      apiMessage.success(t('billing.approvePriceDone'));
      void queryClient.invalidateQueries({ queryKey: ['purchase-invoice', id] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
      void invalidateProcurement(queryClient);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
      ),
  });
  // Ctrl+Enter posts a draft, behind the same confirmation as the button.
  const confirmPost = () => {
    if (!invoice || !isDraft || posting) return;
    modal.confirm({ title: t('purchases.postConfirm'), onOk: () => onPost(invoice.id) });
  };
  useDocShortcuts({ onPost: confirmPost });
  if (loading || !invoice) {
    return <Typography.Text>{t('common.loading')}</Typography.Text>;
  }
  const remaining = dec(invoice.grandTotal).minus(dec(invoice.paidAmount));
  return (
    <DocLayout
      title={t('purchases.invoiceTitle')}
      docNo={invoice.invoiceNo ?? `#${invoice.id}`}
      status={invoice.status}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          {isDraft && (
            <>
              {/* A bill of an order's receipts is made from the order (ADR-026 §7): delete it and bill again to change it. */}
              {!invoice.purchaseOrder && <Button onClick={onEdit}>{t('common.edit')}</Button>}
              {needsPriceApproval && can(PERMISSIONS.PURCHASE_APPROVE) &&
                (priceApprovalBlocked ? (
                  <>
                    <Button disabled>{t('billing.approvePrice')}</Button>
                    <Typography.Text type="secondary">{t('procurement.ownDocument')}</Typography.Text>
                  </>
                ) : (
                  <Popconfirm title={t('billing.approvePriceConfirm')} onConfirm={() => approvePrice.mutate(invoice.id)}>
                    <Button loading={approvePrice.isPending}>{t('billing.approvePrice')}</Button>
                  </Popconfirm>
                ))}
              <Popconfirm title={t('purchases.postConfirm')} onConfirm={() => onPost(invoice.id)}>
                <Button type="primary" loading={posting}>
                  {t('common.post')}
                  <span className="doc-kbd">Ctrl+Enter</span>
                </Button>
              </Popconfirm>
              <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => onDelete(invoice.id)}>
                <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
              </Popconfirm>
            </>
          )}
          <PrintPdfButton path={`/purchase-invoices/${invoice.id}/pdf`} />
        </>
      }
    >
      {isDraft && invoice.purchaseOrder && (
        <Alert type="info" showIcon message={t('billing.editFromOrderHint')} />
      )}
      {needsPriceApproval && (
        <Alert
          type="warning"
          showIcon
          message={t('billing.needsApproval', { count: priceLines.length })}
          description={priceLines.map((line) => (
            <div key={line.grnLineId}>
              {t('billing.priceLineDetail', {
                lineNo: line.lineNo,
                invoicePrice: line.invoiceNetUnitPrice,
                orderPrice: line.orderNetUnitPrice,
              })}
            </div>
          ))}
        />
      )}
      <DocFields>
        <DocField label={t('purchases.supplier')}>
          <DocValue>{displayName(invoice.supplier)}</DocValue>
        </DocField>
        <DocField label={t('purchases.supplierInvoiceNo')}>
          <DocValue>{invoice.supplierInvoiceNo ?? '—'}</DocValue>
        </DocField>
        {invoice.purchaseOrder && (
          <DocField label={t('billing.purchaseOrderNo')}>
            <DocValue>{invoice.purchaseOrder.orderNo ?? `#${invoice.purchaseOrder.id}`}</DocValue>
          </DocField>
        )}
        {invoice.priceApprovedAt && (
          <DocField label={t('billing.priceApprovedLabel')}>
            <DocValue>
              <StatusTag tone="success">{t('billing.priceApproved')}</StatusTag>
            </DocValue>
          </DocField>
        )}
        <DocField label={t('purchases.paymentType')}>
          <DocValue>
            <Tag color={invoice.paymentType === 'CASH' ? 'green' : 'blue'}>
              {t(`purchases.${invoice.paymentType}`)}
            </Tag>
          </DocValue>
        </DocField>
        <DocField label={t('purchases.invoiceDate')}>
          <DocValue>{dayjs(invoice.invoiceDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('purchases.dueDate')}>
          <DocValue>{invoice.dueDate ? dayjs(invoice.dueDate).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        {costCenters.enabled && invoice.costCenterId && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{costCenters.nameOf(invoice.costCenterId)}</DocValue>
          </DocField>
        )}
        <DocField label={t('purchases.net')}>
          <DocValue>{amountCell(invoice.netTotal)}</DocValue>
        </DocField>
        <DocField label={t('purchases.tax')}>
          <DocValue>{amountCell(invoice.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('purchases.grandTotal')}>
          <DocValue>{amountCell(invoice.grandTotal)}</DocValue>
        </DocField>
        <DocField label={`${t('purchases.paid')} / ${t('sales.remaining')}`}>
          <DocValue>
            {amountCell(invoice.paidAmount)}
            <span style={{ margin: '0 6px' }}>/</span>
            <Typography.Text type={remaining.gt(0) && !isDraft ? 'danger' : undefined}>
              {amountCell(remaining)}
            </Typography.Text>
          </DocValue>
        </DocField>
      </DocFields>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={invoice.lines ?? []}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          {
            title: t('items.title'),
            render: (_: unknown, l: InvoiceLine) =>
              l.item ? codeAndName(l.item) : l.itemId,
          },
          { title: t('stock.qty'), dataIndex: 'qtyBase', width: 90, align: 'right' as const, render: qtyCell },
          { title: t('purchases.unitCost'), dataIndex: 'unitCost', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('purchases.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('purchases.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('purchases.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('purchases.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
      />
    </DocLayout>
  );
}

// ------------------------------------------------------------- returns tab

function PurchaseReturnsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<PurchasesControllerListReturnsStatus | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const costCenters = useCostCenters();
  const [apiMessage, contextHolder] = message.useMessage();

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    PurchaseReturnListItemDto,
    { status?: PurchasesControllerListReturnsStatus },
    PurchasesControllerListReturnsSort
  >({
    key: ['purchase-returns', 'list'],
    filters: { status: statusFilter },
    defaultSort: '-returnDate',
    fetch: (params, signal) => purchasesControllerListReturns(params, { signal }).then((r) => r.data),
    enabled: !modalOpen && !viewId,
  });

  const { data: view } = useQuery({
    queryKey: ['purchase-return', viewId],
    queryFn: ({ signal }) =>
      purchasesControllerGetReturn(viewId!, { signal }).then((r) => r.data),
    enabled: !!viewId,
  });

  const invalidate = () => invalidateStockDocument(queryClient, 'purchaseReturn');
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) => purchasesControllerPostReturn(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => purchasesControllerDeleteReturn(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
    },
    onError,
  });

  const columns = [
    {
      title: t('purchases.returnNo'),
      dataIndex: 'returnNo',
      key: 'returnNo',
      sorter: true,
      sortOrder: list.sortOrderOf('returnNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: PurchaseReturnListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('purchases.date'),
      dataIndex: 'returnDate',
      key: 'returnDate',
      sorter: true,
      sortOrder: list.sortOrderOf('returnDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('purchases.invoice'),
      dataIndex: 'originalInvoice',
      render: (_: unknown, r: PurchaseReturnListItemDto) => r.originalInvoice?.invoiceNo ?? `#${r.originalInvoiceId}`,
    },
    {
      title: t('purchases.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseReturnListItemDto) => displayName(r.supplier) ?? '—',
    },
    {
      title: t('purchases.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`purchases.${v}`)}</Tag>,
    },
    {
      title: t('purchases.grandTotal'),
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
      render: (_: unknown, r: PurchaseReturnListItemDto) => (
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
      <PurchaseReturnForm
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
          title={t('purchases.returnDetail')}
          docNo={view?.returnNo}
          status={view?.status}
          onBack={() => setViewId(null)}
          actions={
            <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
              {t('common.print')}
            </Button>
          }
        >
          {view ? (
            <>
              <DocFields>
                <DocField label={t('purchases.invoice')}>
                  <DocValue>
                    <span className="doc-no">{view.originalInvoice?.invoiceNo ?? '—'}</span>
                  </DocValue>
                </DocField>
                <DocField label={t('purchases.supplier')}>
                  <DocValue>{displayName(view.supplier)}</DocValue>
                </DocField>
                <DocField label={t('purchases.date')}>
                  <DocValue>{dayjs(view.returnDate).format('YYYY-MM-DD')}</DocValue>
                </DocField>
                <DocField label={t('purchases.refundType')}>
                  <DocValue>{t(`purchases.${view.refundType}`)}</DocValue>
                </DocField>
                {costCenters.enabled && view.costCenterId && (
                  <DocField label={t('costCenters.documentField')}>
                    <DocValue>{costCenters.nameOf(view.costCenterId)}</DocValue>
                  </DocField>
                )}
                <DocField label={t('purchases.grandTotal')}>
                  <DocValue>{amountCell(view.grandTotal)}</DocValue>
                </DocField>
                {view.reason && (
                  <DocField label={t('common.reason')}>
                    <DocValue>{view.reason}</DocValue>
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
                  { title: t('purchases.total'), dataIndex: 'lineTotal', width: 120, align: 'right' as const, render: amountCell },
                ]}
              />
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
            {t('purchases.newReturn')}
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

function PurchaseReturnForm({
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

  const lookups = usePurchaseLookups();
  const { data: invoice } = useQuery({
    queryKey: ['purchase-invoice', invoiceId],
    queryFn: ({ signal }) =>
      purchasesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
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
    // Save needs a quantity on a line, and the lines come from the loaded invoice.
    mutationFn: async () =>
      purchasesControllerCreateReturn(
        purchaseReturnBody(invoice!, {
          returnDate: returnDate.format('YYYY-MM-DD'),
          refundType,
          cashAccountId,
          // A new return: a centre only while centres are on (the prefill stays hidden otherwise).
          costCenterId: costCenters.enabled ? costCenterId : undefined,
          reason,
          qtyByLine,
        }),
      ),
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
      await purchasesControllerPostReturn(created.data.id, { headers: idemHeaders() });
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
      title={t('purchases.newReturn')}
      status="DRAFT"
      onBack={onClose}
      actions={
        <>
          <Button loading={create.isPending} onClick={() => trySave(false)}>
            {t('common.saveDraft')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          <Button type="primary" loading={postCreated.isPending} onClick={() => trySave(true)}>
            {t('purchases.createAndPost')}
          </Button>
        </>
      }
    >
      {contextHolder}
      <DocFields>
        <DocField label={t('purchases.invoice')} required error={invoiceError}>
          {/* Searches posted invoices on the server by number or supplier (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['purchase-invoices', 'pick-posted']}
            fetchOptions={(q, signal) =>
              purchasesControllerListInvoices(
                { status: 'POSTED', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
                { signal },
              ).then((r) =>
                r.data.items.map((i) => ({
                  value: i.id,
                  label: `${i.invoiceNo ?? `#${i.id}`} — ${displayName(i.supplier) ?? ''} — ${money(i.grandTotal)}`,
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
        <DocField label={t('purchases.date')}>
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
        <DocField label={t('purchases.refundType')}>
          <Radio.Group
            name="refundType"
            optionType="button"
            buttonStyle="solid"
            value={refundType}
            onChange={(e) => setRefundType(e.target.value)}
            options={[
              { value: 'CREDIT', label: t('purchases.CREDIT') },
              { value: 'CASH', label: t('purchases.CASH') },
            ]}
          />
        </DocField>
        {refundType === 'CASH' && (
          <DocField label={t('purchases.cashAccount')}>
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
              title: t('purchases.returnQty'),
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
              title: t('purchases.total'),
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
