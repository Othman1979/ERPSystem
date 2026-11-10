import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BarcodeOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  FlagOutlined,
  PlusOutlined,
  InfoCircleOutlined,
  MoreOutlined,
  ProfileOutlined,
  AppstoreOutlined,
  TagOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import JsBarcode from 'jsbarcode';
import {
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Dropdown,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
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
import { useEffect, useRef, useState } from 'react';
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
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { ExportButtons } from '../components/ExportButtons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { OpeningNote, openingApi, type OpeningStockLine } from '../components/OpeningBalance';
import { codeAndName, displayName, type Named } from '../i18n/displayName';
import { Num } from '../components/Num';
import type Decimal from 'decimal.js';
import { amountCell, unitCostCell } from '../format/cells';
import { dec, formatAmount, formatQty } from '../format/number';

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
  baseUnitId?: string;
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

// API decimals stay strings in forms (InputNumber stringMode); blank becomes undefined.
const num = (v?: string | null) => v ?? undefined;

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
  const { modal } = App.useApp();
  const queryClient = useQueryClient();
  const { contextHolder, show } = useApiError();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  // The box updates on every keystroke; the API search waits until typing pauses.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(id);
  }, [searchInput]);
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [view, setView] = useState<'table' | 'cards'>('table');
  const [ledgerItem, setLedgerItem] = useState<Item | null>(null);
  const [barcodeItem, setBarcodeItem] = useState<Item | null>(null);
  const [form] = Form.useForm();
  const saveAndNew = useRef(false);

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

  const qtyByItem = new Map<string, Decimal>();
  for (const b of balances ?? []) {
    qtyByItem.set(b.itemId, dec(qtyByItem.get(b.itemId)).plus(dec(b.qtyOnHand)));
  }

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['items'] });
    void queryClient.invalidateQueries({ queryKey: ['stock-balances-all'] });
    void queryClient.invalidateQueries({ queryKey: ['opening-balances'] });
    void queryClient.invalidateQueries({ queryKey: ['opening-item'] });
  };

  // Opening stock per warehouse (ADR-007): editable until the item's first other movement.
  const { data: opening } = useQuery({ queryKey: ['opening-balances'], queryFn: openingApi.summary });
  const { data: itemOpening } = useQuery({
    queryKey: ['opening-item', editing?.id],
    queryFn: () => openingApi.itemStock(editing!.id),
    enabled: modalOpen && !!editing,
  });
  // Fill once per opened item — never over what the user typed (see AccountsPage).
  const openingFilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (modalOpen && itemOpening && itemOpening.itemId === editing?.id && openingFilledFor.current !== editing.id) {
      openingFilledFor.current = editing.id;
      form.setFieldsValue({
        openingStock: itemOpening.lines.map((l) => ({ warehouseId: l.warehouseId, qty: l.qty, unitCost: l.unitCost })),
      });
    }
  }, [modalOpen, itemOpening, editing, form]);
  const watchedKind = Form.useWatch('itemKind', form) as string | undefined;
  const openingLoaded = editing ? itemOpening?.itemId === editing.id : !!opening;
  const openingLock = editing
    ? (openingLoaded ? itemOpening!.lockedReason : null)
    : (opening?.stockLockedReason ?? null);
  const openingEditable = openingLoaded && !openingLock && watchedKind === 'STOCK';
  /** Opening lines as the API takes them; rows without a warehouse or quantity are dropped. */
  const openingLines = (rows: unknown): OpeningStockLine[] =>
    ((rows ?? []) as { warehouseId?: string; qty?: string; unitCost?: string }[])
      .filter((r) => r?.warehouseId && dec(r.qty).gt(0))
      .map((r) => ({ warehouseId: r.warehouseId!, qty: dec(r.qty).toString(), unitCost: dec(r.unitCost).toString() }));
  const sameLines = (a: OpeningStockLine[], b: OpeningStockLine[]) => {
    const key = (l: OpeningStockLine) => `${l.warehouseId}:${dec(l.qty).toString()}:${dec(l.unitCost).toString()}`;
    const x = a.map(key).sort();
    const y = b.map(key).sort();
    return x.length === y.length && x.every((k, i) => k === y[i]);
  };

  const save = useMutation({
    mutationFn: async (all: Record<string, unknown>): Promise<unknown> => {
      const { openingStock, ...v } = all;
      const payload = {
        ...v,
        salePrice: v.salePrice ?? undefined,
        purchasePrice: v.purchasePrice ?? undefined,
        minStock: v.minStock ?? undefined,
        maxStock: v.maxStock ?? undefined,
        itemGroupId: v.itemGroupId || undefined,
        defaultWarehouseId: v.defaultWarehouseId || undefined,
        imageUrl: v.imageUrl || undefined,
        nameEn: v.nameEn || undefined,
        description: v.description || undefined,
        taxCategoryId: v.taxCategoryId || undefined,
      };
      // An update takes no code, kind or base unit (UpdateItemDto rejects unknown fields).
      const update: Record<string, unknown> = { ...payload };
      for (const k of ['code', 'itemKind', 'baseUnitId']) delete update[k];
      const res = editing
        ? await catalogControllerUpdateItem(editing.id, update as never)
        : await catalogControllerCreateItem(payload as never);
      const saved = (res as unknown as { data: Item }).data;
      // If the opening stock fails below, a retry edits this item instead of adding
      // another — keeping the typed lines.
      if (!editing) {
        openingFilledFor.current = saved.id;
        setEditing(saved);
      }
      const target = openingLines(openingStock);
      const before = editing && itemOpening ? itemOpening.lines : [];
      if (openingEditable && !sameLines(target, before)) await openingApi.setItemStock(saved.id, target);
      return res;
    },
    onSuccess: () => {
      invalidate();
      form.resetFields();
      if (saveAndNew.current) {
        // Save & new: keep the dialog open on an empty form for the next item.
        saveAndNew.current = false;
        setEditing(null);
        requestAnimationFrame(() => form.getFieldInstance('code')?.focus?.());
        return;
      }
      setModalOpen(false);
      setEditing(null);
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
    openingFilledFor.current = null;
    form.resetFields();
    form.setFieldsValue({ itemKind: 'STOCK', salePriceIncludesTax: false });
    setModalOpen(true);
  };
  const openEdit = (row: Item) => {
    setEditing(row);
    openingFilledFor.current = null;
    form.setFieldsValue({
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      description: row.description,
      itemKind: row.itemKind,
      baseUnitId: row.baseUnitId,
      itemGroupId: row.itemGroup?.id ?? undefined,
      taxCategoryId: row.taxCategory?.id ?? undefined,
      defaultWarehouseId: row.defaultWarehouse?.id ?? undefined,
      salePrice: num(row.salePrice),
      purchasePrice: num(row.purchasePrice),
      minStock: num(row.minStock),
      maxStock: num(row.maxStock),
      salePriceIncludesTax: row.salePriceIncludesTax,
      imageUrl: row.imageUrl ?? undefined,
      openingStock: [],
    });
    setModalOpen(true);
  };

  const stockBadge = (r: Item) => {
    if (r.itemKind !== 'STOCK') return <Tag>{t('items.service')}</Tag>;
    const qty = qtyByItem.get(r.id);
    if (qty === undefined) return <Tag color="default">0</Tag>;
    const min = dec(r.minStock);
    const color = qty.lte(0) ? 'red' : qty.lte(min) ? 'orange' : 'green';
    return (
      <Tag color={color}>
        <Num>{formatQty(qty)}</Num>
      </Tag>
    );
  };

  const columns = [
    { title: t('items.code'), dataIndex: 'code', width: 110 },
    { title: t('common.name'), key: 'name', render: (_: unknown, r: Named) => displayName(r) },
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
      align: 'right' as const,
      render: (_: unknown, r: Item) => stockBadge(r),
    },
    {
      title: t('items.salePrice'),
      dataIndex: 'salePrice',
      width: 100,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('items.purchasePrice'),
      dataIndex: 'purchasePrice',
      width: 110,
      align: 'right' as const,
      render: amountCell,
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
      width: 120,
      // One visible action per row; the rest live in the "⋯" menu.
      render: (_: unknown, row: Item) => (
        <Space size={4}>
          <Button size="small" onClick={() => openEdit(row)}>
            {t('common.edit')}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                ...(row.itemKind === 'STOCK'
                  ? [{ key: 'ledger', icon: <ProfileOutlined />, label: t('items.ledger') }]
                  : []),
                { key: 'barcode', icon: <BarcodeOutlined />, label: t('items.barcode') },
                ...(row.isActive
                  ? [
                      { type: 'divider' as const },
                      { key: 'deactivate', danger: true, label: t('common.deactivate') },
                    ]
                  : []),
              ],
              onClick: ({ key }) => {
                if (key === 'ledger') setLedgerItem(row);
                else if (key === 'barcode') setBarcodeItem(row);
                else if (key === 'deactivate')
                  modal.confirm({
                    title: t('items.deactivateConfirm', { name: displayName(row) }),
                    okText: t('common.deactivate'),
                    okButtonProps: { danger: true },
                    cancelText: t('common.cancel'),
                    onOk: () => deactivate.mutateAsync(row.id),
                  });
              },
            }}
          >
            <Button size="small" icon={<MoreOutlined />} aria-label={t('common.more')} />
          </Dropdown>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title={t('items.title')} />
      <Card size="small">
      {contextHolder}
      <ListToolbar
        search={searchInput}
        onSearch={setSearchInput}
        searchPlaceholder={t('items.search')}
        filters={
          <>
            <Select
              allowClear
              placeholder={t('items.kind')}
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
          </>
        }
        count={(items ?? []).length}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('items.add')}
          </Button>
        }
      />
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
                    <img src={r.imageUrl} alt={displayName(r)} style={{ height: 110, objectFit: 'cover' }} />
                  ) : undefined
                }
              >
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Typography.Text strong>{displayName(r)}</Typography.Text>
                    {r.itemKind === 'STOCK' ? (
                      <Tag color="blue">{t('items.stock')}</Tag>
                    ) : (
                      <Tag>{t('items.service')}</Tag>
                    )}
                  </Space>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.code} {r.baseUnit ? `· ${r.baseUnit.code}` : ''}
                    {r.itemGroup ? ` · ${displayName(r.itemGroup)}` : ''}
                  </Typography.Text>
                  <Space style={{ justifyContent: 'space-between', width: '100%' }}>
                    <span>{t('items.onHand')}: {stockBadge(r)}</span>
                    <Typography.Text strong>
                      {formatAmount(r.salePrice)}
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

      <FormDialog
        title={editing ? t('items.edit') : t('items.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => {
          saveAndNew.current = false;
          form.submit();
        }}
        onSaveAndNew={
          editing
            ? undefined
            : () => {
                saveAndNew.current = true;
                form.submit();
              }
        }
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('common.basicInfo')} icon={<InfoCircleOutlined />}>
            <Form.Item name="code" label={t('items.code')} rules={[{ required: true }]}>
              <Input maxLength={50} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="itemKind" label={t('items.kind')} initialValue="STOCK" className="span-2">
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                disabled={!!editing}
                options={[
                  { value: 'STOCK', label: t('items.stock') },
                  { value: 'SERVICE', label: t('items.service') },
                ]}
              />
            </Form.Item>
            <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]} className="span-2">
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('items.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="description" label={t('common.description')} className="span-all">
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
            <Form.Item name="imageUrl" label={t('items.imageUrl')} className="span-all">
              <Input maxLength={512} placeholder="https://…" />
            </Form.Item>
          </FormSection>

          <FormSection title={t('items.classification')} icon={<AppstoreOutlined />}>
            <Form.Item name="baseUnitId" label={t('items.baseUnit')} rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                disabled={!!editing}
                options={(units ?? [])
                  .filter((u) => u.id)
                  .map((u) => ({
                    value: u.id,
                    label: `${codeAndName(u)}${u.unEceCode ? ` (${u.unEceCode})` : ''}`,
                  }))}
              />
            </Form.Item>
            <Form.Item name="itemGroupId" label={t('items.group')}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={(groups ?? [])
                  .filter((g) => g.isActive)
                  .map((g) => ({ value: g.id, label: codeAndName(g) }))}
              />
            </Form.Item>
            <Form.Item name="taxCategoryId" label={t('items.taxCategory')}>
              <Select
                allowClear
                options={(taxCategories ?? []).map((tc) => ({
                  value: tc.id,
                  label: `${codeAndName(tc)} (${tc.rate}%)`,
                }))}
              />
            </Form.Item>
          </FormSection>

          <FormSection title={t('items.pricing')} icon={<TagOutlined />}>
            <Form.Item name="salePrice" label={t('items.salePrice')}>
              <InputNumber<string> stringMode min="0" step="0.001" />
            </Form.Item>
            <Form.Item name="purchasePrice" label={t('items.purchasePrice')}>
              <InputNumber<string> stringMode min="0" step="0.001" />
            </Form.Item>
            <Form.Item name="salePriceIncludesTax" label={t('items.priceIncludesTax')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </FormSection>

          {/* Stock settings only apply to stocked items. */}
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue('itemKind') === 'STOCK' ? (
                <FormSection title={t('items.inventory')} icon={<DatabaseOutlined />}>
                  <Form.Item name="minStock" label={t('items.minStock')}>
                    <InputNumber<string> stringMode min="0" step="0.000001" />
                  </Form.Item>
                  <Form.Item name="maxStock" label={t('items.maxStock')}>
                    <InputNumber<string> stringMode min="0" step="0.000001" />
                  </Form.Item>
                  <Form.Item name="defaultWarehouseId" label={t('items.defaultWarehouse')}>
                    <Select
                      allowClear
                      options={(warehouses ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }))}
                    />
                  </Form.Item>
                </FormSection>
              ) : null
            }
          </Form.Item>

          {watchedKind === 'STOCK' && (
            <FormSection title={t('opening.stockSection')} icon={<FlagOutlined />}>
              <div className="span-all">
                <Form.List
                  name="openingStock"
                  rules={[
                    {
                      validator: async (_, rows?: { warehouseId?: string; qty?: string; unitCost?: string }[]) => {
                        const started = (rows ?? []).filter((r) => r && (r.warehouseId || r.qty || r.unitCost));
                        if (started.some((r) => !r.warehouseId || !dec(r.qty).gt(0) || r.unitCost == null || r.unitCost === '')) {
                          throw new Error(t('opening.lineIncomplete'));
                        }
                        const ids = started.map((r) => r.warehouseId);
                        if (new Set(ids).size !== ids.length) throw new Error(t('opening.duplicateWarehouse'));
                      },
                    },
                  ]}
                >
                  {(fields, { add, remove }, { errors }) => (
                    <>
                    <table className="opening-stock-grid">
                      <thead>
                        <tr>
                          <th>{t('opening.warehouse')}</th>
                          <th className="num-cell">{t('opening.qty')}</th>
                          <th className="num-cell">{t('opening.unitCost')}</th>
                          <th className="num-cell">{t('opening.value')}</th>
                          <th style={{ width: 32 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((f) => (
                          <tr key={f.key}>
                            <td>
                              <Form.Item name={[f.name, 'warehouseId']} noStyle>
                                <Select
                                  size="small"
                                  disabled={!openingEditable}
                                  options={(warehouses ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }))}
                                  style={{ width: '100%' }}
                                />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[f.name, 'qty']} noStyle>
                                <InputNumber<string> size="small" stringMode min="0" disabled={!openingEditable} style={{ width: '100%' }} />
                              </Form.Item>
                            </td>
                            <td>
                              <Form.Item name={[f.name, 'unitCost']} noStyle>
                                <InputNumber<string> size="small" stringMode min="0" disabled={!openingEditable} style={{ width: '100%' }} />
                              </Form.Item>
                            </td>
                            <td className="num-cell">
                              <Form.Item noStyle shouldUpdate>
                                {({ getFieldValue }) => {
                                  const row = getFieldValue(['openingStock', f.name]) as { qty?: string; unitCost?: string } | undefined;
                                  return <Num>{formatAmount(dec(row?.qty).times(dec(row?.unitCost)))}</Num>;
                                }}
                              </Form.Item>
                            </td>
                            <td>
                              {openingEditable && (
                                <Button
                                  type="text"
                                  size="small"
                                  danger
                                  icon={<DeleteOutlined />}
                                  aria-label={t('common.delete')}
                                  onClick={() => remove(f.name)}
                                />
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      {openingEditable && (
                        <tfoot>
                          <tr>
                            <td colSpan={5}>
                              <Button
                                size="small"
                                type="dashed"
                                icon={<PlusOutlined />}
                                onClick={() => add({ warehouseId: form.getFieldValue('defaultWarehouseId') ?? warehouses?.[0]?.id })}
                              >
                                {t('opening.addLine')}
                              </Button>
                            </td>
                          </tr>
                        </tfoot>
                      )}
                    </table>
                    <Form.ErrorList errors={errors} />
                    </>
                  )}
                </Form.List>
              </div>
              <OpeningNote>
                {openingLock
                  ? t(`opening.locked.${openingLock}`)
                  : t('opening.stockPostedOn', { date: opening?.date?.slice(0, 10) ?? '' })}
              </OpeningNote>
            </FormSection>
          )}
        </Form>
      </FormDialog>

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
      title={item ? `${t('items.ledger')} — ${codeAndName(item)}` : ''}
      onCancel={onClose}
      footer={null}
      width={1100}
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder={t('stock.warehouse')}
          style={{ width: 200 }}
          options={warehouses.map((w) => ({ value: w.id, label: codeAndName(w) }))}
          value={warehouseId}
          onChange={setWarehouseId}
        />
        <DatePicker placeholder={t('items.from')} value={from} onChange={setFrom} />
        <DatePicker placeholder={t('items.to')} value={to} onChange={setTo} />
        {(data?.balances?.length ?? 0) > 0 && (
          <Typography.Text type="secondary">
            {t('items.onHand')}:{' '}
            {data!.balances.map((b) => `${b.warehouse.code}: ${formatQty(b.qtyOnHand)}`).join(' · ')}
          </Typography.Text>
        )}
        {item && (
          <ExportButtons
            path={`/stock/items/${item.id}/ledger`}
            params={{ warehouseId, from: from?.format('YYYY-MM-DD'), to: to?.format('YYYY-MM-DD') }}
          />
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
            render: (_: unknown, r: LedgerRow) => codeAndName(r.warehouse),
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
            align: 'right' as const,
            render: (v: string) => (dec(v).gt(0) ? <Num>{`${formatQty(v)} ${unit}`}</Num> : '—'),
          },
          {
            title: t('items.qtyOut'),
            dataIndex: 'qtyOut',
            width: 100,
            align: 'right' as const,
            render: (v: string) => (dec(v).gt(0) ? <Num>{`${formatQty(v)} ${unit}`}</Num> : '—'),
          },
          {
            title: t('items.balance'),
            dataIndex: 'balanceQtyAfter',
            width: 110,
            align: 'right' as const,
            render: (v: string) => <Num>{`${formatQty(v)} ${unit}`}</Num>,
          },
          {
            title: t('items.unitCost'),
            dataIndex: 'unitCost',
            width: 100,
            align: 'right' as const,
            render: unitCostCell,
          },
          {
            title: t('items.wac'),
            dataIndex: 'avgCostAfter',
            width: 100,
            align: 'right' as const,
            render: unitCostCell,
          },
        ]}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={4}>
              <Typography.Text strong>{t('items.totals')}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">
              <Typography.Text strong>
                <Num>{formatQty(data?.totals?.qtyIn ?? '0')}</Num> /{' '}
                <Num>{formatQty(data?.totals?.qtyOut ?? '0')}</Num>
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
      title={item ? `${t('items.barcode')} — ${displayName(item)}` : ''}
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
                {formatAmount(data?.salePrice, '')}
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
  const [search, setSearch] = useState('');
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
    id ? displayName((groups ?? []).find((g) => g.id === id)) ?? id : '—';

  const shown = (groups ?? []).filter((g) => matchesSearch(search, g.code, displayName(g)));

  return (
    <Card size="small" title={t('items.groups')}>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button
            type="primary"
            onClick={() => {
              setEditing(null);
              form.resetFields();
              setModalOpen(true);
            }}
          >
            {t('items.addGroup')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={shown}
        pagination={false}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('common.name'), key: 'name', render: (_: unknown, r: Group) => displayName(r) },
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
                  <Popconfirm title={t('common.confirmDeactivate')} onConfirm={() => deactivate.mutate(row.id)}>
<Button size="small" danger >
                    {t('common.deactivate')}
                  </Button>
</Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <FormDialog
        title={editing ? t('items.editGroup') : t('items.addGroup')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('items.groupDetails')} icon={<AppstoreOutlined />}>
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
                    .map((g) => ({ value: g.id, label: codeAndName(g) }))}
                />
              </Form.Item>
            )}
          </FormSection>
        </Form>
      </FormDialog>
    </Card>
  );
}

export function ItemsPage() {
  const { t } = useTranslation();
  // No card title: the list below already has its own header (it was shown twice).
  return (
    <Card>
      <Tabs
        items={[
          { key: 'items', label: t('items.items'), children: <ItemsTab /> },
          { key: 'groups', label: t('items.groups'), children: <GroupsTab /> },
        ]}
      />
    </Card>
  );
}
