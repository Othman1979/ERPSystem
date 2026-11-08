import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { idemHeaders } from '../idempotency';
import { GoodsNotesSection } from './GoodsNotesPage';
import {
  emptyItemLine,
  ItemLinesGrid,
  type ItemLineDraft,
} from '../components/ItemLinesGrid';

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
  isActive: boolean;
}
interface ItemOpt {
  id: string;
  code: string;
  nameAr: string;
  itemKind: string;
}
interface DocRow {
  id: string;
  docNo: string | null;
  status: 'DRAFT' | 'POSTED';
  adjustmentDate?: string;
  transferDate?: string;
  countDate?: string;
  adjustmentType?: string;
  warehouse?: { nameAr: string } | null;
  fromWarehouse?: { nameAr: string } | null;
  toWarehouse?: { nameAr: string } | null;
  description: string | null;
  reversalOfId?: string | null;
  _count?: { lines: number };
}
interface BalanceRow {
  warehouseId: string;
  warehouseCode: string;
  itemId: string;
  itemCode: string;
  itemName: string;
  unit: string;
  qtyOnHand: string;
  minStock: string;
}
interface MovementRow {
  id: string;
  movementDate: string;
  warehouseCode: string;
  itemCode: string;
  itemName: string;
  movementType: string;
  sourceType: string;
  qtyIn: string;
  qtyOut: string;
  unitCost: string;
  totalCost: string;
  balanceQtyAfter: string;
}
interface CountLine {
  id: string;
  itemId: string;
  systemQty: string;
  countedQty: string | null;
  differenceQty: string | null;
  item?: { code: string; nameAr: string };
}
interface CountDetail {
  id: string;
  status: string;
  warehouseId: string;
  lines: CountLine[];
}

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
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
  });
  const items = useQuery({
    queryKey: ['items-stock'],
    queryFn: () =>
      catalogControllerListItems({ search: '', itemKind: 'STOCK', isActive: '' }).then(
        (r) => (r.data as unknown as ItemOpt[]).filter((i) => i.itemKind === 'STOCK'),
      ),
  });
  const whOptions = (warehouses.data ?? [])
    .filter((w) => w.isActive)
    .map((w) => ({ value: w.id, label: `${w.code} — ${w.nameAr}` }));
  const itemOptions = (items.data ?? []).map((i) => ({
    value: i.id,
    label: `${i.code} — ${i.nameAr}`,
  }));
  return { warehouses, items, whOptions, itemOptions };
}

const statusTag = (s: string, t: (k: string) => string) =>
  s === 'POSTED' ? <Tag color="green">{t('stock.posted')}</Tag> : <Tag>{t('stock.draft')}</Tag>;

