import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InfoCircleOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Checkbox,
  DatePicker,
  Form,
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
import dayjs, { type Dayjs } from 'dayjs';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import {
  ApiError,
  catalogControllerListItems,
  stockDocumentsControllerApproveCount,
  stockDocumentsControllerCreateAdjustment,
  stockDocumentsControllerCreateCount,
  stockDocumentsControllerCreateTransfer,
  stockDocumentsControllerDeleteAdjustment,
  stockDocumentsControllerDeleteCount,
  stockDocumentsControllerDeleteTransfer,
  stockDocumentsControllerGetCount,
  stockDocumentsControllerListAdjustments,
  stockDocumentsControllerListCounts,
  stockDocumentsControllerListTransfers,
  stockDocumentsControllerPostAdjustment,
  stockDocumentsControllerPostTransfer,
  stockDocumentsControllerReverseAdjustment,
  stockDocumentsControllerReverseTransfer,
  stockDocumentsControllerUpdateCountLine,
  stockReportsControllerBalances,
  stockReportsControllerMovements,
  stockReportsControllerValuation,
  warehousesControllerList,
} from '@erp/api-client';
import type {
  CreateStockAdjustmentDtoAdjustmentType,
  ItemListItemDto,
  StockAdjustmentListItemDto,
  StockCountDetailDto,
  StockCountLineDto,
  StockCountListItemDto,
  StockReportMovementDto,
  StockTransferListItemDto,
  StockDocumentsControllerListAdjustmentsSort,
  StockDocumentsControllerListCountsSort,
  StockDocumentsControllerListTransfersSort,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { GoodsNotesSection } from './GoodsNotesPage';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ListToolbar } from '../components/ListToolbar';
import { LoadMore } from '../components/LoadMore';
import { RemoteSelect } from '../components/RemoteSelect';
import { useKeysetQuery } from '../hooks/useKeysetQuery';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import { ExportButtons } from '../components/ExportButtons';
import {
  emptyItemLine,
  ItemLinesGrid,
  type ItemLineDraft,
} from '../components/ItemLinesGrid';
import { codeAndName, displayName, type Named } from '../i18n/displayName';
import { Num } from '../components/Num';
import { EnterNav } from '../components/EnterNav';
import { GridSelect } from '../components/GridSelect';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { formatAmount, formatQty } from '../format/number';
import { invalidateStock } from '../stockQueries';

type ItemOpt = ItemListItemDto;
type AdjustmentRow = StockAdjustmentListItemDto;
type TransferRow = StockTransferListItemDto;
type CountRow = StockCountListItemDto;
type MovementRow = StockReportMovementDto;
type CountLine = StockCountLineDto;
type CountDetail = StockCountDetailDto;

function useApiMessage() {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const show = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  const ok = (key: string) => apiMessage.success(t(key));
  return { apiMessage, contextHolder, show, ok };
}

function useLookups() {
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const whOptions = (warehouses.data ?? [])
    .filter((w) => w.isActive)
    .map((w) => ({ value: w.id, label: codeAndName(w) }));
  // Report rows only carry the warehouse code; show "code — name" instead.
  const warehouseLabel = (code: string) =>
    codeAndName((warehouses.data ?? []).find((w) => w.code === code)) ?? code;
  return { warehouses, whOptions, warehouseLabel };
}

/**
 * Stock items for the document grids: searched on the server as the user
 * types, never the whole catalogue (ADR-022 §8). Chosen rows stay labelled.
 */
function useStockItemPicker(enabled: boolean) {
  return useRemoteOptions<ItemOpt>({
    key: ['items', 'pick', { itemKind: 'STOCK' }],
    enabled,
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, itemKind: 'STOCK', ...(q ? { q } : {}) },
        { signal },
      ).then((r) => r.data.items),
  });
}

const itemOptionsOf = (rows: readonly ItemOpt[]) => rows.map((i) => ({ value: i.id, label: codeAndName(i) }));

const statusTag = (s: string, t: (k: string) => string) =>
  s === 'POSTED' ? <Tag color="green">{t('stock.posted')}</Tag> : <Tag>{t('stock.draft')}</Tag>;

