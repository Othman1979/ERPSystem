import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SaveOutlined } from '@ant-design/icons';
import {
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { formatDate } from '../format/date';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  catalogControllerListItems,
  stockDocumentsControllerCreateAdjustment,
  stockDocumentsControllerCreateTransfer,
  stockDocumentsControllerDeleteAdjustment,
  stockDocumentsControllerDeleteTransfer,
  stockDocumentsControllerListAdjustments,
  stockDocumentsControllerListTransfers,
  stockDocumentsControllerPostAdjustment,
  stockDocumentsControllerPostTransfer,
  stockDocumentsControllerReverseAdjustment,
  stockDocumentsControllerReverseTransfer,
  stockReportsControllerBalances,
  stockReportsControllerMovements,
  stockReportsControllerValuation,
} from '@erp/api-client';
import type {
  CreateStockAdjustmentDtoAdjustmentType,
  StockAdjustmentListItemDto,
  StockReportMovementDto,
  StockTransferListItemDto,
  StockDocumentsControllerListAdjustmentsSort,
  StockDocumentsControllerListTransfersSort,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { GoodsNotesSection } from './GoodsNotesPage';
import { CountsTab } from './stock/CountsTab';
import { itemOptionsOf, useApiMessage, useLookups, useStockItemPicker } from './stock/stockHooks';
import { PageHeader } from '../components/PageHeader';
import { FormSection } from '../components/FormDialog';
import { tableLocale } from '../components/QueryState';
import { ListToolbar } from '../components/ListToolbar';
import { LoadMore } from '../components/LoadMore';
import { RemoteSelect } from '../components/RemoteSelect';
import { useKeysetQuery } from '../hooks/useKeysetQuery';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE } from '../hooks/useRemoteOptions';
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
import { DocFields, DocLayout, useDocShortcuts } from '../components/DocLayout';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { formatAmount } from '../format/number';
import { invalidateStock } from '../stockQueries';

type AdjustmentRow = StockAdjustmentListItemDto;
type TransferRow = StockTransferListItemDto;
type MovementRow = StockReportMovementDto;

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
       scroll={{ x: 'max-content' }}/>
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
  const { ownedWhOptions: whOptions } = useLookups();
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
  useDocShortcuts({ onSave: modalOpen ? submitNew : undefined }, { allowInModal: true });

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
                    options={['OPENING', 'IN', 'OUT'].map((v) => ({
                      value: v,
                      label: t(`stock.types.${v}`),
                    }))}
                  />
                </Form.Item>
                <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]}>
                  <GridSelect options={whOptions} />
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
            render: (v: string) => (v ? formatDate(v) : '—'),
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
            title: t('common.actions'), key: 'actions',
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
       scroll={{ x: 'max-content' }}/>
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
        <Form layout="vertical">
          <FormSection title={t('journal.reverseTitle')} cols={1}>
            <Form.Item label={t('stock.date')}>
              <DatePicker value={reverseDate} onChange={setReverseDate} />
            </Form.Item>
          </FormSection>
        </Form>
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
  const { ownedWhOptions: whOptions } = useLookups();
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
  useDocShortcuts({ onSave: modalOpen ? submitNew : undefined }, { allowInModal: true });

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
                  <GridSelect options={whOptions} />
                </Form.Item>
                <Form.Item name="toWarehouseId" label={t('stock.to')} rules={[{ required: true }]}>
                  <GridSelect options={whOptions} />
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
            render: (v: string) => (v ? formatDate(v) : '—'),
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
            title: t('common.actions'), key: 'actions',
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
       scroll={{ x: 'max-content' }}/>
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
        <Form layout="vertical">
          <FormSection title={t('journal.reverseTitle')} cols={1}>
            <Form.Item label={t('stock.date')}>
              <DatePicker value={reverseDate} onChange={setReverseDate} />
            </Form.Item>
          </FormSection>
        </Form>
      </Modal>
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
              queryKey={['items', 'pick-movements', { stocked: 'true' }]}
              placeholder={t('items.title')}
              value={itemId}
              onChange={setItemId}
              fetchOptions={(q, signal) =>
                catalogControllerListItems(
                  { pageSize: PICKER_PAGE_SIZE, stocked: 'true', ...(q ? { q } : {}) },
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
            render: (v: string) => formatDate(v),
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
       scroll={{ x: 'max-content' }}/>
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
       scroll={{ x: 'max-content' }}/>
    </>
  );
}

export function StockPage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useUrlTab(
    ['balances', 'adjustments', 'transfers', 'counts', 'vouchers', 'movements', 'valuation'] as const,
    'balances',
  );
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
