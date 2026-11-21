import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Input, InputNumber, Popconfirm, Select, Space, Table, Typography, message } from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  catalogControllerListItems,
  partiesControllerList,
  salesCycleControllerApproveOrder,
  salesCycleControllerCancelOrder,
  salesCycleControllerCloseOrder,
  salesCycleControllerConfirmOrder,
  salesCycleControllerCreateOrder,
  salesCycleControllerDeleteOrder,
  salesCycleControllerGetOrder,
  salesCycleControllerInvoiceable,
  salesCycleControllerListOrders,
  salesCycleControllerRejectOrderApproval,
  salesCycleControllerUpdateOrder,
  warehousesControllerList,
  type ItemListItemDto,
  type SalesCycleControllerListOrdersSort,
  type SalesCycleControllerListOrdersStatus,
  type SalesCycleOrderDetailDto,
  type SalesCycleOrderLineViewDto,
  type SalesCycleOrderListItemDto,
  type SalesOrderStatus,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { GridSelect, focusNamedField } from '../components/GridSelect';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { ReasonModal } from '../components/ReasonModal';
import { PICKER_PAGE_SIZE, RemoteSelect } from '../components/RemoteSelect';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { tableLocale } from '../components/QueryState';
import { useCostCenters } from '../hooks/useCostCenters';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { useNewFromUrl } from '../useNewFromUrl';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { formatDate } from '../format/date';
import { isAuthoredBy } from './procurement/orderPayload';
import { salesCycleKeys, invalidateSalesCycle } from './sales/cycleQueryKeys';
import { CustomerFilter } from './sales/CustomerFilter';
import { apiErrorText as errorText } from '../components/ExportButtons';
import { OrderInvoiceModal } from './sales/OrderInvoiceModal';
import { ReservationPanel, type ReservationLine } from './sales/ReservationPanel';
import { SalesLinesGrid, type SalesLineDraft } from './sales/SalesLinesGrid';
import { missingSalesPriceLines } from './sales/salesLines';
import { salesApprovalHint, salesOrderBody } from './sales/orderPayload';

// ------------------------------------------------------------------ types

/** What the page shows: the list, a new order, or one saved order. */
type Screen = { kind: 'list' } | { kind: 'new' } | { kind: 'order'; id: string };

/** An item as the item picker holds it: a search result, or a line of a saved order. */
type ItemRow = Pick<ItemListItemDto, 'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'salePrice'>;

/** Role code of the owner: the owner approves every order (ADR-027 §6). */
const OWNER_ROLE = 'OWNER';

const STATUSES: SalesOrderStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'CONFIRMED',
  'PARTIALLY_INVOICED',
  'INVOICED',
  'CLOSED',
  'CANCELLED',
];

const STATUS_TONE: Record<SalesOrderStatus, StatusTone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  CONFIRMED: 'info',
  PARTIALLY_INVOICED: 'info',
  INVOICED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

function OrderStatusTag({ status }: { status: SalesOrderStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`salesCycle.orderStatuses.${status}`)}</StatusTag>;
}

// ------------------------------------------------------------------ page