function BalancesTab() {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  // ?lowStock=1 (the home dashboard's "below minimum" card) opens with the filter on.
  const [searchParams] = useSearchParams();
  const [lowStock, setLowStock] = useState(() => searchParams.get('lowStock') === '1');
  const { whOptions, warehouseLabel } = useLookups();
  const listQuery = useQuery({
    queryKey: ['stock-balances', warehouseId, lowStock],
    queryFn: ({ signal }) =>
      stockReportsControllerBalances({
        warehouseId: warehouseId ?? '',
        itemId: '',
        lowStock: lowStock ? 'true' : '',
      }, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;
  return (
    <>
      <ListToolbar
        filters={
          <>
            <Select
              allowClear
              placeholder={t('stock.warehouse')}
              options={whOptions}
              onChange={setWarehouseId}
            />
            <Checkbox checked={lowStock} onChange={(e) => setLowStock(e.target.checked)}>
              {t('stock.lowStockOnly')}
            </Checkbox>
          </>
        }
        count={(data ?? []).length}
        actions={
          <ExportButtons
            path="/stock/balances"
            params={{ warehouseId, lowStock: lowStock ? 'true' : undefined }}
          />
        }
      />
      <Table
        rowKey={(r) => `${r.warehouseId}:${r.itemId}`}
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        locale={tableLocale(listQuery)}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: t('stock.warehouse'),
            dataIndex: 'warehouseCode',
            width: 180,
            render: (code: string) => warehouseLabel(code),
          },
          { title: t('items.code'), dataIndex: 'itemCode', width: 110 },
          { title: t('common.name'), dataIndex: 'itemName' },
          { title: t('stock.qty'), dataIndex: 'qtyOnHand', width: 110, align: 'right' as const, render: qtyCell },
          { title: t('items.unit'), dataIndex: 'unit', width: 80 },
          { title: t('items.minStock'), dataIndex: 'minStock', width: 100, align: 'right' as const, render: qtyCell },
        ]}
      />
    </>
  );
}

function AdjustmentsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show, ok, apiMessage } = useApiMessage();
  const [modalOpen, setModalOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<AdjustmentRow | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1)]);
  const [form] = Form.useForm();
  const { whOptions } = useLookups();
  const items = useStockItemPicker(modalOpen);

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<AdjustmentRow, Record<string, string | undefined>, StockDocumentsControllerListAdjustmentsSort>({
    key: ['stock-adjustments', 'list'],
    filters: {},
    defaultSort: '-date',
    fetch: (params, signal) => stockDocumentsControllerListAdjustments(params, { signal }).then((r) => r.data),
    enabled: !modalOpen,
  });
  const listQuery = list.query;
  const { isLoading } = listQuery;
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['stock-adjustments'] });

  const create = useMutation({
    mutationFn: (v: {
      adjustmentDate: Dayjs;
      adjustmentType: CreateStockAdjustmentDtoAdjustmentType;
      warehouseId: string;
      description?: string;
    }) =>
      stockDocumentsControllerCreateAdjustment({
        adjustmentDate: v.adjustmentDate.format('YYYY-MM-DD'),
        adjustmentType: v.adjustmentType,
        warehouseId: v.warehouseId,
        description: v.description || undefined,
        lines: lines
          .filter((l): l is ItemLineDraft & { itemId: string; qty: string } => !!l.itemId && l.qty != null)
          .map((l) => ({
            itemId: l.itemId,
            qty: l.qty,
            unitCost: l.unitCost != null ? l.unitCost : undefined,
            description: l.description || undefined,
          })),
      }),
    onSuccess: () => {
      ok('common.saved');
      setModalOpen(false);
      form.resetFields();
      setLines([emptyItemLine(1)]);
      invalidate();
    },
    onError: show,
  });

  const post = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerPostAdjustment(id, { headers: idemHeaders() }),
    onSuccess: () => {
      ok('journal.posted');
      invalidate();
      invalidateStock(queryClient);
    },
    onError: show,
  });
  const reverse = useMutation({
    mutationFn: (v: { id: string; date: Dayjs }) =>
      stockDocumentsControllerReverseAdjustment(
        v.id,
        { reversalDate: v.date.format('YYYY-MM-DD') },
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      ok('journal.reversed');
      setReverseTarget(null);
      invalidate();
      invalidateStock(queryClient);
    },
    onError: show,
  });
  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteAdjustment(id),
    onSuccess: invalidate,
    onError: show,
  });

  const adjType = Form.useWatch('adjustmentType', form);
  const needsCost = adjType === 'OPENING' || adjType === 'IN';

  const closeNew = () => {
    setModalOpen(false);
    setLines([emptyItemLine(1)]);
  };
  const submitNew = () => {
    if (create.isPending) return;
    const filled = lines.filter((l) => l.itemId && l.qty != null);
    if (filled.length === 0) {
      apiMessage.error(t('stock.minLines'));
      return;
    }
    form.submit();
  };
  useDocShortcuts({ onSave: modalOpen ? submitNew : undefined });

  // A new adjustment opens as a full document page.
  if (modalOpen) {
    return (
      <>
        {contextHolder}
        <DocLayout
          title={t('stock.newAdjustment')}
          status="DRAFT"
          onBack={closeNew}
          actions={
            <Button type="primary" icon={<SaveOutlined />} loading={create.isPending} onClick={submitNew}>
              {t('common.saveDraft')}
              <span className="doc-kbd">Ctrl+S</span>
            </Button>
          }
        >
          <EnterNav autoFocusWhen>
            <Form
              form={form}
              layout="vertical"
              onFinish={(v) => create.mutate(v)}
              requiredMark={false}
              initialValues={{ adjustmentType: 'IN', adjustmentDate: dayjs() }}
            >
              <DocFields>
                <Form.Item name="adjustmentDate" label={t('stock.date')} rules={[{ required: true }]}>
                  <DatePicker />
                </Form.Item>
                <Form.Item name="adjustmentType" label={t('stock.type')} rules={[{ required: true }]}>
                  <GridSelect
                    enterOpens
                    options={['OPENING', 'IN', 'OUT'].map((v) => ({
                      value: v,
                      label: t(`stock.types.${v}`),
                    }))}
                  />
                </Form.Item>
                <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]}>
                  <GridSelect enterOpens options={whOptions} />
                </Form.Item>
                <Form.Item name="description" label={t('common.description')}>
                  <Input maxLength={500} />
                </Form.Item>
              </DocFields>
              <ItemLinesGrid
                lines={lines}
                onChange={setLines}
                itemOptions={itemOptionsOf(items.withSelected(lines.map((l) => l.itemId)))}
                onItemSearch={items.onSearch}
                showCost={needsCost}
                showDescription
              />
            </Form>
          </EnterNav>
        </DocLayout>
      </>
    );
  }

  return (
    <>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        actions={
          <Button
            type="primary"
            onClick={() => {
              setLines([emptyItemLine(1)]);
              setModalOpen(true);
            }}
          >
            {t('stock.newAdjustment')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(listQuery)}
        pagination={list.pagination}
        onChange={list.onTableChange}
        columns={[
          {
            title: t('stock.docNo'),
            dataIndex: 'docNo',
            key: 'docNo',
            sorter: true,
            sortOrder: list.sortOrderOf('docNo'),
            width: 150,
            className: 'nowrap',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('stock.date'),
            dataIndex: 'adjustmentDate',
            key: 'date',
            sorter: true,
            sortOrder: list.sortOrderOf('date'),
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          {
            title: t('stock.type'),
            dataIndex: 'adjustmentType',
            width: 130,
            render: (v: string) => t(`stock.types.${v}`, { defaultValue: v }),
          },
          {
            title: t('stock.warehouse'),
            width: 140,
            render: (_: unknown, r: AdjustmentRow) => displayName(r.warehouse) ?? '—',
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: AdjustmentRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 260,
            render: (_: unknown, row: AdjustmentRow) => (
              <Space>
                {row.status === 'DRAFT' ? (
                  <>
                    <Popconfirm
                      title={t('stock.confirmPost')}
                      onConfirm={() => post.mutate(row.id)}
                    >
                      <Button size="small" type="primary">
                        {t('journal.post')}
                      </Button>
                    </Popconfirm>
                    <Popconfirm title={t('common.confirmDelete')} onConfirm={() => del.mutate(row.id)}>
                      <Button size="small" danger>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  !row.reversalOfId && (
                    <Button
                      size="small"
                      onClick={() => {
                        setReverseTarget(row);
                        setReverseDate(dayjs());
                      }}
                    >
                      {t('journal.reverse')}
                    </Button>
                  )
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={t('journal.reverseTitle')}
        open={!!reverseTarget}
        onCancel={() => setReverseTarget(null)}
        onOk={() =>
          reverseTarget &&
          reverseDate &&
          reverse.mutate({ id: reverseTarget.id, date: reverseDate })
        }
        confirmLoading={reverse.isPending}
      >
        <DatePicker value={reverseDate} onChange={setReverseDate} style={{ width: '100%' }} />
      </Modal>
    </>
  );
}

function TransfersTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show, ok, apiMessage } = useApiMessage();
  const [modalOpen, setModalOpen] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<TransferRow | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1)]);
  const [form] = Form.useForm();
  const { whOptions } = useLookups();
  const items = useStockItemPicker(modalOpen);

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<TransferRow, Record<string, string | undefined>, StockDocumentsControllerListTransfersSort>({
    key: ['stock-transfers', 'list'],
    filters: {},
    defaultSort: '-date',
    fetch: (params, signal) => stockDocumentsControllerListTransfers(params, { signal }).then((r) => r.data),
    enabled: !modalOpen,
  });
  const listQuery = list.query;
  const { isLoading } = listQuery;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['stock-transfers'] });

  const create = useMutation({
    mutationFn: (v: {
      transferDate: Dayjs;
      fromWarehouseId: string;
      toWarehouseId: string;
      description?: string;
    }) =>
      stockDocumentsControllerCreateTransfer({
        transferDate: v.transferDate.format('YYYY-MM-DD'),
        fromWarehouseId: v.fromWarehouseId,
        toWarehouseId: v.toWarehouseId,
        description: v.description || undefined,
        lines: lines
          .filter((l): l is ItemLineDraft & { itemId: string; qty: string } => !!l.itemId && l.qty != null)
          .map((l) => ({ itemId: l.itemId, qty: l.qty })),
      }),
    onSuccess: () => {
      ok('common.saved');
      setModalOpen(false);
      form.resetFields();
      setLines([emptyItemLine(1)]);
      invalidate();
    },
    onError: show,
  });
  const post = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerPostTransfer(id, { headers: idemHeaders() }),
    onSuccess: () => {
      ok('journal.posted');
      invalidate();
      invalidateStock(queryClient);
    },
    onError: show,
  });
  const reverse = useMutation({
    mutationFn: (v: { id: string; date: Dayjs }) =>
      stockDocumentsControllerReverseTransfer(
        v.id,
        { reversalDate: v.date.format('YYYY-MM-DD') },
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      ok('journal.reversed');
      setReverseTarget(null);
      invalidate();
      invalidateStock(queryClient);
    },
    onError: show,
  });
  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteTransfer(id),
    onSuccess: invalidate,
    onError: show,
  });

  const closeNew = () => {
    setModalOpen(false);
    setLines([emptyItemLine(1)]);
  };
  const submitNew = () => {
    if (create.isPending) return;
    const filled = lines.filter((l) => l.itemId && l.qty != null);
    if (filled.length === 0) {
      apiMessage.error(t('stock.minLines'));
      return;
    }
    form.submit();
  };
  useDocShortcuts({ onSave: modalOpen ? submitNew : undefined });

  // A new transfer opens as a full document page.
  if (modalOpen) {
    return (
      <>
        {contextHolder}
        <DocLayout
          title={t('stock.newTransfer')}
          status="DRAFT"
          onBack={closeNew}
          actions={
            <Button type="primary" icon={<SaveOutlined />} loading={create.isPending} onClick={submitNew}>
              {t('common.saveDraft')}
              <span className="doc-kbd">Ctrl+S</span>
            </Button>
          }
        >
          <EnterNav autoFocusWhen>
            <Form
              form={form}
              layout="vertical"
              onFinish={(v) => create.mutate(v)}
              requiredMark={false}
              initialValues={{ transferDate: dayjs() }}
            >
              <DocFields>
                <Form.Item name="transferDate" label={t('stock.date')} rules={[{ required: true }]}>
                  <DatePicker />
                </Form.Item>
                <Form.Item name="fromWarehouseId" label={t('stock.from')} rules={[{ required: true }]}>
                  <GridSelect enterOpens options={whOptions} />
                </Form.Item>
                <Form.Item name="toWarehouseId" label={t('stock.to')} rules={[{ required: true }]}>
                  <GridSelect enterOpens options={whOptions} />
                </Form.Item>
                <Form.Item name="description" label={t('common.description')}>
                  <Input maxLength={500} />
                </Form.Item>
              </DocFields>
              <ItemLinesGrid
                lines={lines}
                onChange={setLines}
                itemOptions={itemOptionsOf(items.withSelected(lines.map((l) => l.itemId)))}
                onItemSearch={items.onSearch}
              />
            </Form>
          </EnterNav>
        </DocLayout>
      </>
    );
  }

  return (
    <>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        actions={
          <Button
            type="primary"
            onClick={() => {
              setLines([emptyItemLine(1)]);
              setModalOpen(true);
            }}
          >
            {t('stock.newTransfer')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(listQuery)}
        pagination={list.pagination}
        onChange={list.onTableChange}
        columns={[
          {
            title: t('stock.docNo'),
            dataIndex: 'docNo',
            key: 'docNo',
            sorter: true,
            sortOrder: list.sortOrderOf('docNo'),
            width: 150,
            className: 'nowrap',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('stock.date'),
            dataIndex: 'transferDate',
            key: 'date',
            sorter: true,
            sortOrder: list.sortOrderOf('date'),
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          {
            title: t('stock.from'),
            width: 140,
            render: (_: unknown, r: TransferRow) => displayName(r.fromWarehouse) ?? '—',
          },
          {
            title: t('stock.to'),
            width: 140,
            render: (_: unknown, r: TransferRow) => displayName(r.toWarehouse) ?? '—',
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: TransferRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 260,
            render: (_: unknown, row: TransferRow) => (
              <Space>
                {row.status === 'DRAFT' ? (
                  <>
                    <Popconfirm
                      title={t('stock.confirmPost')}
                      onConfirm={() => post.mutate(row.id)}
                    >
                      <Button size="small" type="primary">
                        {t('journal.post')}
                      </Button>
                    </Popconfirm>
                    <Popconfirm title={t('common.confirmDelete')} onConfirm={() => del.mutate(row.id)}>
                      <Button size="small" danger>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  </>
                ) : (
                  !row.reversalOfId && (
                    <Button
                      size="small"
                      onClick={() => {
                        setReverseTarget(row);
                        setReverseDate(dayjs());
                      }}
                    >
                      {t('journal.reverse')}
                    </Button>
                  )
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={t('journal.reverseTitle')}
        open={!!reverseTarget}
        onCancel={() => setReverseTarget(null)}
        onOk={() =>
          reverseTarget &&
          reverseDate &&
          reverse.mutate({ id: reverseTarget.id, date: reverseDate })
        }
        confirmLoading={reverse.isPending}
      >
        <DatePicker value={reverseDate} onChange={setReverseDate} style={{ width: '100%' }} />
      </Modal>
    </>
  );
}

function CountsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show, ok } = useApiMessage();
  const [modalOpen, setModalOpen] = useState(false);
  const [detail, setDetail] = useState<CountDetail | null>(null);
  const [counted, setCounted] = useState<Record<string, string | null>>({});
  const [form] = Form.useForm();
  const { whOptions } = useLookups();

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<CountRow, Record<string, string | undefined>, StockDocumentsControllerListCountsSort>({
    key: ['stock-counts', 'list'],
    filters: {},
    defaultSort: '-date',
    fetch: (params, signal) => stockDocumentsControllerListCounts(params, { signal }).then((r) => r.data),
    enabled: !detail,
  });
  const listQuery = list.query;
  const { isLoading } = listQuery;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['stock-counts'] });

  const create = useMutation({
    mutationFn: (v: { countDate: Dayjs; warehouseId: string; description?: string }) =>
      stockDocumentsControllerCreateCount({
        countDate: v.countDate.format('YYYY-MM-DD'),
        warehouseId: v.warehouseId,
        description: v.description || undefined,
      }),
    onSuccess: () => {
      ok('common.saved');
      setModalOpen(false);
      form.resetFields();
      invalidate();
    },
    onError: show,
  });

  const openDetail = async (id: string) => {
    const res = await stockDocumentsControllerGetCount(id);
    const d = res.data;
    setDetail(d);
    setCounted(
      Object.fromEntries(
        d.lines.map((l) => [l.id, l.countedQty ?? null]),
      ),
    );
  };

  const saveLine = useMutation({
    mutationFn: (v: { lineId: string; qty: string }) =>
      stockDocumentsControllerUpdateCountLine(detail!.id, v.lineId, {
        countedQty: v.qty,
      }),
    onError: show,
  });

  // Enter in a counted-qty cell moves to the next row's input.
  const onCountGridKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    const inputs = Array.from(
      e.currentTarget.querySelectorAll<HTMLInputElement>('.ant-table-tbody input'),
    );
    const idx = inputs.indexOf(e.target as HTMLInputElement);
    if (idx === -1) return;
    e.preventDefault();
    inputs[idx + 1]?.focus();
  };

  const approve = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerApproveCount(id),
    onSuccess: () => {
      ok('common.saved');
      setDetail(null);
      invalidate();
      invalidateStock(queryClient);
    },
    onError: show,
  });

  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteCount(id),
    onSuccess: invalidate,
    onError: show,
  });

  // The count sheet opens as a full document page.
  if (detail) {
    const isDraft = detail.status === 'DRAFT';
    return (
      <>
        {contextHolder}
        <DocLayout
          title={t('stock.countLines')}
          docNo={detail.docNo}
          onBack={() => setDetail(null)}
          actions={
            isDraft && (
              <Popconfirm
                title={t('stock.confirmApprove')}
                onConfirm={() => approve.mutate(detail.id)}
              >
                <Button type="primary" loading={approve.isPending}>
                  {t('stock.approve')}
                </Button>
              </Popconfirm>
            )
          }
        >
          <DocFields>
            <DocField label={t('stock.date')}>
              <DocValue>
                {detail.countDate ? dayjs(detail.countDate).format('YYYY-MM-DD') : '—'}
              </DocValue>
            </DocField>
            <DocField label={t('stock.warehouse')}>
              <DocValue>
                {whOptions.find((o) => o.value === detail.warehouseId)?.label ?? '—'}
              </DocValue>
            </DocField>
            <DocField label={t('common.status')}>
              <DocValue>{statusTag(detail.status, t)}</DocValue>
            </DocField>
            {detail.description && (
              <DocField label={t('common.description')}>
                <DocValue>{detail.description}</DocValue>
              </DocField>
            )}
          </DocFields>
          <div onKeyDown={onCountGridKeyDown}>
            <Table
              rowKey="id"
              size="small"
              dataSource={detail.lines}
              pagination={false}
              columns={[
                {
                  title: t('items.code'),
                  width: 110,
                  render: (_: unknown, l: CountLine) => l.item?.code ?? l.itemId,
                },
                {
                  title: t('common.name'),
                  render: (_: unknown, l: CountLine) => displayName(l.item) ?? '—',
                },
                { title: t('stock.systemQty'), dataIndex: 'systemQty', width: 110, align: 'right' as const, render: qtyCell },
                {
                  title: t('stock.countedQty'),
                  width: 130,
                  align: 'right' as const,
                  render: (_: unknown, l: CountLine) =>
                    isDraft ? (
                      <InputNumber<string>
                        stringMode
                        size="small"
                        min="0"
                        value={counted[l.id] ?? null}
                        onChange={(v) => {
                          setCounted((c) => ({ ...c, [l.id]: v }));
                          if (v != null) saveLine.mutate({ lineId: l.id, qty: v });
                        }}
                      />
                    ) : (
                      <Num>{formatQty(l.countedQty)}</Num>
                    ),
                },
                {
                  title: t('stock.diff'),
                  dataIndex: 'differenceQty',
                  width: 90,
                  align: 'right' as const,
                  render: (v: string | null) => <Num>{formatQty(v)}</Num>,
                },
              ]}
            />
          </div>
        </DocLayout>
      </>
    );
  }

  return (
    <>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        count={list.total}
        actions={
          <Button type="primary" onClick={() => setModalOpen(true)}>
            {t('stock.newCount')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(listQuery)}
        pagination={list.pagination}
        onChange={list.onTableChange}
        columns={[
          {
            title: t('stock.docNo'),
            dataIndex: 'docNo',
            key: 'docNo',
            sorter: true,
            sortOrder: list.sortOrderOf('docNo'),
            width: 150,
            className: 'nowrap',
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('stock.date'),
            dataIndex: 'countDate',
            key: 'date',
            sorter: true,
            sortOrder: list.sortOrderOf('date'),
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: CountRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 200,
            render: (_: unknown, row: CountRow) => (
              <Space>
                <Button size="small" onClick={() => void openDetail(row.id)}>
                  {t('stock.countLines')}
                </Button>
                {row.status === 'DRAFT' && (
                  <Popconfirm title={t('common.confirmDelete')} onConfirm={() => del.mutate(row.id)}>
                    <Button size="small" danger>
                      {t('common.delete')}
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <FormDialog
        title={t('stock.newCount')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={create.isPending}
      >
        <EnterNav autoFocusWhen={modalOpen}>
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          initialValues={{ countDate: dayjs() }}
        >
          <FormSection title={t('stock.countDetails')} icon={<InfoCircleOutlined />}>
            <Form.Item name="countDate" label={t('stock.date')} rules={[{ required: true }]}>
              <DatePicker />
            </Form.Item>
            <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]}>
              <GridSelect enterOpens options={whOptions} />
            </Form.Item>
            <Form.Item name="description" label={t('common.description')}>
              <Input maxLength={500} />
            </Form.Item>
          </FormSection>
        </Form>
        </EnterNav>
      </FormDialog>
    </>
  );
}

function MovementsTab() {
  const { t } = useTranslation();
  const [itemId, setItemId] = useState<string | undefined>();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);
  const { whOptions, warehouseLabel } = useLookups();
  // The request's own filters: a change of any of them restarts the read (the key holds only what is sent).
  const filters = {
    warehouseId: warehouseId || undefined,
    itemId: itemId || undefined,
    from: from?.format('YYYY-MM-DD'),
    to: to?.format('YYYY-MM-DD'),
  };
  // "Load more" read (ADR-022 §4).
  const read = useKeysetQuery<MovementRow>({
    key: ['stock-movements', filters],
    fetch: (cursor, signal) =>
      stockReportsControllerMovements({ limit: 100, ...(cursor ? { cursor } : {}), ...filters }, { signal }).then(
        (r) => r.data,
      ),
  });
  return (
    <>
      <ListToolbar
        filters={
          <>
            <RemoteSelect
              queryKey={['items', 'pick-movements', { itemKind: 'STOCK' }]}
              placeholder={t('items.title')}
              value={itemId}
              onChange={setItemId}
              fetchOptions={(q, signal) =>
                catalogControllerListItems(
                  { pageSize: PICKER_PAGE_SIZE, itemKind: 'STOCK', ...(q ? { q } : {}) },
                  { signal },
                ).then((r) =>
                  r.data.items.map((i) => ({ value: i.id, label: codeAndName(i) })),
                )
              }
            />
            <Select
              allowClear
              placeholder={t('stock.warehouse')}
              options={whOptions}
              onChange={setWarehouseId}
            />
            <DatePicker placeholder={t('stock.from')} value={from} onChange={setFrom} />
            <DatePicker placeholder={t('stock.to')} value={to} onChange={setTo} />
          </>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={read.query.isLoading}
        dataSource={read.rows}
        locale={tableLocale(read.query)}
        pagination={false}
        columns={[
          {
            title: t('stock.date'),
            dataIndex: 'movementDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          {
            title: t('stock.warehouse'),
            dataIndex: 'warehouseCode',
            width: 160,
            render: (code: string) => warehouseLabel(code),
          },
          { title: t('items.code'), dataIndex: 'itemCode', width: 100 },
          { title: t('common.name'), dataIndex: 'itemName' },
          {
            title: t('stock.type'),
            dataIndex: 'movementType',
            width: 80,
            render: (v: string) =>
              v === 'IN' ? <Tag color="green">{t('stock.types.IN')}</Tag> : <Tag color="red">{t('stock.types.OUT')}</Tag>,
          },
          { title: t('stock.qtyIn'), dataIndex: 'qtyIn', width: 90, align: 'right' as const, render: qtyCell },
          { title: t('stock.qtyOut'), dataIndex: 'qtyOut', width: 90, align: 'right' as const, render: qtyCell },
          { title: t('stock.unitCost'), dataIndex: 'unitCost', width: 100, align: 'right' as const, render: unitCostCell },
          { title: t('stock.totalCost'), dataIndex: 'totalCost', width: 110, align: 'right' as const, render: amountCell },
          { title: t('stock.balanceAfter'), dataIndex: 'balanceQtyAfter', width: 110, align: 'right' as const, render: qtyCell },
        ]}
      />
      <LoadMore
        hasMore={read.hasMore}
        loading={read.loadingMore}
        onLoadMore={read.loadMore}
        shown={read.rows.length}
      />
    </>
  );
}

function ValuationTab() {
  const { t } = useTranslation();
  const listQuery = useQuery({
    queryKey: ['stock-valuation'],
    queryFn: ({ signal }) =>
      stockReportsControllerValuation({ warehouseId: '' }, { signal }).then((r) => r.data),
  });
  const { data, isLoading } = listQuery;
  return (
    <>
      <Typography.Title level={5}>
        {t('stock.totalValue')}: <Num>{formatAmount(data?.totalValue)}</Num>
      </Typography.Title>
      <ListToolbar actions={<ExportButtons path="/stock/valuation" />} />
      <Table
        rowKey="itemId"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        locale={tableLocale(listQuery)}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('common.name'), key: 'name', render: (_: unknown, r: Named) => displayName(r) },
          { title: t('stock.qty'), dataIndex: 'qty', width: 110, align: 'right' as const, render: qtyCell },
          { title: t('stock.avgCost'), dataIndex: 'avgCost', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('stock.value'), dataIndex: 'value', width: 120, align: 'right' as const, render: amountCell },
        ]}
      />
    </>
  );
}

export function StockPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  // ?tab=adjustments: the opening balances screen links to opening stock.
  const [activeTab, setActiveTab] = useState(() => searchParams.get('tab') ?? 'balances');
  const [voucherRequest, setVoucherRequest] = useState<'GRN' | 'GIN' | null>(null);

  const openVoucher = (type: 'GRN' | 'GIN') => {
    setActiveTab('vouchers');
    setVoucherRequest(type);
  };

  return (
    <div>
      <PageHeader
        title={t('stock.title')}
        actions={
          <Space>
            <Button onClick={() => openVoucher('GIN')}>{t('goods.exitVoucher')}</Button>
            <Button type="primary" onClick={() => openVoucher('GRN')}>
              {t('goods.entryVoucher')}
            </Button>
          </Space>
        }
      />
      <Card>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'balances', label: t('stock.balances'), children: <BalancesTab /> },
          { key: 'adjustments', label: t('stock.adjustments'), children: <AdjustmentsTab /> },
          { key: 'transfers', label: t('stock.transfers'), children: <TransfersTab /> },
          { key: 'counts', label: t('stock.counts'), children: <CountsTab /> },
          {
            key: 'vouchers',
            label: t('stock.vouchers'),
            children: (
              <GoodsNotesSection
                requestVoucher={voucherRequest}
                onVoucherHandled={() => setVoucherRequest(null)}
              />
            ),
          },
          { key: 'movements', label: t('stock.movements'), children: <MovementsTab /> },
          { key: 'valuation', label: t('stock.valuation'), children: <ValuationTab /> },
        ]}
      />
      </Card>
    </div>
  );
}