function BalancesTab() {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [lowStock, setLowStock] = useState(false);
  const { whOptions } = useLookups();
  const { data, isLoading } = useQuery({
    queryKey: ['stock-balances', warehouseId, lowStock],
    queryFn: () =>
      stockReportsControllerBalances({
        warehouseId: warehouseId ?? '',
        itemId: '',
        lowStock: lowStock ? 'true' : '',
      }).then((r) => r.data as unknown as BalanceRow[]),
  });
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t('stock.warehouse')}
          style={{ width: 240 }}
          options={whOptions}
          onChange={setWarehouseId}
        />
        <Checkbox checked={lowStock} onChange={(e) => setLowStock(e.target.checked)}>
          {t('stock.lowStockOnly')}
        </Checkbox>
      </Space>
      <Table
        rowKey={(r) => `${r.warehouseId}:${r.itemId}`}
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('stock.warehouse'), dataIndex: 'warehouseCode', width: 110 },
          { title: t('items.code'), dataIndex: 'itemCode', width: 110 },
          { title: t('items.nameAr'), dataIndex: 'itemName' },
          { title: t('stock.qty'), dataIndex: 'qtyOnHand', width: 110 },
          { title: t('items.unit'), dataIndex: 'unit', width: 80 },
          { title: t('items.minStock'), dataIndex: 'minStock', width: 100 },
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
  const [reverseTarget, setReverseTarget] = useState<DocRow | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1)]);
  const [form] = Form.useForm();
  const { whOptions, itemOptions } = useLookups();

  const { data, isLoading } = useQuery({
    queryKey: ['stock-adjustments'],
    queryFn: () =>
      stockDocumentsControllerListAdjustments({ status: '' }).then(
        (r) => r.data as unknown as DocRow[],
      ),
  });
  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['stock-adjustments'] });

  const create = useMutation({
    mutationFn: (v: {
      adjustmentDate: Dayjs;
      adjustmentType: string;
      warehouseId: string;
      description?: string;
    }) =>
      stockDocumentsControllerCreateAdjustment({
        adjustmentDate: v.adjustmentDate.format('YYYY-MM-DD'),
        adjustmentType: v.adjustmentType,
        warehouseId: v.warehouseId,
        description: v.description || undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty != null)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitCost: l.unitCost != null ? String(l.unitCost) : undefined,
            description: l.description || undefined,
          })),
      } as never),
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
      void queryClient.invalidateQueries({ queryKey: ['stock-balances'] });
    },
    onError: show,
  });
  const reverse = useMutation({
    mutationFn: (v: { id: string; date: Dayjs }) =>
      stockDocumentsControllerReverseAdjustment(
        v.id,
        { reversalDate: v.date.format('YYYY-MM-DD') } as never,
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      ok('journal.reversed');
      setReverseTarget(null);
      invalidate();
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

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          onClick={() => {
            setLines([emptyItemLine(1)]);
            setModalOpen(true);
          }}
        >
          {t('stock.newAdjustment')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('stock.docNo'), dataIndex: 'docNo', width: 140, render: (v: string | null) => v ?? '—' },
          {
            title: t('stock.date'),
            dataIndex: 'adjustmentDate',
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
            render: (_: unknown, r: DocRow) => r.warehouse?.nameAr ?? '—',
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: DocRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 260,
            render: (_: unknown, row: DocRow) => (
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
        title={t('stock.newAdjustment')}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setLines([emptyItemLine(1)]);
        }}
        onOk={() => {
          const filled = lines.filter((l) => l.itemId && l.qty != null);
          if (filled.length === 0) {
            apiMessage.error(t('stock.minLines'));
            return;
          }
          form.submit();
        }}
        confirmLoading={create.isPending}
        width={820}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          requiredMark={false}
          initialValues={{ adjustmentType: 'IN', adjustmentDate: dayjs() }}
        >
          <Space style={{ display: 'flex' }}>
            <Form.Item name="adjustmentDate" label={t('stock.date')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="adjustmentType" label={t('stock.type')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={['OPENING', 'IN', 'OUT'].map((v) => ({
                  value: v,
                  label: t(`stock.types.${v}`),
                }))}
              />
            </Form.Item>
            <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={whOptions} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('common.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <ItemLinesGrid
            lines={lines}
            onChange={setLines}
            itemOptions={itemOptions}
            showCost={needsCost}
            showDescription
          />
        </Form>
      </Modal>
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
  const [reverseTarget, setReverseTarget] = useState<DocRow | null>(null);
  const [reverseDate, setReverseDate] = useState<Dayjs | null>(null);
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1)]);
  const [form] = Form.useForm();
  const { whOptions, itemOptions } = useLookups();

  const { data, isLoading } = useQuery({
    queryKey: ['stock-transfers'],
    queryFn: () =>
      stockDocumentsControllerListTransfers({ status: '' }).then(
        (r) => r.data as unknown as DocRow[],
      ),
  });
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
          .filter((l) => l.itemId && l.qty != null)
          .map((l) => ({ itemId: l.itemId, qty: String(l.qty) })),
      } as never),
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
      void queryClient.invalidateQueries({ queryKey: ['stock-balances'] });
    },
    onError: show,
  });
  const reverse = useMutation({
    mutationFn: (v: { id: string; date: Dayjs }) =>
      stockDocumentsControllerReverseTransfer(
        v.id,
        { reversalDate: v.date.format('YYYY-MM-DD') } as never,
        { headers: idemHeaders() },
      ),
    onSuccess: () => {
      ok('journal.reversed');
      setReverseTarget(null);
      invalidate();
    },
    onError: show,
  });
  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteTransfer(id),
    onSuccess: invalidate,
    onError: show,
  });

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Button
          type="primary"
          onClick={() => {
            setLines([emptyItemLine(1)]);
            setModalOpen(true);
          }}
        >
          {t('stock.newTransfer')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('stock.docNo'), dataIndex: 'docNo', width: 140, render: (v: string | null) => v ?? '—' },
          {
            title: t('stock.date'),
            dataIndex: 'transferDate',
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          {
            title: t('stock.from'),
            width: 140,
            render: (_: unknown, r: DocRow) => r.fromWarehouse?.nameAr ?? '—',
          },
          {
            title: t('stock.to'),
            width: 140,
            render: (_: unknown, r: DocRow) => r.toWarehouse?.nameAr ?? '—',
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: DocRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 260,
            render: (_: unknown, row: DocRow) => (
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
        title={t('stock.newTransfer')}
        open={modalOpen}
        onCancel={() => {
          setModalOpen(false);
          setLines([emptyItemLine(1)]);
        }}
        onOk={() => {
          const filled = lines.filter((l) => l.itemId && l.qty != null);
          if (filled.length === 0) {
            apiMessage.error(t('stock.minLines'));
            return;
          }
          form.submit();
        }}
        confirmLoading={create.isPending}
        width={820}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          requiredMark={false}
          initialValues={{ transferDate: dayjs() }}
        >
          <Space style={{ display: 'flex' }}>
            <Form.Item name="transferDate" label={t('stock.date')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <DatePicker style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="fromWarehouseId" label={t('stock.from')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={whOptions} />
            </Form.Item>
            <Form.Item name="toWarehouseId" label={t('stock.to')} rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={whOptions} />
            </Form.Item>
          </Space>
          <Form.Item name="description" label={t('common.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <ItemLinesGrid lines={lines} onChange={setLines} itemOptions={itemOptions} />
        </Form>
      </Modal>
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
  const [counted, setCounted] = useState<Record<string, number | null>>({});
  const [form] = Form.useForm();
  const { whOptions } = useLookups();

  const { data, isLoading } = useQuery({
    queryKey: ['stock-counts'],
    queryFn: () =>
      stockDocumentsControllerListCounts({ status: '' }).then(
        (r) => r.data as unknown as DocRow[],
      ),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['stock-counts'] });

  const create = useMutation({
    mutationFn: (v: { countDate: Dayjs; warehouseId: string; description?: string }) =>
      stockDocumentsControllerCreateCount({
        countDate: v.countDate.format('YYYY-MM-DD'),
        warehouseId: v.warehouseId,
        description: v.description || undefined,
      } as never),
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
    const d = res.data as unknown as CountDetail;
    setDetail(d);
    setCounted(
      Object.fromEntries(
        d.lines.map((l) => [l.id, l.countedQty != null ? Number(l.countedQty) : null]),
      ),
    );
  };

  const saveLine = useMutation({
    mutationFn: (v: { lineId: string; qty: number }) =>
      stockDocumentsControllerUpdateCountLine(detail!.id, v.lineId, {
        countedQty: String(v.qty),
      } as never),
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
      void queryClient.invalidateQueries({ queryKey: ['stock-balances'] });
    },
    onError: show,
  });

  const del = useMutation({
    mutationFn: (id: string) => stockDocumentsControllerDeleteCount(id),
    onSuccess: invalidate,
    onError: show,
  });

  return (
    <>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setModalOpen(true)}>
          {t('stock.newCount')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('stock.docNo'), dataIndex: 'docNo', width: 140, render: (v: string | null) => v ?? '—' },
          {
            title: t('stock.date'),
            dataIndex: 'countDate',
            width: 110,
            render: (v: string) => (v ? dayjs(v).format('YYYY-MM-DD') : '—'),
          },
          { title: t('stock.lines'), width: 80, render: (_: unknown, r: DocRow) => r._count?.lines ?? '—' },
          {
            title: t('common.status'),
            dataIndex: 'status',
            width: 90,
            render: (v: string) => statusTag(v, t),
          },
          {
            title: t('common.actions'),
            width: 200,
            render: (_: unknown, row: DocRow) => (
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
      <Modal
        title={t('stock.newCount')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={create.isPending}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => create.mutate(v)}
          requiredMark={false}
          initialValues={{ countDate: dayjs() }}
        >
          <Form.Item name="countDate" label={t('stock.date')} rules={[{ required: true }]}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="warehouseId" label={t('stock.warehouse')} rules={[{ required: true }]}>
            <Select options={whOptions} />
          </Form.Item>
          <Form.Item name="description" label={t('common.description')}>
            <Input maxLength={500} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={t('stock.countLines')}
        open={!!detail}
        onCancel={() => setDetail(null)}
        width={720}
        footer={
          detail?.status === 'DRAFT' ? (
            <Space>
              <Button onClick={() => setDetail(null)}>{t('common.close')}</Button>
              <Popconfirm
                title={t('stock.confirmApprove')}
                onConfirm={() => approve.mutate(detail.id)}
              >
                <Button type="primary" loading={approve.isPending}>
                  {t('stock.approve')}
                </Button>
              </Popconfirm>
            </Space>
          ) : (
            <Button onClick={() => setDetail(null)}>{t('common.close')}</Button>
          )
        }
      >
        {detail && (
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
                title: t('items.nameAr'),
                render: (_: unknown, l: CountLine) => l.item?.nameAr ?? '—',
              },
              { title: t('stock.systemQty'), dataIndex: 'systemQty', width: 110 },
              {
                title: t('stock.countedQty'),
                width: 130,
                render: (_: unknown, l: CountLine) =>
                  detail.status === 'DRAFT' ? (
                    <InputNumber
                      size="small"
                      min={0}
                      value={counted[l.id] ?? null}
                      onChange={(v) => {
                        setCounted((c) => ({ ...c, [l.id]: v }));
                        if (v != null) saveLine.mutate({ lineId: l.id, qty: v });
                      }}
                    />
                  ) : (
                    (l.countedQty ?? '—')
                  ),
              },
              {
                title: t('stock.diff'),
                dataIndex: 'differenceQty',
                width: 90,
                render: (v: string | null) => (v != null ? Number(v) : '—'),
              },
            ]}
          />
          </div>
        )}
      </Modal>
    </>
  );
}

function MovementsTab() {
  const { t } = useTranslation();
  const [itemId, setItemId] = useState<string | undefined>();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const { whOptions, itemOptions } = useLookups();
  const { data, isLoading } = useQuery({
    queryKey: ['stock-movements', itemId, warehouseId],
    queryFn: () =>
      stockReportsControllerMovements({
        itemId: itemId ?? '',
        warehouseId: warehouseId ?? '',
        sourceType: '',
        from: '',
        to: '',
        page: '1',
        pageSize: '100',
      }).then((r) => r.data as unknown as { rows: MovementRow[]; total: number }),
  });
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder={t('items.title')}
          style={{ width: 260 }}
          options={itemOptions}
          onChange={setItemId}
        />
        <Select
          allowClear
          placeholder={t('stock.warehouse')}
          style={{ width: 240 }}
          options={whOptions}
          onChange={setWarehouseId}
        />
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: t('stock.date'),
            dataIndex: 'movementDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          { title: t('stock.warehouse'), dataIndex: 'warehouseCode', width: 100 },
          { title: t('items.code'), dataIndex: 'itemCode', width: 100 },
          { title: t('items.nameAr'), dataIndex: 'itemName' },
          {
            title: t('stock.type'),
            dataIndex: 'movementType',
            width: 80,
            render: (v: string) =>
              v === 'IN' ? <Tag color="green">IN</Tag> : <Tag color="red">OUT</Tag>,
          },
          { title: t('stock.qtyIn'), dataIndex: 'qtyIn', width: 90 },
          { title: t('stock.qtyOut'), dataIndex: 'qtyOut', width: 90 },
          { title: t('stock.unitCost'), dataIndex: 'unitCost', width: 100 },
          { title: t('stock.totalCost'), dataIndex: 'totalCost', width: 110 },
          { title: t('stock.balanceAfter'), dataIndex: 'balanceQtyAfter', width: 110 },
        ]}
      />
    </>
  );
}

function ValuationTab() {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['stock-valuation'],
    queryFn: () =>
      stockReportsControllerValuation({ warehouseId: '' }).then(
        (r) => r.data as unknown as { rows: { itemId: string; code: string; nameAr: string; qty: string; avgCost: string; value: string }[]; totalValue: string },
      ),
  });
  return (
    <>
      <Typography.Title level={5}>
        {t('stock.totalValue')}: {data?.totalValue ?? '—'}
      </Typography.Title>
      <Table
        rowKey="itemId"
        size="small"
        loading={isLoading}
        dataSource={data?.rows ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('items.nameAr'), dataIndex: 'nameAr' },
          { title: t('stock.qty'), dataIndex: 'qty', width: 110 },
          { title: t('stock.avgCost'), dataIndex: 'avgCost', width: 110 },
          { title: t('stock.value'), dataIndex: 'value', width: 120 },
        ]}
      />
    </>
  );
}

export function StockPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('stock.title')}>
      <Tabs
        items={[
          { key: 'balances', label: t('stock.balances'), children: <BalancesTab /> },
          { key: 'adjustments', label: t('stock.adjustments'), children: <AdjustmentsTab /> },
          { key: 'transfers', label: t('stock.transfers'), children: <TransfersTab /> },
          { key: 'counts', label: t('stock.counts'), children: <CountsTab /> },
          { key: 'vouchers', label: t('stock.vouchers'), children: <GoodsNotesSection /> },
          { key: 'movements', label: t('stock.movements'), children: <MovementsTab /> },
          { key: 'valuation', label: t('stock.valuation'), children: <ValuationTab /> },
        ]}
      />
    </Card>
  );
}