export function SalesOrdersPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // A quote or an invoice links here with ?orderId=...: that order opens. The address is cleaned up below.
  const linkedId = params.get('orderId');
  const [screen, setScreen] = useState<Screen>(() => (linkedId ? { kind: 'order', id: linkedId } : { kind: 'list' }));
  useEffect(() => {
    if (!linkedId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('orderId');
        return next;
      },
      { replace: true },
    );
  }, [linkedId, setParams]);
  useNewFromUrl(() => setScreen({ kind: 'new' }));

  return (
    <div>
      <PageHeader title={t('nav.salesOrders')} />
      {screen.kind === 'list' ? (
        <OrdersList onOpen={(id) => setScreen({ kind: 'order', id })} onNew={() => setScreen({ kind: 'new' })} />
      ) : (
        <OrderScreen
          key={screen.kind === 'order' ? `order-${screen.id}` : 'new'}
          id={screen.kind === 'order' ? screen.id : undefined}
          onBack={() => setScreen({ kind: 'list' })}
          onOpen={(id) => setScreen({ kind: 'order', id })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ list

function OrdersList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [statusFilter, setStatusFilter] = useState<SalesCycleControllerListOrdersStatus | undefined>(undefined);
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);

  // Server-paged (ADR-022): search, filters, sort and page go to the API.
  const list = usePagedQuery<
    SalesCycleOrderListItemDto,
    { status?: SalesCycleControllerListOrdersStatus; customerId?: string; from?: string; to?: string },
    SalesCycleControllerListOrdersSort
  >({
    key: salesCycleKeys.orderList(),
    filters: { status: statusFilter, customerId, from, to },
    defaultSort: '-orderDate',
    fetch: (params, signal) => salesCycleControllerListOrders(params, { signal }).then((r) => r.data),
  });

  const columns = [
    {
      title: t('salesCycle.orderNo'),
      dataIndex: 'orderNo',
      key: 'orderNo',
      sorter: true,
      sortOrder: list.sortOrderOf('orderNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('salesCycle.orderDate'),
      dataIndex: 'orderDate',
      key: 'orderDate',
      sorter: true,
      sortOrder: list.sortOrderOf('orderDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesCycleOrderListItemDto) => displayName(r.customer) ?? '—',
    },
    {
      title: t('salesCycle.fromQuote'),
      dataIndex: 'quote',
      width: 130,
      render: (_: unknown, r: SalesCycleOrderListItemDto) => r.quote?.quoteNo ?? '—',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 170,
      render: (v: SalesOrderStatus) => <OrderStatusTag status={v} />,
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
  ];

  return (
    <div>
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('salesCycle.searchOrders')}
        filters={
          <Space wrap>
            <Select
              allowClear
              style={{ minWidth: 170 }}
              placeholder={t('common.status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUSES.map((s) => ({ value: s, label: t(`salesCycle.orderStatuses.${s}`) }))}
            />
            <CustomerFilter value={customerId} onChange={setCustomerId} />
            <DatePicker.RangePicker
              allowClear
              format="YYYY-MM-DD"
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(_, dateStrings) => {
                setFrom(dateStrings[0] || undefined);
                setTo(dateStrings[1] || undefined);
              }}
            />
          </Space>
        }
        count={list.total}
        actions={
          can(PERMISSIONS.SALES_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
              {t('salesCycle.newOrder')}
            </Button>
          )
        }
      />
      <ResponsiveTable<SalesCycleOrderListItemDto>
        rowKey="id"
        loading={list.query.isLoading}
        dataSource={list.rows}
        locale={tableLocale(list.query)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
        onRow={(r) => ({ onClick: () => onOpen(r.id), style: { cursor: 'pointer' } })}
        mobileCard={{
          title: (order) => order.orderNo ?? t('procurement.draftNo'),
          subtitle: (order) => `${formatDate(order.orderDate)} · ${displayName(order.customer) ?? '—'}`,
          amount: (order) => amountCell(order.grandTotal),
          status: (order) => <OrderStatusTag status={order.status} />,
          meta: (order) => (order.quote?.quoteNo ? [<span>{t('salesCycle.fromQuote')}: {order.quote.quoteNo}</span>] : []),
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ screen

/** Loads a saved order: a draft (or a new one) opens in the editor, anything else in the view. */
function OrderScreen({ id, onBack, onOpen }: { id?: string; onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.SALES_MANAGE);
  const detail = useQuery({
    queryKey: salesCycleKeys.order(id),
    queryFn: ({ signal }) => salesCycleControllerGetOrder(id!, { signal }).then((r) => r.data),
    enabled: !!id,
  });

  if (id && detail.isError) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  if (id && detail.isPending) return <Typography.Text>{t('common.loading')}</Typography.Text>;

  const order = detail.data;
  if (order && (order.status !== 'DRAFT' || !canManage)) {
    return <OrderView order={order} onBack={onBack} />;
  }
  return <OrderEditor order={order} onBack={onBack} onSaved={onOpen} onDeleted={onBack} />;
}

// ------------------------------------------------------------------ editor

function OrderEditor({
  order,
  onBack,
  onSaved,
  onDeleted,
}: {
  /** The DRAFT being edited; undefined for a new order. */
  order?: SalesCycleOrderDetailDto;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const costCenters = useCostCenters();
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const isNew = !order;
  const [cancelOpen, setCancelOpen] = useState(false);

  // Keyboard entry starts at the first field the user must fill.
  useEffect(() => {
    const id = requestAnimationFrame(() => focusNamedField('customer'));
    return () => cancelAnimationFrame(id);
  }, []);

  const [orderDate, setOrderDate] = useState<Dayjs>(order ? dayjs(order.orderDate) : dayjs());
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(order?.expectedDate ? dayjs(order.expectedDate) : null);
  const [customerId, setCustomerId] = useState<string | undefined>(order?.customerId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(order?.warehouseId);
  const [costCenterId, setCostCenterId] = useState<string | undefined>(order?.costCenterId ?? undefined);
  const [paymentTermsDays, setPaymentTermsDays] = useState<number | null>(order?.paymentTermsDays ?? null);
  const [description, setDescription] = useState(order?.description ?? '');
  const [lines, setLines] = useState<SalesLineDraft[]>(() =>
    order?.lines.length
      ? order.lines.map((l, i) => ({
          key: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId ?? undefined,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
        }))
      : [{ key: 1 }, { key: 2 }],
  );
  const lineSeq = useRef(lines.length);

  // Items are searched on the server; the lines' own items stay labelled.
  const items = useRemoteOptions<ItemRow>({
    key: ['items', 'pick', { isActive: 'true' }],
    fetch: (q, signal) =>
      catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}), isActive: 'true' }, { signal }).then(
        (r) => r.data.items,
      ),
  });
  const { remember: rememberItems } = items;
  useEffect(() => {
    rememberItems(
      (order?.lines ?? []).map(
        (l: SalesCycleOrderLineViewDto): ItemRow => ({
          id: l.itemId,
          code: l.item.code,
          nameAr: l.item.nameAr,
          nameEn: l.item.nameEn,
          itemKind: l.item.itemKind,
          salePrice: null,
        }),
      ),
    );
  }, [order, rememberItems]);
  const itemOptions = items.withSelected(lines.map((l) => l.itemId)).map((row) => ({ value: row.id, label: codeAndName(row) }));

  const persist = async (): Promise<string> => {
    const body = salesOrderBody({
      orderDate: orderDate.format('YYYY-MM-DD'),
      expectedDate: expectedDate?.format('YYYY-MM-DD'),
      customerId: customerId!,
      warehouseId: warehouseId!,
      costCenterId,
      paymentTermsDays: paymentTermsDays ?? undefined,
      description,
      lines,
    });
    const res = order ? await salesCycleControllerUpdateOrder(order.id, body) : await salesCycleControllerCreateOrder(body);
    return res.data.id;
  };

  const onError = (err: unknown) => apiMessage.error(errorText(t, err));
  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      void invalidateSalesCycle(queryClient);
      onSaved(id);
    },
    onError,
  });
  // Confirm saves the draft first, so the confirmed order is the one on screen.
  const confirm = useMutation({
    mutationFn: async () => {
      const id = await persist();
      const res = await salesCycleControllerConfirmOrder(id, { headers: idemHeaders() });
      return res.data;
    },
    onSuccess: (confirmed) => {
      apiMessage.success(
        confirmed.status === 'PENDING_APPROVAL' ? t('salesCycle.sentForApproval') : t('salesCycle.confirmed'),
      );
      void invalidateSalesCycle(queryClient);
      onSaved(confirmed.id);
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => salesCycleControllerCancelOrder(order!.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setCancelOpen(false);
      apiMessage.success(t('salesCycle.cancelled'));
      void invalidateSalesCycle(queryClient);
      onDeleted();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => salesCycleControllerDeleteOrder(order!.id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateSalesCycle(queryClient);
      onDeleted();
    },
    onError,
  });
  const busy = save.isPending || confirm.isPending || cancel.isPending || remove.isPending;

  // Save stays enabled: an attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const priceGaps = missingSalesPriceLines(lines);
  const missing = {
    customer: !customerId,
    warehouse: !warehouseId,
    lines: !lines.some((l) => l.itemId && l.qty),
    prices: priceGaps.length > 0,
  };
  /** True when the form may be sent; otherwise marks what is missing. */
  const checkForm = (): boolean => {
    if (busy) return false;
    if (missing.customer) {
      setTried(true);
      focusNamedField('customer');
      return false;
    }
    if (missing.warehouse) {
      setTried(true);
      focusNamedField('warehouse');
      return false;
    }
    if (missing.lines) {
      setTried(true);
      apiMessage.warning(t('stock.minLines'));
      return false;
    }
    if (missing.prices) {
      setTried(true);
      apiMessage.warning(t('salesCycle.priceRequired'));
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (checkForm()) save.mutate();
  };
  const confirmOrder = () => {
    if (checkForm()) confirm.mutate();
  };
  useDocShortcuts({ onSave: saveDraft });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);

  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }));
  const reservationLines: ReservationLine[] = lines.flatMap((l) =>
    l.itemId ? [{ itemId: l.itemId, label: codeAndName(items.byId(l.itemId) ?? { code: l.itemId, nameAr: l.itemId, nameEn: null }) }] : [],
  );

  return (
    <DocLayout
      title={isNew ? t('salesCycle.newOrder') : t('salesCycle.orderTitle')}
      docNo={order ? (order.orderNo ?? t('procurement.draftNo')) : undefined}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={saveDraft}>
            {isNew ? t('common.saveDraft') : t('common.save')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          {order && (
            <>
              <Popconfirm title={t('salesCycle.confirmOrder')} onConfirm={confirmOrder}>
                <Button disabled={busy} loading={confirm.isPending}>
                  {t('salesCycle.confirm')}
                </Button>
              </Popconfirm>
              <Button danger disabled={busy} onClick={() => setCancelOpen(true)}>
                {t('procurement.cancel')}
              </Button>
              <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate()}>
                <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={busy} loading={remove.isPending} />
              </Popconfirm>
            </>
          )}
        </>
      }
    >
      {order?.quote && <QuoteLink quote={order.quote} />}
      <DocFields>
        <DocField field="customer" label={t('sales.customer')} required error={requiredError(missing.customer)}>
          <RemoteSelect
            queryKey={['parties', 'pick', 'CUSTOMER']}
            fetchOptions={(q, signal) =>
              partiesControllerList({ partyType: 'CUSTOMER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
                (r) => r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
              )
            }
            selected={order?.customer ? { value: order.customer.id, label: codeAndName(order.customer) } : undefined}
            status={requiredError(missing.customer) ? 'error' : undefined}
            value={customerId}
            onChange={setCustomerId}
          />
        </DocField>
        <DocField field="warehouse" label={t('sales.warehouse')} required error={requiredError(missing.warehouse)}>
          <GridSelect
            status={requiredError(missing.warehouse) ? 'error' : undefined}
            options={warehouseOptions}
            value={warehouseId}
            onChange={(v: string | undefined) => setWarehouseId(v)}
          />
        </DocField>
        <DocField label={t('salesCycle.orderDate')} required>
          <DatePicker value={orderDate} onChange={(d) => d && setOrderDate(d)} />
        </DocField>
        <DocField label={t('salesCycle.expectedDate')}>
          <DatePicker value={expectedDate} onChange={setExpectedDate} allowClear />
        </DocField>
        <DocField label={t('salesCycle.paymentTermsDays')}>
          <InputNumber<number>
            min={0}
            max={3650}
            precision={0}
            value={paymentTermsDays}
            onChange={(v) => setPaymentTermsDays(v ?? null)}
            style={{ width: '100%' }}
          />
        </DocField>
        {costCenters.enabled && (
          <DocField field="costCenter" label={<CostCenterLabel />}>
            <CostCenterSelect rows={costCenters.rows} value={costCenterId} onChange={setCostCenterId} />
          </DocField>
        )}
        <DocField label={t('salesCycle.description')} wide>
          <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
        </DocField>
      </DocFields>

      <SalesLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
        priceOf={(itemId) => items.byId(itemId)?.salePrice ?? undefined}
        nextKey={() => {
          lineSeq.current += 1;
          return lineSeq.current;
        }}
        lineError={tried && missing.lines ? t('common.requiredField') : undefined}
        priceGaps={new Set(tried ? priceGaps : [])}
      />
      <ReservationPanel warehouseId={warehouseId} lines={reservationLines} checkStock={false} />

      {cancelOpen && (
        <ReasonModal
          title={t('salesCycle.cancelTitle')}
          okText={t('procurement.cancel')}
          busy={cancel.isPending}
          onClose={() => setCancelOpen(false)}
          onConfirm={(reason) => cancel.mutate(reason)}
        />
      )}
    </DocLayout>
  );
}

/** The quote an order was made from, linked back to it (ADR-027 §3). */
function QuoteLink({ quote }: { quote: { id: string; quoteNo: string | null } }) {
  const { t } = useTranslation();
  return (
    <Typography.Text type="secondary">
      {t('salesCycle.fromQuote')}: <Link to={`/sales-quotes?quoteId=${quote.id}`}>{quote.quoteNo ?? `#${quote.id}`}</Link>
    </Typography.Text>
  );
}

// ------------------------------------------------------------------ view

/**
 * Read-only order with the actions of its status (ADR-027 §3–§6): approval
 * while pending, invoices while confirmed or partly invoiced, close and cancel.
 */
function OrderView({ order, onBack }: { order: SalesCycleOrderDetailDto; onBack: () => void }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [apiMessage, contextHolder] = message.useMessage();
  const [reasonAction, setReasonAction] = useState<'reject' | 'cancel' | 'close' | null>(null);
  const [invoiceOpen, setInvoiceOpen] = useState(false);
  const canApprove = can(PERMISSIONS.SALES_APPROVE);
  const canManage = can(PERMISSIONS.SALES_MANAGE);
  const pending = order.status === 'PENDING_APPROVAL';
  const membership = me?.currentMembership ?? null;
  const hint = salesApprovalHint({
    isOwner: membership?.roleCode === OWNER_ROLE,
    canApprove,
    authoredByMe: isAuthoredBy(order, me?.user.id),
  });
  // Invoices and their remainders exist once the order is confirmed.
  const confirmed = order.status !== 'PENDING_APPROVAL' && order.status !== 'CANCELLED';
  const invoiceable = useQuery({
    queryKey: salesCycleKeys.invoiceable(order.id),
    queryFn: ({ signal }) => salesCycleControllerInvoiceable(order.id, { signal }).then((r) => r.data),
    enabled: confirmed,
  });
  const remainingOf = new Map((invoiceable.data?.lines ?? []).map((l) => [l.orderLineId, l]));

  const refresh = () => void invalidateSalesCycle(queryClient);
  const onError = (err: unknown) => apiMessage.error(errorText(t, err));

  const approve = useMutation({
    mutationFn: () => salesCycleControllerApproveOrder(order.id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('salesCycle.approved'));
      refresh();
    },
    onError,
  });
  const rejectApproval = useMutation({
    mutationFn: (reason: string) =>
      salesCycleControllerRejectOrderApproval(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('salesCycle.approvalRejected'));
      refresh();
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => salesCycleControllerCancelOrder(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('salesCycle.cancelled'));
      refresh();
    },
    onError,
  });
  const close = useMutation({
    mutationFn: (reason: string) => salesCycleControllerCloseOrder(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('salesCycle.closed'));
      refresh();
    },
    onError,
  });
  const busy = approve.isPending || rejectApproval.isPending || cancel.isPending || close.isPending;

  const reasonTitle = reasonAction === 'reject' ? 'salesCycle.rejectApprovalTitle' : reasonAction === 'cancel' ? 'salesCycle.cancelTitle' : 'salesCycle.closeTitle';
  const reasonBusy =
    reasonAction === 'reject' ? rejectApproval.isPending : reasonAction === 'cancel' ? cancel.isPending : close.isPending;

  const approvalNote =
    pending && hint === 'ownDocument'
      ? t('salesCycle.approvalOwnDocument')
      : pending && hint === 'noApproval'
        ? t('salesCycle.approvalNeeded')
        : pending
          ? t('salesCycle.approvalWhoHint')
          : null;

  const reservationLines: ReservationLine[] = order.lines.map((l) => ({
    itemId: l.itemId,
    label: codeAndName(l.item),
    qtyBase: l.qtyBase,
  }));

  return (
    <DocLayout
      title={t('salesCycle.orderTitle')}
      docNo={order.orderNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <OrderStatusTag status={order.status} />
          {pending && canApprove && (
            <Popconfirm title={t('salesCycle.confirmApprove')} onConfirm={() => approve.mutate()}>
              <Button type="primary" disabled={busy || hint !== 'ok'} loading={approve.isPending}>
                {t('salesCycle.approve')}
              </Button>
            </Popconfirm>
          )}
          {pending && canApprove && (
            <Button danger disabled={busy} onClick={() => setReasonAction('reject')}>
              {t('salesCycle.rejectApproval')}
            </Button>
          )}
          {canManage && (pending || order.status === 'CONFIRMED') && (
            <Button danger disabled={busy} onClick={() => setReasonAction('cancel')}>
              {t('procurement.cancel')}
            </Button>
          )}
          {canManage && (order.status === 'CONFIRMED' || order.status === 'PARTIALLY_INVOICED') && (
            <>
              <Button type="primary" disabled={busy} onClick={() => setInvoiceOpen(true)}>
                {t('salesCycle.createInvoice')}
              </Button>
              <Button disabled={busy} onClick={() => setReasonAction('close')}>
                {t('procurement.close')}
              </Button>
            </>
          )}
          <PrintPdfButton path={`/sales-orders/${order.id}/pdf`} />
        </>
      }
    >
      {approvalNote && <Alert type="info" showIcon message={approvalNote} />}
      {order.status === 'CANCELLED' && order.cancelReason && (
        <Alert type="warning" showIcon message={t('procurement.cancelledReason', { reason: order.cancelReason })} />
      )}
      {order.status === 'CLOSED' && order.closeReason && (
        <Alert type="info" showIcon message={t('salesCycle.closedReason', { reason: order.closeReason })} />
      )}
      {order.rejectReason && order.status === 'DRAFT' && (
        <Alert type="warning" showIcon message={t('salesCycle.lastApprovalRejection', { reason: order.rejectReason })} />
      )}
      <DocFields>
        <DocField label={t('sales.customer')}>
          <DocValue>{displayName(order.customer) ?? '—'}</DocValue>
        </DocField>
        <DocField label={t('sales.warehouse')}>
          <DocValue>{codeAndName(order.warehouse)}</DocValue>
        </DocField>
        <DocField label={t('salesCycle.orderDate')}>
          <DocValue>{dayjs(order.orderDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('salesCycle.expectedDate')}>
          <DocValue>{order.expectedDate ? dayjs(order.expectedDate).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        {order.quote && (
          <DocField label={t('salesCycle.fromQuote')}>
            <DocValue>
              <Link to={`/sales-quotes?quoteId=${order.quote.id}`}>{order.quote.quoteNo ?? `#${order.quote.id}`}</Link>
            </DocValue>
          </DocField>
        )}
        {order.paymentTermsDays !== null && (
          <DocField label={t('salesCycle.paymentTermsDays')}>
            <DocValue>{order.paymentTermsDays}</DocValue>
          </DocField>
        )}
        {order.costCenter && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{codeAndName(order.costCenter)}</DocValue>
          </DocField>
        )}
        {order.description && (
          <DocField label={t('salesCycle.description')} wide>
            <DocValue>{order.description}</DocValue>
          </DocField>
        )}
        <DocField label={t('sales.net')}>
          <DocValue>{amountCell(order.netTotal)}</DocValue>
        </DocField>
        <DocField label={t('sales.tax')}>
          <DocValue>{amountCell(order.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('sales.grandTotal')}>
          <DocValue>{amountCell(order.grandTotal)}</DocValue>
        </DocField>
      </DocFields>

      <Table<SalesCycleOrderLineViewDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={order.lines}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('procurement.item'), render: (_: unknown, l: SalesCycleOrderLineViewDto) => codeAndName(l.item) },
          // Ordered, invoiced and remaining are all in base units, so they add up across the line.
          { title: t('procurement.orderedQty'), dataIndex: 'qtyBase', width: 100, align: 'right' as const, render: qtyCell },
          {
            title: t('salesCycle.invoicedQty'),
            width: 100,
            align: 'right' as const,
            render: (_: unknown, l: SalesCycleOrderLineViewDto) =>
              qtyCell(remainingOf.get(l.id)?.invoicedQty ?? (confirmed ? l.invoicedQty : null)),
          },
          {
            title: t('salesCycle.remainingQty'),
            width: 100,
            align: 'right' as const,
            render: (_: unknown, l: SalesCycleOrderLineViewDto) => qtyCell(remainingOf.get(l.id)?.remainingBase ?? null),
          },
          { title: t('procurement.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('procurement.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('procurement.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('procurement.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('procurement.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
       scroll={{ x: 'max-content' }}/>

      <ReservationPanel warehouseId={order.warehouseId} lines={reservationLines} checkStock={pending} />

      {/* The order's own invoices are reached from the invoice screen, which links back here. */}
      <OrderInvoiceModal
        order={order}
        open={invoiceOpen}
        onClose={() => setInvoiceOpen(false)}
        onCreated={(invoiceId) => {
          setInvoiceOpen(false);
          navigate(`/sales?invoiceId=${invoiceId}`);
        }}
      />

      {reasonAction && (
        <ReasonModal
          title={t(reasonTitle)}
          okText={t(reasonAction === 'reject' ? 'salesCycle.rejectApproval' : reasonAction === 'cancel' ? 'procurement.cancel' : 'procurement.close')}
          busy={reasonBusy}
          onClose={() => setReasonAction(null)}
          onConfirm={(reason) => {
            if (reasonAction === 'reject') rejectApproval.mutate(reason);
            else if (reasonAction === 'cancel') cancel.mutate(reason);
            else close.mutate(reason);
          }}
        />
      )}
    </DocLayout>
  );
}
