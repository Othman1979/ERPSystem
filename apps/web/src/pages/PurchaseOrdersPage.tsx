import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Input, InputNumber, Modal, Popconfirm, Select, Table, Typography, message } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import type { TFunction } from 'i18next';
import {
  ApiError,
  catalogControllerGetItem,
  catalogControllerListItems,
  goodsNotesControllerList,
  partiesControllerList,
  procurementControllerApproveOrder,
  procurementControllerCancelOrder,
  procurementControllerCloseOrder,
  procurementControllerCreateOrder,
  procurementControllerDeleteOrder,
  procurementControllerGetOrder,
  procurementControllerGetRequest,
  procurementControllerListOrders,
  procurementControllerRejectOrder,
  procurementControllerSubmitOrder,
  procurementControllerUpdateOrder,
  purchasesControllerListInvoices,
  warehousesControllerList,
  type GoodsNoteListItemDto,
  type ItemListItemDto,
  type ProcurementControllerListOrdersSort,
  type ProcurementControllerListOrdersStatus,
  type ProcurementItemRefDto,
  type PurchaseOrderDetailDto,
  type PurchaseInvoiceListItemDto,
  type PurchaseOrderLineViewDto,
  type PurchaseOrderListItemDto,
  type PurchaseOrderStatus,
  type PurchaseRequestDetailDto,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { ListToolbar } from '../components/ListToolbar';
import { RemoteSelect, PICKER_PAGE_SIZE } from '../components/RemoteSelect';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { GridSelect, enterTo, focusNamedField } from '../components/GridSelect';
import { GridHint } from '../components/GridHint';
import { cellLabel } from '../components/gridA11y';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { useCostCenters } from '../hooks/useCostCenters';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { useNewFromUrl } from '../useNewFromUrl';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import {
  approvalHint,
  isAuthoredBy,
  missingPriceLines,
  purchaseOrderBody,
  purchaseOrderUpdateBody,
  type PurchaseOrderForm,
  type PurchaseOrderFormLine,
} from './procurement/orderPayload';
import { invalidateProcurement, procurementKeys } from './procurement/queryKeys';
import { ReceiveOrderModal } from './procurement/ReceiveOrderModal';
import { BillOrderModal } from './procurement/BillOrderModal';

// ------------------------------------------------------------------ types

/** What the page shows: the list, a new order (optionally from a request), or one saved order. */
type Screen =
  | { kind: 'list' }
  | { kind: 'new'; requestId?: string }
  | { kind: 'order'; id: string };

/** An item as the item picker holds it: a search result, or a line of an order or request. */
type ItemRow = Pick<ItemListItemDto, 'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'purchasePrice'>;

/** An editable line; `key` only identifies the row while it is on screen. */
interface OrderLineDraft extends PurchaseOrderFormLine {
  key: number;
}

// ------------------------------------------------------------------ constants

const STATUSES: PurchaseOrderStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED',
  'CANCELLED',
];

const STATUS_TONE: Record<PurchaseOrderStatus, StatusTone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  APPROVED: 'success',
  PARTIALLY_RECEIVED: 'warning',
  RECEIVED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

/** Statuses in which goods can still be received against the order (ADR-026). */
const RECEIVABLE: PurchaseOrderStatus[] = ['APPROVED', 'PARTIALLY_RECEIVED'];

/** Statuses in which an invoice can be billed from the order's receipts (ADR-026). */
const BILLABLE: PurchaseOrderStatus[] = ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

/** Unit choice of a line meaning the item's base unit (sent as no unit id). */
const BASE_UNIT = 'base';

/** Role code of the owner: the owner approves every order (ADR-024 §3). */
const OWNER_ROLE = 'OWNER';

// ------------------------------------------------------------------ helpers

/** Message for a failed request: the API's code when it has one. */
function errorText(t: TFunction, err: unknown): string {
  return err instanceof ApiError
    ? t(`errors.${err.code}`, { defaultValue: err.message })
    : t('errors.INTERNAL');
}

/** Item picker row for a line's item (the picker's search may not return it). */
function itemRowOf(item: ProcurementItemRefDto): ItemRow {
  return {
    id: item.id,
    code: item.code,
    nameAr: item.nameAr,
    nameEn: item.nameEn,
    itemKind: item.itemKind,
    purchasePrice: null,
  };
}

