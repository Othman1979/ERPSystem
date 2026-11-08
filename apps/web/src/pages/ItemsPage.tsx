import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarcodeOutlined,
  ProfileOutlined,
  AppstoreOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import JsBarcode from 'jsbarcode';
import {
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  catalogControllerCreateGroup,
  catalogControllerCreateItem,
  catalogControllerGetItem,
  catalogControllerListGroups,
  catalogControllerListItems,
  catalogControllerUpdateGroup,
  catalogControllerUpdateItem,
  settingsControllerListTaxCategories,
  settingsControllerListUnits,
  stockReportsControllerBalances,
  stockReportsControllerItemLedger,
  warehousesControllerList,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';

interface Unit {
  id: string;
  code: string;
  nameAr: string;
  unEceCode?: string | null;
}
interface Group {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: string | null;
  isActive: boolean;
}
interface Item {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  description?: string | null;
  itemKind: 'STOCK' | 'SERVICE';
  baseUnit?: { code: string; nameAr: string } | null;
  itemGroup?: { id: string; code: string; nameAr: string } | null;
  taxCategory?: { id: string; code: string; nameAr: string } | null;
  defaultWarehouse?: { id: string; code: string; nameAr: string } | null;
  salePrice: string | null;
  purchasePrice: string | null;
  minStock: string;
  maxStock: string | null;
  salePriceIncludesTax: boolean;
  imageUrl?: string | null;
  isActive: boolean;
}
interface BalanceRow {
  itemId: string;
  qtyOnHand: string;
  warehouseCode: string;
  warehouseName: string;
}
interface LedgerRow {
  id: string;
  movementDate: string;
  warehouse: { code: string; nameAr: string };
  movementType: string;
  sourceType: string;
  sourceId: string | null;
  qtyIn: string;
  qtyOut: string;
  unitCost: string;
  totalCost: string;
  balanceQtyAfter: string;
  avgCostAfter: string;
}
interface LedgerResponse {
  item: { id: string; code: string; nameAr: string; baseUnit?: { code: string } | null };
  rows: LedgerRow[];
  totals: { qtyIn: string; qtyOut: string };
  balances: { warehouse: { id: string; code: string; nameAr: string }; qtyOnHand: string }[];
}
interface ItemDetail extends Item {
  barcodes?: { id: string; barcode: string; itemUnit?: { unit?: { code: string } } | null }[];
}

const num = (v?: string | null) => (v != null ? Number(v) : null);

function useApiError() {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const show = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  return { apiMessage, contextHolder, show };
}

// ------------------------------------------------------------- items tab

function ItemsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show } = useApiError();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [view, setView] = useState<'table' | 'cards'>('table');
  const [ledgerItem, setLedgerItem] = useState<Item | null>(null);
  const [barcodeItem, setBarcodeItem] = useState<Item | null>(null);
  const [form] = Form.useForm();

  const { data: items, isLoading } = useQuery({
    queryKey: ['items', search, kindFilter],
    queryFn: () =>
      catalogControllerListItems({
        search: search,
        itemKind: kindFilter ?? '',
        isActive: '',
      }).then((r) => r.data as unknown as Item[]),
  });
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: () => settingsControllerListUnits().then((r) => r.data as unknown as Unit[]),
  });
  const { data: groups } = useQuery({
    queryKey: ['item-groups'],
    queryFn: () => catalogControllerListGroups().then((r) => r.data as unknown as Group[]),
  });
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as { id: string; code: string; nameAr: string }[]),
  });
  const { data: taxCategories } = useQuery({
    queryKey: ['tax-categories'],
    queryFn: () =>
      settingsControllerListTaxCategories().then(
        (r) => r.data as unknown as { id: string; code: string; nameAr: string; rate: string }[],
      ),
  });
  const { data: balances } = useQuery({
    queryKey: ['stock-balances-all'],
    queryFn: () =>
      stockReportsControllerBalances({ warehouseId: '', itemId: '', lowStock: '' }).then(
        (r) => r.data as unknown as BalanceRow[],
      ),
  });

  const qtyByItem = new Map<string, number>();
  for (const b of balances ?? []) {
    qtyByItem.set(b.itemId, (qtyByItem.get(b.itemId) ?? 0) + Number(b.qtyOnHand));
  }

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['items'] });

  const save = useMutation({
    mutationFn: async (v: Record<string, unknown>): Promise<unknown> => {
      const payload = {
        ...v,
        salePrice: v.salePrice != null ? String(v.salePrice) : undefined,
        purchasePrice: v.purchasePrice != null ? String(v.purchasePrice) : undefined,
        minStock: v.minStock != null ? String(v.minStock) : undefined,
        maxStock: v.maxStock != null ? String(v.maxStock) : undefined,
        itemGroupId: v.itemGroupId || undefined,
        defaultWarehouseId: v.defaultWarehouseId || undefined,
        imageUrl: v.imageUrl || undefined,
        nameEn: v.nameEn || undefined,
        description: v.description || undefined,
        taxCategoryId: v.taxCategoryId || undefined,
      };
      return editing
        ? catalogControllerUpdateItem(editing.id, payload as never)
        : catalogControllerCreateItem(payload as never);
    },
    onSuccess: () => {
      invalidate();
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: show,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => catalogControllerUpdateItem(id, { isActive: false } as never),
    onSuccess: invalidate,
    onError: show,
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ itemKind: 'STOCK', salePriceIncludesTax: false });
    setModalOpen(true);
  };
  const openEdit = (row: Item) => {
    setEditing(row);
    form.setFieldsValue({
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      description: row.description,
      itemKind: row.itemKind,
      baseUnitId: undefined,
      itemGroupId: row.itemGroup?.id ?? undefined,
      taxCategoryId: row.taxCategory?.id ?? undefined,
      defaultWarehouseId: row.defaultWarehouse?.id ?? undefined,
      salePrice: num(row.salePrice) ?? undefined,
      purchasePrice: num(row.purchasePrice) ?? undefined,
      minStock: num(row.minStock) ?? undefined,
      maxStock: num(row.maxStock) ?? undefined,
      salePriceIncludesTax: row.salePriceIncludesTax,
      imageUrl: row.imageUrl ?? undefined,
    });
    setModalOpen(true);
  };

  const stockBadge = (r: Item) => {
    if (r.itemKind !== 'STOCK') return <Tag>{t('items.service')}</Tag>;
    const qty = qtyByItem.get(r.id);
    if (qty === undefined) return <Tag color="default">0</Tag>;
    const min = num(r.minStock) ?? 0;
    const color = qty <= 0 ? 'red' : qty <= min ? 'orange' : 'green';
    return <Tag color={color}>{qty.toFixed(3)}</Tag>;
  };

  const columns = [
    { title: t('items.code'), dataIndex: 'code', width: 110 },
    { title: t('items.nameAr'), dataIndex: 'nameAr' },
    {
      title: t('items.kind'),
      dataIndex: 'itemKind',
      width: 100,
      render: (v: string) =>
        v === 'STOCK' ? <Tag color="blue">{t('items.stock')}</Tag> : <Tag>{t('items.service')}</Tag>,
    },
    {
      title: t('items.unit'),
      width: 90,
      render: (_: unknown, r: Item) => r.baseUnit?.code ?? '—',
    },
    {
      title: t('items.onHand'),
      width: 100,
      align: 'end' as const,
      render: (_: unknown, r: Item) => stockBadge(r),
    },
    {
      title: t('items.salePrice'),
      dataIndex: 'salePrice',
      width: 100,
      align: 'end' as const,
      render: (v: string | null) => (v != null ? Number(v).toFixed(2) : '—'),
    },
    {
      title: t('items.purchasePrice'),
      dataIndex: 'purchasePrice',
      width: 110,
      align: 'end' as const,
      render: (v: string | null) => (v != null ? Number(v).toFixed(2) : '—'),
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 90,
      render: (v: boolean) =>
        v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>,
    },
    {
      title: t('common.actions'),
      width: 260,
      render: (_: unknown, row: Item) => (
        <Space size={4} wrap>
          {row.itemKind === 'STOCK' && (
            <Button size="small" icon={<ProfileOutlined />} onClick={() => setLedgerItem(row)}>
              {t('items.ledger')}
            </Button>
          )}
          <Button size="small" icon={<BarcodeOutlined />} onClick={() => setBarcodeItem(row)}>
            {t('items.barcode')}
          </Button>
          <Button size="small" onClick={() => openEdit(row)}>
            {t('common.edit')}
          </Button>
          {row.isActive && (
            <Button size="small" danger onClick={() => deactivate.mutate(row.id)}>
              {t('common.deactivate')}
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={t('items.title')}
        actions={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder={t('items.search')}
              style={{ width: 200 }}
              onSearch={setSearch}
            />
            <Select
              allowClear
              placeholder={t('items.kind')}
              style={{ width: 130 }}
              onChange={setKindFilter}
              options={[
                { value: 'STOCK', label: t('items.stock') },
                { value: 'SERVICE', label: t('items.service') },
              ]}
            />
            <Segmented
              value={view}
              onChange={(v) => setView(v as 'table' | 'cards')}
              options={[
                { value: 'table', icon: <UnorderedListOutlined /> },
                { value: 'cards', icon: <AppstoreOutlined /> },
              ]}
            />
            <Button type="primary" onClick={openCreate}>
              {t('items.add')}
            </Button>
          </Space>
        }
      />
      <Card size="small">
      {contextHolder}
      {view === 'table' ? (
        <Table
          rowKey="id"
          size="small"
          loading={isLoading}
          dataSource={items ?? []}
          pagination={{ pageSize: 20 }}
          columns={columns}
        />
      ) : (
        <Row gutter={[12, 12]}>
          {(items ?? []).map((r) => (
            <Col key={r.id} xs={24} sm={12} md={8} lg={6}>
              <Card
                size="small"
                hoverable
                styles={{ body: { padding: 12 } }}
                cover={
                  r.imageUrl ? (
                    <img src={r.imageUrl} alt={r.nameAr} style={{ height: 110, objectFit: 'cover' }} />
                  ) : undefined
                }
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong>{r.nameAr}</Typography.Text>
                    {r.itemKind === 'STOCK' ? (
                      <Tag color="blue">{t('items.stock')}</Tag>
                    ) : (
                      <Tag>{t('items.service')}</Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.code} {r.baseUnit ? `· ${r.baseUnit.code}` : ''}
                    {r.itemGroup ? ` · ${r.itemGroup.nameAr}` : ''}
                  </Typography.Text>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <span>{t('items.onHand')}: {stockBadge(r)}</span>
                    <Typography.Text strong>
                      {r.salePrice != null ? `${Number(r.salePrice).toFixed(2)}` : '—'}
                    </Typography.Text>
                  </Space>
                  <Space size={4} wrap>
                    <Button size="small" onClick={() => openEdit(r)}>{t('common.edit')}</Button>
                    {r.itemKind === 'STOCK' && (
                      <Button size="small" icon={<ProfileOutlined />} onClick={() => setLedgerItem(r)}>
                        {t('items.ledger')}
                      </Button>
                    )}
                    <Button size="small" icon={<BarcodeOutlined />} onClick={() => setBarcodeItem(r)}>
                      {t('items.barcode')}
                    </Button>
                  </Space>
                </Space>
              </Card>
            </Col>
          ))}
        </Row>
      )}

      <Modal
        title={editing ? t('items.edit') : t('items.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        width={640}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>{t('items.general')}</Typography.Title>
          <Space style={{ display: 'flex' }} wrap>
            <Form.Item name="code" label={t('items.code')} rules={[{ required: true }]} style={{ flex: 1, minWidth: 140 }}>
              <Input maxLength={50} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="itemKind" label={t('items.kind')} initialValue="STOCK" style={{ width: 150 }}>
              <Select
                disabled={!!editing}
                options={[
                  { value: 'STOCK', label: t('items.stock') },
                  { value: 'SERVICE', label: t('items.service') },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('items.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="description" label={t('common.description')}>
            <Input.TextArea rows={2} maxLength={500} />
          </Form.Item>
          <Form.Item name="imageUrl" label={t('items.imageUrl')}>
            <Input maxLength={512} placeholder="https://…" />
          </Form.Item>

          <Typography.Title level={5}>{t('items.classification')}</Typography.Title>
          <Space style={{ display: 'flex' }} wrap>
            <Form.Item name="baseUnitId" label={t('items.baseUnit')} rules={[{ required: true }]} style={{ flex: 1, minWidth: 160 }}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={!!editing}
                options={(units ?? [])
                  .filter((u) => u.id)
                  .map((u) => ({
                    value: u.id,
                    label: `${u.code} — ${u.nameAr}${u.unEceCode ? ` (${u.unEceCode})` : ''}`,
                  }))}
              />
            </Form.Item>
            <Form.Item name="itemGroupId" label={t('items.group')} style={{ flex: 1, minWidth: 160 }}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={(groups ?? [])
                  .filter((g) => g.isActive)
                  .map((g) => ({ value: g.id, label: `${g.code} — ${g.nameAr}` }))}
              />
            </Form.Item>
            <Form.Item name="taxCategoryId" label={t('items.taxCategory')} style={{ flex: 1, minWidth: 160 }}>
              <Select
                allowClear
                options={(taxCategories ?? []).map((tc) => ({
                  value: tc.id,
                  label: `${tc.code} — ${tc.nameAr} (${tc.rate}%)`,
                }))}
              />
            </Form.Item>
          </Space>

          <Typography.Title level={5}>{t('items.pricing')}</Typography.Title>
          <Space style={{ display: 'flex' }} wrap>
            <Form.Item name="salePrice" label={t('items.salePrice')} style={{ flex: 1, minWidth: 120 }}>
              <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="purchasePrice" label={t('items.purchasePrice')} style={{ flex: 1, minWidth: 120 }}>
              <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="salePriceIncludesTax" label={t('items.priceIncludesTax')} valuePropName="checked" style={{ minWidth: 140 }}>
              <Switch />
            </Form.Item>
          </Space>

          <Typography.Title level={5}>{t('items.inventory')}</Typography.Title>
          <Space style={{ display: 'flex' }} wrap>
            <Form.Item noStyle shouldUpdate>
              {({ getFieldValue }) =>
                getFieldValue('itemKind') === 'STOCK' ? (
                  <>
                    <Form.Item name="minStock" label={t('items.minStock')} style={{ flex: 1, minWidth: 110 }}>
                      <InputNumber min={0} step={0.000001} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="maxStock" label={t('items.maxStock')} style={{ flex: 1, minWidth: 110 }}>
                      <InputNumber min={0} step={0.000001} style={{ width: '100%' }} />
                    </Form.Item>
                    <Form.Item name="defaultWarehouseId" label={t('items.defaultWarehouse')} style={{ flex: 1, minWidth: 160 }}>
                      <Select
                        allowClear
                        options={(warehouses ?? []).map((w) => ({ value: w.id, label: `${w.code} — ${w.nameAr}` }))}
                      />
                    </Form.Item>
                  </>
                ) : null
              }
            </Form.Item>
          </Space>
        </Form>
      </Modal>

      <LedgerModal item={ledgerItem} onClose={() => setLedgerItem(null)} warehouses={warehouses ?? []} />
      <BarcodeModal item={barcodeItem} onClose={() => setBarcodeItem(null)} />
      </Card>
    </div>
  );
}

// ------------------------------------------------------------- ledger modal

function LedgerModal({
  item,
  onClose,
  warehouses,
}: {
  item: Item | null;
  onClose: () => void;
  warehouses: { id: string; code: string; nameAr: string }[];
}) {
  const { t } = useTranslation();
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [from, setFrom] = useState<Dayjs | null>(null);
  const [to, setTo] = useState<Dayjs | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['item-ledger', item?.id, warehouseId, from?.format('YYYY-MM-DD'), to?.format('YYYY-MM-DD')],
    queryFn: () =>
      stockReportsControllerItemLedger(item!.id, {
        warehouseId: warehouseId ?? '',
        sourceType: '',
        from: from?.format('YYYY-MM-DD') ?? '',
        to: to?.format('YYYY-MM-DD') ?? '',
      }).then((r) => r.data as unknown as LedgerResponse),
    enabled: !!item,
  });

  const unit = data?.item?.baseUnit?.code ?? item?.baseUnit?.code ?? '';
  const rows = (data?.rows ?? []) as LedgerRow[];

  return (
    <Modal
      open={!!item}
      title={item ? `${t('items.ledger')} — ${item.code} ${item.nameAr}` : ''}
      onCancel={onClose}
      footer={null}
      width={1100}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t('stock.warehouse')}
          style={{ width: 200 }}
          options={warehouses.map((w) => ({ value: w.id, label: `${w.code} — ${w.nameAr}` }))}
          value={warehouseId}
          onChange={setWarehouseId}
        />
        <DatePicker placeholder={t('items.from')} value={from} onChange={setFrom} />
        <DatePicker placeholder={t('items.to')} value={to} onChange={setTo} />
        {(data?.balances?.length ?? 0) > 0 && (
          <Typography.Text type="secondary">
            {t('items.onHand')}:{' '}
            {data!.balances.map((b) => `${b.warehouse.code}: ${Number(b.qtyOnHand).toFixed(3)}`).join(' · ')}
          </Typography.Text>
        )}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: 900 }}
        columns={[
          {
            title: t('items.date'),
            dataIndex: 'movementDate',
            width: 110,
            render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
          },
          {
            title: t('stock.warehouse'),
            width: 130,
            render: (_: unknown, r: LedgerRow) => `${r.warehouse.code} — ${r.warehouse.nameAr}`,
          },
          {
            title: t('items.source'),
            width: 170,
            render: (_: unknown, r: LedgerRow) => `${r.sourceType}${r.sourceId ? ` #${r.sourceId}` : ''}`,
          },
          {
            title: t('items.qtyIn'),
            dataIndex: 'qtyIn',
            width: 100,
            align: 'end' as const,
            render: (v: string) => (Number(v) > 0 ? `${Number(v).toFixed(3)} ${unit}` : '—'),
          },
          {
            title: t('items.qtyOut'),
            dataIndex: 'qtyOut',
            width: 100,
            align: 'end' as const,
            render: (v: string) => (Number(v) > 0 ? `${Number(v).toFixed(3)} ${unit}` : '—'),
          },
          {
            title: t('items.balance'),
            dataIndex: 'balanceQtyAfter',
            width: 110,
            align: 'end' as const,
            render: (v: string) => `${Number(v).toFixed(3)} ${unit}`,
          },
          {
            title: t('items.unitCost'),
            dataIndex: 'unitCost',
            width: 100,
            align: 'end' as const,
            render: (v: string) => Number(v).toFixed(3),
          },
          {
            title: t('items.wac'),
            dataIndex: 'avgCostAfter',
            width: 100,
            align: 'end' as const,
            render: (v: string) => Number(v).toFixed(3),
          },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={4}>
              <Typography.Text strong>{t('items.totals')}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="end">
              <Typography.Text strong>
                {Number(data?.totals?.qtyIn ?? 0).toFixed(3)} /{' '}
                {Number(data?.totals?.qtyOut ?? 0).toFixed(3)}
              </Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} colSpan={3} />
          </Table.Summary.Row>
        )}
      />
    </Modal>
  );
}

// ------------------------------------------------------------- barcode modal

function BarcodeModal({ item, onClose }: { item: Item | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useQuery({
    queryKey: ['item-detail', item?.id],
    queryFn: () => catalogControllerGetItem(item!.id).then((r) => r.data as unknown as ItemDetail),
    enabled: !!item,
  });

  const barcodes = (data?.barcodes ?? []).map((b) => b.barcode);
  if (barcodes.length === 0 && data) barcodes.push(data.code);

  return (
    <Modal
      open={!!item}
      title={item ? `${t('items.barcode')} — ${item.nameAr}` : ''}
      onCancel={onClose}
      footer={[
        <Button key="close" onClick={onClose}>{t('common.close')}</Button>,
        <Button key="print" type="primary" onClick={() => window.print()}>
          {t('items.print')}
        </Button>,
      ]}
    >
      {isLoading ? (
        <Typography.Text>{t('common.loading')}</Typography.Text>
      ) : (
        <div className="barcode-labels">
          {barcodes.map((code) => (
            <div key={code} className="barcode-label">
              <div className="barcode-label-name">{data?.nameAr}</div>
              <svg ref={(el) => { if (el) JsBarcode(el, code, { format: 'CODE128', width: 1.4, height: 40, displayValue: true, fontSize: 12 }); }} />
              <div className="barcode-label-price">
                {data?.salePrice != null ? `${Number(data.salePrice).toFixed(2)}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .barcode-labels, .barcode-labels * { visibility: visible; }
          .barcode-labels { position: fixed; inset: 0; display: flex; flex-wrap: wrap; gap: 8px; padding: 8px; }
          .barcode-label { border: 1px dashed #999; padding: 6px; width: 45mm; text-align: center; page-break-inside: avoid; }
        }
        .barcode-label { border: 1px dashed #bbb; padding: 8px; margin: 4px; display: inline-block; width: 45mm; text-align: center; }
        .barcode-label-name { font-size: 11px; font-weight: 600; margin-bottom: 4px; }
        .barcode-label-price { font-size: 12px; font-weight: 700; margin-top: 2px; }
      `}</style>
    </Modal>
  );
}

// ------------------------------------------------------------- groups tab (unchanged)

function GroupsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show } = useApiError();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [form] = Form.useForm();

  const { data: groups, isLoading } = useQuery({
    queryKey: ['item-groups'],
    queryFn: () => catalogControllerListGroups().then((r) => r.data as unknown as Group[]),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['item-groups'] });

  const save = useMutation({
    mutationFn: async (v: {
      code?: string;
      nameAr: string;
      nameEn?: string;
      parentId?: string;
    }): Promise<unknown> =>
      editing
        ? catalogControllerUpdateGroup(editing.id, {
            nameAr: v.nameAr,
            nameEn: v.nameEn || null,
          } as never)
        : catalogControllerCreateGroup({
            code: v.code!,
            nameAr: v.nameAr,
            nameEn: v.nameEn || undefined,
            parentId: v.parentId || undefined,
          } as never),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: show,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => catalogControllerUpdateGroup(id, { isActive: false } as never),
    onSuccess: invalidate,
    onError: show,
  });

  const parentName = (id: string | null) =>
    id ? (groups ?? []).find((g) => g.id === id)?.nameAr ?? id : '—';

  return (
    <Card
      size="small"
      title={t('items.groups')}
      extra={
        <Button
          type="primary"
          size="small"
          onClick={() => {
            setEditing(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('items.addGroup')}
        </Button>
      }
    >
      {contextHolder}
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={groups ?? []}
        pagination={false}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('items.nameAr'), dataIndex: 'nameAr' },
          { title: t('items.nameEn'), dataIndex: 'nameEn', render: (v: string | null) => v ?? '—' },
          {
            title: t('items.parent'),
            dataIndex: 'parentId',
            width: 160,
            render: (v: string | null) => parentName(v),
          },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>,
          },
          {
            title: t('common.actions'),
            width: 140,
            render: (_: unknown, row: Group) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue({
                      nameAr: row.nameAr,
                      nameEn: row.nameEn,
                      parentId: row.parentId ?? undefined,
                    });
                    setModalOpen(true);
                  }}
                >
                  {t('common.edit')}
                </Button>
                {row.isActive && (
                  <Button size="small" danger onClick={() => deactivate.mutate(row.id)}>
                    {t('common.deactivate')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? t('items.editGroup') : t('items.addGroup')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          {!editing && (
            <Form.Item name="code" label={t('items.code')} rules={[{ required: true }]}>
              <Input maxLength={50} />
            </Form.Item>
          )}
          <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('items.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          {!editing && (
            <Form.Item name="parentId" label={t('items.parent')}>
              <Select
                allowClear
                options={(groups ?? [])
                  .filter((g) => g.isActive)
                  .map((g) => ({ value: g.id, label: `${g.code} — ${g.nameAr}` }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}

export function ItemsPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('items.title')}>
      <Tabs
        items={[
          { key: 'items', label: t('items.items'), children: <ItemsTab /> },
          { key: 'groups', label: t('items.groups'), children: <GroupsTab /> },
        ]}
      />
    </Card>
  );
}