/** Warehouses (a small reference list; the same query key as the purchase invoices). */
function useWarehouses() {
  return useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
}

/** Lines of a saved order, or the approved request's open lines for a new order, or two empty lines. */
function initialLines(order?: PurchaseOrderDetailDto, request?: PurchaseRequestDetailDto): OrderLineDraft[] {
  if (order?.lines.length) {
    return order.lines.map((l, i) => ({
      key: i + 1,
      itemId: l.itemId,
      itemUnitId: l.itemUnitId ?? undefined,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      requestLineId: l.requestLineId ?? undefined,
    }));
  }
  // A new order from a request: one line per request line that still has quantity left.
  const open = (request?.lines ?? []).filter((l) => dec(l.remainingQty).gt(0));
  if (open.length) {
    return open.map((l, i) => ({
      key: i + 1,
      itemId: l.itemId,
      itemUnitId: l.itemUnitId ?? undefined,
      qty: l.remainingQty,
      unitPrice: l.estimatedPrice ?? undefined,
      requestLineId: l.id,
    }));
  }
  return [{ key: 1 }, { key: 2 }];
}

// ------------------------------------------------------------------ page

export function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // The requests page links here with ?requestId=...: a new order from that approved request.
  const requestIdParam = params.get('requestId');
  const [screen, setScreen] = useState<Screen>(() =>
    requestIdParam ? { kind: 'new', requestId: requestIdParam } : { kind: 'list' },
  );
  // Drop the flag from the address, so a refresh or Back does not reopen the form.
  useEffect(() => {
    if (!requestIdParam) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('requestId');
        return next;
      },
      { replace: true },
    );
  }, [requestIdParam, setParams]);
  useNewFromUrl(() => setScreen({ kind: 'new' }));

  return (
    <div>
      <PageHeader title={t('nav.purchaseOrders')} />
      {screen.kind === 'list' ? (
        <OrdersList
          onOpen={(id) => setScreen({ kind: 'order', id })}
          onNew={() => setScreen({ kind: 'new' })}
        />
      ) : (
        <OrderScreen
          key={screen.kind === 'order' ? `order-${screen.id}` : 'new'}
          id={screen.kind === 'order' ? screen.id : undefined}
          requestId={screen.kind === 'new' ? screen.requestId : undefined}
          onBack={() => setScreen({ kind: 'list' })}
          onSaved={(id) => setScreen({ kind: 'order', id })}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ list

function OrdersList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [statusFilter, setStatusFilter] = useState<PurchaseOrderStatus | undefined>(undefined);

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    PurchaseOrderListItemDto,
    { status?: ProcurementControllerListOrdersStatus },
    ProcurementControllerListOrdersSort
  >({
    key: procurementKeys.orderList(),
    // The generated list type still names the first four statuses; the API filters by all seven (ADR-026).
    filters: { status: statusFilter as ProcurementControllerListOrdersStatus | undefined },
    defaultSort: '-orderDate',
    fetch: (params, signal) => procurementControllerListOrders(params, { signal }).then((r) => r.data),
  });

  const columns = [
    {
      title: t('procurement.orderNo'),
      dataIndex: 'orderNo',
      key: 'orderNo',
      sorter: true,
      sortOrder: list.sortOrderOf('orderNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('procurement.orderDate'),
      dataIndex: 'orderDate',
      key: 'orderDate',
      sorter: true,
      sortOrder: list.sortOrderOf('orderDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('procurement.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseOrderListItemDto) => displayName(r.supplier) ?? '—',
    },
    {
      title: t('procurement.requestNo'),
      dataIndex: 'request',
      width: 130,
      render: (_: unknown, r: PurchaseOrderListItemDto) => r.request?.requestNo ?? '—',
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 130,
      render: (v: PurchaseOrderStatus) => (
        <StatusTag tone={STATUS_TONE[v]}>{t(`procurement.statuses.${v}`)}</StatusTag>
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
  ];

  return (
    <div>
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        filters={
          <Select
            allowClear
            placeholder={t('common.status')}
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`procurement.statuses.${s}`) }))}
          />
        }
        count={list.total}
        actions={
          can(PERMISSIONS.PURCHASE_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
              {t('procurement.newOrder')}
            </Button>
          )
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
        onRow={(r) => ({ onClick: () => onOpen(r.id), style: { cursor: 'pointer' } })}
      />
    </div>
  );
}

// ------------------------------------------------------------------ screen router

/**
 * Loads the order (or the request a new order comes from), then shows the
 * editor for a new order or a draft, and the read-only view for any other status.
 */
function OrderScreen({
  id,
  requestId,
  onBack,
  onSaved,
}: {
  id?: string;
  requestId?: string;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PURCHASE_MANAGE);

  const detail = useQuery({
    queryKey: procurementKeys.order(id),
    queryFn: ({ signal }) => procurementControllerGetOrder(id!, { signal }).then((r) => r.data),
    enabled: !!id,
  });
  const request = useQuery({
    queryKey: procurementKeys.request(requestId),
    queryFn: ({ signal }) => procurementControllerGetRequest(requestId!, { signal }).then((r) => r.data),
    enabled: !id && !!requestId,
  });

  const failed = (id && detail.isError) || (requestId && request.isError);
  if (failed) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  const loading = (id && detail.isPending) || (requestId && !id && request.isPending);
  if (loading) return <Typography.Text>{t('common.loading')}</Typography.Text>;

  const order = detail.data;
  // Only a draft is edited; a new order is always an editor.
  if (order && (order.status !== 'DRAFT' || !canManage)) {
    return <OrderView order={order} onBack={onBack} />;
  }
  return (
    <OrderEditor
      order={order}
      request={request.data}
      onBack={onBack}
      onSaved={onSaved}
      onDeleted={onBack}
    />
  );
}

// ------------------------------------------------------------------ editor

function OrderEditor({
  order,
  request,
  onBack,
  onSaved,
  onDeleted,
}: {
  order?: PurchaseOrderDetailDto;
  request?: PurchaseRequestDetailDto;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const canManage = can(PERMISSIONS.PURCHASE_MANAGE);
  const costCenters = useCostCenters();
  const warehouses = useWarehouses();
  const isNew = !order;
  // Keyboard entry starts at the first field the user must fill.
  useEffect(() => {
    const id = requestAnimationFrame(() => focusNamedField('supplier'));
    return () => cancelAnimationFrame(id);
  }, []);

  const [orderDate, setOrderDate] = useState<Dayjs>(order ? dayjs(order.orderDate) : dayjs());
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(
    order?.expectedDate ? dayjs(order.expectedDate) : null,
  );
  const [supplierId, setSupplierId] = useState<string | undefined>(order?.supplierId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(order?.warehouseId);
  const [costCenterId, setCostCenterId] = useState<string | undefined>(order?.costCenterId ?? undefined);
  const [notes, setNotes] = useState<string>(order?.notes ?? '');
  const [lines, setLines] = useState<OrderLineDraft[]>(() => initialLines(order, request));
  const lineSeq = useRef(lines.length);

  // Items are searched on the server; the lines' own items stay labelled.
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
    const rows: ItemRow[] = [];
    for (const l of order?.lines ?? []) rows.push(itemRowOf(l.item));
    for (const l of request?.lines ?? []) rows.push(itemRowOf(l.item));
    rememberItems(rows);
  }, [order, request, rememberItems]);
  const itemOptions = items
    .withSelected(lines.map((l) => l.itemId))
    .map((row) => ({ value: row.id, label: codeAndName(row) }));

  const linkedRequest = order ? order.request : request ? { requestNo: request.requestNo } : null;

  // ---- saving

  const onError = (err: unknown) => apiMessage.error(errorText(t, err));

  /** Creates the order, or updates the saved draft; returns its id. */
  const persist = async (): Promise<string> => {
    if (!supplierId || !warehouseId) throw new Error('supplier and warehouse are required');
    const input: PurchaseOrderForm = {
      orderDate: orderDate.format('YYYY-MM-DD'),
      expectedDate: expectedDate?.format('YYYY-MM-DD'),
      supplierId,
      warehouseId,
      // A draft keeps its centre while centres are off (ADR-024 §1.6): hidden, still sent.
      costCenterId,
      notes,
      // The request an order is raised from is set at creation only.
      requestId: order ? undefined : request?.id,
    };
    if (!order) {
      const res = await procurementControllerCreateOrder(purchaseOrderBody(input, lines));
      return res.data.id;
    }
    await procurementControllerUpdateOrder(order.id, purchaseOrderUpdateBody(input, lines));
    return order.id;
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      void invalidateProcurement(queryClient);
      onSaved(id);
    },
    onError,
  });

  // Submit saves the draft first, so the submitted order is the one on screen.
  const submit = useMutation({
    mutationFn: async () => {
      const id = await persist();
      await procurementControllerSubmitOrder(id, { headers: idemHeaders() });
      return id;
    },
    onSuccess: (id) => {
      apiMessage.success(t('procurement.submitted'));
      void invalidateProcurement(queryClient);
      onSaved(id);
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => {
      if (!order) throw new Error('no order to delete');
      return procurementControllerDeleteOrder(order.id);
    },
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateProcurement(queryClient);
      onDeleted();
    },
    onError,
  });

  const busy = save.isPending || submit.isPending || remove.isPending;

  // Save stays enabled: an attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  // Rows of lines with an item and no unit price (never sent as zero).
  const priceGaps = missingPriceLines(lines);
  const missing = {
    supplier: !supplierId,
    warehouse: !warehouseId,
    lines: !lines.some((l) => l.itemId && l.qty),
    prices: priceGaps.length > 0,
  };
  /** True when the form may be sent; otherwise marks what is missing. */
  const checkForm = (): boolean => {
    if (busy) return false;
    if (missing.supplier || missing.warehouse || missing.lines || missing.prices) {
      setTried(true);
      if (missing.supplier) focusNamedField('supplier');
      else if (missing.warehouse) focusNamedField('warehouse');
      else if (missing.lines) apiMessage.warning(t('stock.minLines'));
      else apiMessage.warning(t('procurement.ordersUi.priceRequired'));
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (canManage && checkForm()) save.mutate();
  };
  const submitOrder = () => {
    if (canManage && checkForm()) submit.mutate();
  };
  useDocShortcuts({ onSave: saveDraft });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);

  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }));

  return (
    <DocLayout
      title={isNew ? t('procurement.newOrder') : t('procurement.orderTitle')}
      docNo={order ? (order.orderNo ?? t('procurement.draftNo')) : undefined}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          {canManage && (
            <>
              <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={saveDraft}>
                {isNew ? t('common.saveDraft') : t('common.save')}
                <span className="doc-kbd">Ctrl+S</span>
              </Button>
              {order && (
                <>
                  <Popconfirm title={t('procurement.confirmSubmit')} onConfirm={submitOrder}>
                    <Button loading={submit.isPending}>{t('procurement.submit')}</Button>
                  </Popconfirm>
                  <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate()}>
                    <Button
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={t('common.delete')}
                      loading={remove.isPending}
                    />
                  </Popconfirm>
                </>
              )}
            </>
          )}
          {order && <PrintPdfButton path={`/purchase-orders/${order.id}/pdf`} />}
        </>
      }
    >
      {order?.rejectReason && (
        <Alert type="warning" showIcon message={t('procurement.lastRejection', { reason: order.rejectReason })} />
      )}
      <DocFields>
        <DocField
          field="supplier"
          label={t('procurement.supplier')}
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
              ).then((r) => r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })))
            }
            selected={
              order?.supplier ? { value: order.supplier.id, label: codeAndName(order.supplier) } : undefined
            }
            status={requiredError(missing.supplier) ? 'error' : undefined}
            value={supplierId}
            onChange={setSupplierId}
          />
        </DocField>
        <DocField
          field="warehouse"
          label={t('procurement.warehouse')}
          required
          error={requiredError(missing.warehouse)}
          onKeyDown={enterTo(() => focusNamedField('orderDate'))}
        >
          <GridSelect
            enterOpens
            status={requiredError(missing.warehouse) ? 'error' : undefined}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </DocField>
        <DocField field="orderDate" label={t('procurement.orderDate')}>
          <DatePicker value={orderDate} onChange={(d) => d && setOrderDate(d)} />
        </DocField>
        <DocField field="expectedDate" label={t('procurement.expectedDate')}>
          <DatePicker value={expectedDate} onChange={setExpectedDate} allowClear />
        </DocField>
        {linkedRequest && (
          <DocField label={t('procurement.request')}>
            <DocValue>{linkedRequest.requestNo ?? '—'}</DocValue>
          </DocField>
        )}
        {costCenters.enabled && (
          <DocField field="costCenter" label={<CostCenterLabel />}>
            <CostCenterSelect enterOpens rows={costCenters.rows} value={costCenterId} onChange={setCostCenterId} />
          </DocField>
        )}
        <DocField field="notes" label={t('procurement.notes')} wide>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>
      <Typography.Text type="secondary">{t('procurement.noEffectHint')}</Typography.Text>

      <OrderLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
        priceOf={(itemId) => items.byId(itemId)?.purchasePrice ?? undefined}
        nextKey={() => {
          lineSeq.current += 1;
          return lineSeq.current;
        }}
        lineError={tried && missing.lines ? t('common.requiredField') : undefined}
        priceGaps={new Set(tried ? priceGaps : [])}
      />
    </DocLayout>
  );
}

// ------------------------------------------------------------------ lines grid

/**
 * Lines of an order: item, unit, qty, unit price and discount % as inputs.
 * Tax and totals come from the server (the item's tax category, ADR-017).
 */
function OrderLinesGrid({
  lines,
  onChange,
  itemOptions,
  onItemSearch,
  priceOf,
  nextKey,
  lineError,
  priceGaps,
}: {
  lines: OrderLineDraft[];
  onChange: (lines: OrderLineDraft[]) => void;
  itemOptions: { value: string; label: string }[];
  onItemSearch: (text: string) => void;
  /** Default unit price of an item, used when the line has none yet. */
  priceOf: (itemId: string) => string | undefined;
  nextKey: () => number;
  lineError?: string;
  /** Row indexes whose unit price is missing; marked as errors. */
  priceGaps: ReadonlySet<number>;
}) {
  const { t } = useTranslation();

  const update = (key: number, patch: Partial<OrderLineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const pickItem = (key: number, line: OrderLineDraft, itemId: string) =>
    update(key, {
      itemId,
      // A unit belongs to one item: a new item starts on its base unit.
      itemUnitId: undefined,
      unitPrice: line.unitPrice?.trim() ? line.unitPrice : (priceOf(itemId) ?? null),
    });

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length >= 1 ? next : [{ key: nextKey() }]);
  };

  return (
    <div className="entry-grid-frame">
      <div className="entry-grid-scroll">
        <table className="entry-grid">
          <thead>
            <tr>
              <th className="row-no">#</th>
              <th>{t('procurement.item')}</th>
              <th style={{ width: 120 }}>{t('procurement.unit')}</th>
              <th className="num-cell" style={{ width: 110 }}>{t('procurement.qty')}</th>
              <th className="num-cell" style={{ width: 120 }}>{t('procurement.unitPrice')}</th>
              <th className="num-cell" style={{ width: 100 }}>{t('procurement.discountPct')}</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, row) => (
              <tr key={l.key}>
                <td className="row-no">{row + 1}</td>
                <td>
                  <GridSelect
                    aria-label={cellLabel(t, t('procurement.item'), row)}
                    variant="borderless"
                    placeholder={t('procurement.item')}
                    options={itemOptions}
                    onRemoteSearch={onItemSearch}
                    value={l.itemId}
                    onChange={(v: string) => pickItem(l.key, l, v)}
                    style={{ width: '100%' }}
                    size="small"
                  />
                </td>
                <td>
                  <UnitCell
                    itemId={l.itemId}
                    value={l.itemUnitId}
                    label={cellLabel(t, t('procurement.unit'), row)}
                    onChange={(itemUnitId) => update(l.key, { itemUnitId })}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.qty'), row)}
                    variant="borderless"
                    stringMode
                    min="0.000001"
                    placeholder={t('procurement.qty')}
                    value={l.qty}
                    onChange={(v) => update(l.key, { qty: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.unitPrice'), row)}
                    variant="borderless"
                    stringMode
                    min="0"
                    status={priceGaps.has(row) ? 'error' : undefined}
                    placeholder={t('procurement.unitPrice')}
                    value={l.unitPrice}
                    onChange={(v) => update(l.key, { unitPrice: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell">
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.discountPct'), row)}
                    variant="borderless"
                    stringMode
                    min="0"
                    max="100"
                    placeholder={t('procurement.discountPct')}
                    value={l.discountPct}
                    onChange={(v) => update(l.key, { discountPct: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <Button
                    className="row-del"
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('common.delete')}
                    onClick={() => remove(l.key)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="entry-grid-footer">
        <Button
          type="link"
          icon={<PlusOutlined />}
          onClick={() => onChange([...lines, { key: nextKey() }])}
        >
          {t('common.add')}
        </Button>
        {lineError && <Typography.Text type="danger">{lineError}</Typography.Text>}
        <GridHint lineCount={lines.filter((l) => l.itemId).length} />
      </div>
    </div>
  );
}

/** Unit of a line: the item's base unit, or one of its own units. Needs the item, so it loads it. */
function UnitCell({
  itemId,
  value,
  label,
  onChange,
}: {
  itemId?: string;
  value?: string;
  label: string;
  onChange: (itemUnitId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['items', 'detail', itemId],
    queryFn: ({ signal }) => catalogControllerGetItem(itemId!, { signal }).then((r) => r.data),
    enabled: !!itemId,
  });
  const options = item.data
    ? [
        { value: BASE_UNIT, label: codeAndName(item.data.baseUnit) },
        ...item.data.units
          .filter((u) => u.isActive)
          .map((u) => ({ value: u.id, label: codeAndName(u.unit) })),
      ]
    : [];
  return (
    <GridSelect
      aria-label={label}
      variant="borderless"
      placeholder={t('procurement.unit')}
      disabled={!itemId}
      options={options}
      value={itemId ? (value ?? BASE_UNIT) : undefined}
      onChange={(v: string) => onChange(v === BASE_UNIT ? undefined : v)}
      style={{ width: '100%' }}
      size="small"
    />
  );
}

// ------------------------------------------------------------------ view

/** Read-only view of an order that is not a draft: totals come from the server. */
function OrderView({ order, onBack }: { order: PurchaseOrderDetailDto; onBack: () => void }) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const costCenters = useCostCenters();
  const [reasonAction, setReasonAction] = useState<'reject' | 'cancel' | 'close' | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [billOpen, setBillOpen] = useState(false);
  const canApprove = can(PERMISSIONS.PURCHASE_APPROVE);
  const canManage = can(PERMISSIONS.PURCHASE_MANAGE);
  const canReceive = can(PERMISSIONS.STOCK_MOVEMENT);
  const membership = me?.currentMembership ?? null;
  const submitted = order.status === 'SUBMITTED';
  // Receipts and invoices exist only once the order is approved (ADR-026).
  const beyondApproval = order.status !== 'DRAFT' && order.status !== 'SUBMITTED';

  const hint = approvalHint({
    isOwner: membership?.roleCode === OWNER_ROLE,
    canApprove,
    approvalLimit: membership?.approvalLimit,
    grandTotal: order.grandTotal,
    authoredByMe: isAuthoredBy(order, me?.user.id),
  });
  const hintText =
    submitted && hint === 'needsOwner'
      ? t('procurement.needsOwner')
      : submitted && hint === 'ownDocument'
        ? t('procurement.ownDocument')
        : submitted && hint === 'noApproval'
          ? t('procurement.noApproval')
          : null;

  const onError = (err: unknown) => apiMessage.error(errorText(t, err));

  const approveMut = useMutation({
    mutationFn: () => procurementControllerApproveOrder(order.id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('procurement.approved'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const rejectMut = useMutation({
    mutationFn: (reason: string) =>
      procurementControllerRejectOrder(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('procurement.rejected'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const cancelMut = useMutation({
    mutationFn: (reason: string) =>
      procurementControllerCancelOrder(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('procurement.cancelled'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const closeMut = useMutation({
    mutationFn: (reason: string) =>
      procurementControllerCloseOrder(order.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('procurement.closed'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const busy = approveMut.isPending || rejectMut.isPending || cancelMut.isPending || closeMut.isPending;

  return (
    <DocLayout
      title={t('procurement.orderTitle')}
      docNo={order.orderNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <StatusTag tone={STATUS_TONE[order.status]}>{t(`procurement.statuses.${order.status}`)}</StatusTag>
          {submitted && canApprove && (
            <>
              <Popconfirm title={t('procurement.confirmApprove')} onConfirm={() => approveMut.mutate()}>
                <Button type="primary" disabled={hint !== 'ok' || busy} loading={approveMut.isPending}>
                  {t('procurement.approve')}
                </Button>
              </Popconfirm>
              {/* Rejecting is allowed on one's own order; only approving is not (APPROVAL_SELF_NOT_ALLOWED). */}
              <Button danger disabled={busy} onClick={() => setReasonAction('reject')}>
                {t('procurement.reject')}
              </Button>
            </>
          )}
          {canManage && (submitted || order.status === 'APPROVED') && (
            <Button disabled={busy} onClick={() => setReasonAction('cancel')}>
              {t('procurement.cancel')}
            </Button>
          )}
          {canReceive && RECEIVABLE.includes(order.status) && (
            <Button type="primary" disabled={busy} onClick={() => setReceiveOpen(true)}>
              {t('procurement.receiveGoods')}
            </Button>
          )}
          {canManage && RECEIVABLE.includes(order.status) && (
            <Button disabled={busy} onClick={() => setReasonAction('close')}>
              {t('procurement.close')}
            </Button>
          )}
          {canManage && BILLABLE.includes(order.status) && (
            <Button disabled={busy} onClick={() => setBillOpen(true)}>
              {t('procurement.billOrderButton')}
            </Button>
          )}
          <PrintPdfButton path={`/purchase-orders/${order.id}/pdf`} />
        </>
      }
    >
      <DocFields>
        <DocField label={t('procurement.supplier')}>
          <DocValue>{displayName(order.supplier)}</DocValue>
        </DocField>
        <DocField label={t('procurement.warehouse')}>
          <DocValue>{codeAndName(order.warehouse)}</DocValue>
        </DocField>
        <DocField label={t('procurement.orderDate')}>
          <DocValue>{dayjs(order.orderDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('procurement.expectedDate')}>
          <DocValue>{order.expectedDate ? dayjs(order.expectedDate).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        {order.request && (
          <DocField label={t('procurement.request')}>
            <DocValue>{order.request.requestNo ?? '—'}</DocValue>
          </DocField>
        )}
        {costCenters.enabled && order.costCenterId && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{costCenters.nameOf(order.costCenterId)}</DocValue>
          </DocField>
        )}
        {order.notes && (
          <DocField label={t('procurement.notes')} wide>
            <DocValue>{order.notes}</DocValue>
          </DocField>
        )}
        <DocField label={t('procurement.net')}>
          <DocValue>{amountCell(order.netTotal)}</DocValue>
        </DocField>
        <DocField label={t('procurement.tax')}>
          <DocValue>{amountCell(order.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('procurement.total')}>
          <DocValue>{amountCell(order.grandTotal)}</DocValue>
        </DocField>
      </DocFields>

      {hintText && <Alert type="info" showIcon message={hintText} />}
      {submitted && canApprove && membership?.approvalLimit && (
        <Typography.Text type="secondary">
          {t('procurement.approvalLimit', { limit: formatAmount(membership.approvalLimit) })}
        </Typography.Text>
      )}
      {order.status === 'CANCELLED' && order.cancelReason && (
        <Alert type="warning" showIcon message={t('procurement.cancelledReason', { reason: order.cancelReason })} />
      )}
      {order.status === 'CLOSED' && order.closeReason && (
        <Alert type="info" showIcon message={t('procurement.closedReason', { reason: order.closeReason })} />
      )}

      <Table<PurchaseOrderLineViewDto>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={order.lines ?? []}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          {
            title: t('procurement.item'),
            render: (_: unknown, l: PurchaseOrderLineViewDto) => codeAndName(l.item) ?? l.itemId,
          },
          {
            title: t('procurement.unit'),
            width: 110,
            render: (_: unknown, l: PurchaseOrderLineViewDto) =>
              codeAndName(l.itemUnit?.unit) ?? '—',
          },
          { title: t('procurement.qty'), dataIndex: 'qty', width: 90, align: 'right' as const, render: qtyCell },
          ...(beyondApproval
            ? [{ title: t('procurement.receivedQty'), dataIndex: 'receivedQty', width: 100, align: 'right' as const, render: qtyCell }]
            : []),
          { title: t('procurement.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('procurement.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('procurement.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('procurement.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('procurement.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
      />

      {beyondApproval && <OrderDocuments orderId={order.id} />}

      {receiveOpen && (
        <ReceiveOrderModal
          order={order}
          open
          onClose={() => setReceiveOpen(false)}
          onDone={() => setReceiveOpen(false)}
        />
      )}
      <BillOrderModal
        order={order}
        open={billOpen}
        onClose={() => setBillOpen(false)}
        onBilled={() => {
          setBillOpen(false);
          apiMessage.success(t('procurement.orderBilledToast'));
          void invalidateProcurement(queryClient);
        }}
      />

      {reasonAction && (
        <ReasonModal
          title={t(
            reasonAction === 'reject'
              ? 'procurement.rejectTitle'
              : reasonAction === 'cancel'
                ? 'procurement.cancelTitle'
                : 'procurement.closeTitle',
          )}
          okText={t(reasonAction === 'reject' ? 'procurement.reject' : 'procurement.close')}
          busy={
            reasonAction === 'reject'
              ? rejectMut.isPending
              : reasonAction === 'cancel'
                ? cancelMut.isPending
                : closeMut.isPending
          }
          onClose={() => setReasonAction(null)}
          onConfirm={(reason) => {
            if (reasonAction === 'reject') rejectMut.mutate(reason);
            else if (reasonAction === 'cancel') cancelMut.mutate(reason);
            else closeMut.mutate(reason);
          }}
        />
      )}
    </DocLayout>
  );
}

/**
 * Receipts (goods receipt notes) and purchase invoices raised against an order.
 * Shown once the order has left approval; the lists are server-filtered by order.
 */
function OrderDocuments({ orderId }: { orderId: string }) {
  const { t } = useTranslation();
  const receipts = useQuery({
    queryKey: [...procurementKeys.order(orderId), 'receipts'],
    queryFn: ({ signal }) =>
      goodsNotesControllerList({ purchaseOrderId: orderId, page: 1, pageSize: 50 }, { signal }).then((r) => r.data),
  });
  const invoices = useQuery({
    queryKey: [...procurementKeys.order(orderId), 'invoices'],
    queryFn: ({ signal }) =>
      purchasesControllerListInvoices({ purchaseOrderId: orderId, page: 1, pageSize: 50 }, { signal }).then(
        (r) => r.data,
      ),
  });
  const docDate = (v: string) => dayjs(v).format('YYYY-MM-DD');
  const docStatus = (v: string) => (
    <StatusTag tone={v === 'POSTED' ? 'success' : 'neutral'}>
      {v === 'POSTED' ? t('common.posted') : t('common.draft')}
    </StatusTag>
  );
  return (
    <section style={{ marginTop: 16 }}>
      <Typography.Title level={5}>{t('procurement.receiptsAndInvoices')}</Typography.Title>
      <Typography.Text strong>{t('procurement.receipts')}</Typography.Text>
      <Table<GoodsNoteListItemDto>
        rowKey="id"
        size="small"
        pagination={false}
        loading={receipts.isLoading}
        locale={tableLocale(receipts)}
        dataSource={receipts.data?.items ?? []}
        columns={[
          { title: t('procurement.docNo'), dataIndex: 'docNo', render: (v: string | null) => v ?? t('procurement.draftNo') },
          { title: t('procurement.docDate'), dataIndex: 'noteDate', width: 120, render: docDate },
          { title: t('common.status'), dataIndex: 'status', width: 120, render: docStatus },
        ]}
      />
      <Typography.Text strong style={{ display: 'block', marginTop: 12 }}>
        {t('procurement.purchaseInvoices')}
      </Typography.Text>
      <Table<PurchaseInvoiceListItemDto>
        rowKey="id"
        size="small"
        pagination={false}
        loading={invoices.isLoading}
        locale={tableLocale(invoices)}
        dataSource={invoices.data?.items ?? []}
        columns={[
          { title: t('procurement.docNo'), dataIndex: 'invoiceNo', render: (v: string | null) => v ?? t('procurement.draftNo') },
          { title: t('procurement.docDate'), dataIndex: 'invoiceDate', width: 120, render: docDate },
          { title: t('common.status'), dataIndex: 'status', width: 120, render: docStatus },
        ]}
      />
    </section>
  );
}

/** Asks for the reason of a rejection or a cancellation; the reason is required. */
function ReasonModal({
  title,
  okText,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  okText: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const blank = reason.trim() === '';
  return (
    <Modal
      open
      title={title}
      okText={okText}
      cancelText={t('common.cancel')}
      confirmLoading={busy}
      onCancel={onClose}
      onOk={() => {
        setTried(true);
        if (!blank) onConfirm(reason.trim());
      }}
    >
      <Input.TextArea
        aria-label={t('procurement.reason')}
        autoSize={{ minRows: 3, maxRows: 6 }}
        maxLength={500}
        value={reason}
        status={tried && blank ? 'error' : undefined}
        onChange={(e) => setReason(e.target.value)}
      />
      {tried && blank && <Typography.Text type="danger">{t('procurement.reasonRequired')}</Typography.Text>}
    </Modal>
  );
}
