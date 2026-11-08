import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  DeleteOutlined,
  PlusOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import {
  Button,
  Card,
  DatePicker,
  Descriptions,
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
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  emptyInvoiceLine,
  InvoiceLinesGrid,
  type InvoiceItemOption,
  type InvoiceLineDraft,
} from '../components/InvoiceLinesGrid';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { StatusBar } from '../components/StatusBar';
import { PageHeader } from '../components/PageHeader';
import {
  ApiError,
  accountingControllerListAccounts,
  catalogControllerListItems,
  warehousesControllerList,
  partiesControllerList,
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
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';

// ------------------------------------------------------------------ types

interface Party {
  id: string;
  code: string;
  nameAr: string;
  partyType: string;
}
interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
}
interface Item {
  id: string;
  code: string;
  nameAr: string;
  itemKind: 'STOCK' | 'SERVICE';
  purchasePrice?: string | null;
  taxCategoryId?: string | null;
}
interface TaxCategory {
  id: string;
  rate: string;
  isDefault?: boolean;
}
interface AccountNode {
  id: string;
  code: string;
  nameAr: string;
  controlType?: string | null;
  children?: AccountNode[];
}
interface InvoiceLine {
  id: string;
  lineNo: number;
  itemId: string;
  qtyBase: string;
  unitCost: string;
  discountPct: string;
  netAmount: string;
  taxAmount: string;
  lineTotal: string;
  item?: { code: string; nameAr: string };
}
interface PurchaseInvoice {
  id: string;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  supplierId: string;
  supplierInvoiceNo?: string | null;
  supplierInvoiceDate?: string | null;
  warehouseId: string;
  paymentType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  netTotal: string;
  taxTotal: string;
  grandTotal: string;
  paidAmount: string;
  costTotal?: string;
  supplier?: Party;
  warehouse?: Warehouse;
  lines?: InvoiceLine[];
  journalEntry?: { entryNo: string | null } | null;
}
interface ReturnLine {
  id: string;
  originalLineId: string;
  itemId: string;
  qtyBase: string;
  lineTotal: string;
  item?: { code: string; nameAr: string };
  originalLine?: { lineNo: number };
}
interface PurchaseReturn {
  id: string;
  returnNo: string | null;
  returnDate: string;
  originalInvoiceId: string;
  refundType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  grandTotal: string;
  reason?: string | null;
  supplier?: Party;
  originalInvoice?: { invoiceNo: string | null };
  lines?: ReturnLine[];
}

const money = (v?: string | null) => (v != null ? Number(v).toFixed(2) : '—');

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

function usePurchaseLookups() {
  const parties = useQuery({
    queryKey: ['parties', 'purchases'],
    queryFn: () =>
      partiesControllerList({ partyType: 'SUPPLIER', isActive: '' }).then(
        (r) => r.data as unknown as Party[],
      ),
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: () =>
      warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
  });
  const items = useQuery({
    queryKey: ['items'],
    queryFn: () =>
      catalogControllerListItems({ search: '', itemKind: '', isActive: '' }).then((r) => r.data as unknown as Item[]),
  });
  const taxes = useQuery({
    queryKey: ['tax-categories'],
    queryFn: () =>
      settingsControllerListTaxCategories().then((r) => r.data as unknown as TaxCategory[]),
  });
  const accounts = useQuery({
    queryKey: ['accounts-tree'],
    queryFn: () =>
      accountingControllerListAccounts().then((r) => r.data as unknown as AccountNode[]),
  });

  const taxRateById = useMemo(() => {
    const m = new Map<string, number>();
    for (const tc of taxes.data ?? []) m.set(tc.id, Number(tc.rate));
    return m;
  }, [taxes.data]);
  const defaultTaxId = useMemo(
    () => (taxes.data ?? []).find((x) => x.isDefault)?.id,
    [taxes.data],
  );

  const itemOptions: InvoiceItemOption[] = useMemo(
    () =>
      (items.data ?? [])
        .filter((i) => i.itemKind !== undefined)
        .map((i) => ({
          id: i.id,
          label: `${i.code} — ${i.nameAr}`,
          price: i.purchasePrice != null ? Number(i.purchasePrice) : null,
          taxRate: taxRateById.get(i.taxCategoryId ?? '') ?? taxRateById.get(defaultTaxId ?? '') ?? 0,
          itemKind: i.itemKind,
        })),
    [items.data, taxRateById, defaultTaxId],
  );

  const cashAccountOptions = useMemo(() => {
    const flat: { id: string; code: string; nameAr: string }[] = [];
    const walk = (ns: AccountNode[]) => {
      for (const n of ns) {
        if (n.controlType === 'CASH' || n.controlType === 'BANK') {
          flat.push({ id: n.id, code: n.code, nameAr: n.nameAr });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(accounts.data ?? []);
    return flat.map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }));
  }, [accounts.data]);

  return {
    parties: parties.data ?? [],
    warehouses: warehouses.data ?? [],
    itemOptions,
    cashAccountOptions,
  };
}

// ------------------------------------------------------------- invoices tab

function PurchaseInvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>('list');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = usePurchaseLookups();

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['purchase-invoices', statusFilter],
    queryFn: () =>
      purchasesControllerListInvoices({ status: statusFilter ?? '', paymentType: '', supplierId: '' }).then(
        (r) => r.data as unknown as PurchaseInvoice[],
      ),
    enabled: screen === 'list',
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['purchase-invoice', invoiceId],
    queryFn: () =>
      purchasesControllerGetInvoice(invoiceId!).then((r) => r.data as unknown as PurchaseInvoice),
    enabled: (screen === 'view' || screen === 'form') && !!invoiceId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-invoice'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) => purchasesControllerPostInvoice(id, idemHeaders()),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => purchasesControllerDeleteInvoice(id),
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
      width: 140,
      render: (v: string | null, r: PurchaseInvoice) => v ?? `#${r.id}`,
    },
    {
      title: t('purchases.date'),
      dataIndex: 'invoiceDate',
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('purchases.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseInvoice) => r.supplier?.nameAr ?? '—',
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
      width: 120,
      align: 'end' as const,
      render: money,
    },
    {
      title: t('purchases.paid'),
      dataIndex: 'paidAmount',
      width: 110,
      align: 'end' as const,
      render: money,
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
      <PurchaseInvoiceView
        invoice={detail}
        loading={detailLoading}
        onBack={() => {
          setScreen('list');
          setInvoiceId(null);
        }}
        onEdit={() => setScreen('form')}
        onPost={(id) => post.mutate(id)}
        onDelete={(id) => del.mutate(id)}
        posting={post.isPending}
      />
    );
  }

  return (
    <div>
      {contextHolder}
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
        <Select
          allowClear
          placeholder={t('common.status')}
          style={{ width: 160 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'DRAFT', label: t('common.draft') },
            { value: 'POSTED', label: t('common.posted') },
          ]}
        />
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
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={invoices ?? []}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
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
}: {
  lookups: ReturnType<typeof usePurchaseLookups>;
  invoice?: PurchaseInvoice;
  loading: boolean;
  isNew: boolean;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const [invoiceDate, setInvoiceDate] = useState<Dayjs>(
    invoice ? dayjs(invoice.invoiceDate) : dayjs(),
  );
  const [dueDate, setDueDate] = useState<Dayjs | null>(
    invoice?.dueDate ? dayjs(invoice.dueDate) : null,
  );
  const [supplierId, setSupplierId] = useState<string | undefined>(invoice?.supplierId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(invoice?.warehouseId);
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>(
    invoice?.paymentType ?? 'CREDIT',
  );
  const [supplierInvoiceNo, setSupplierInvoiceNo] = useState<string | undefined>(
    invoice?.supplierInvoiceNo ?? undefined,
  );
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState<Dayjs | null>(
    invoice?.supplierInvoiceDate ? dayjs(invoice.supplierInvoiceDate) : null,
  );
  const [cashAccountId, setCashAccountId] = useState<string | undefined>();
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => {
    if (invoice?.lines?.length) {
      return invoice.lines.map((l, i) => ({
        key: i + 1,
        itemId: l.itemId,
        qty: Number(l.qtyBase),
        price: Number(l.unitCost),
        discountPct: Number(l.discountPct),
      }));
    }
    return [emptyInvoiceLine(1), emptyInvoiceLine(2)];
  });

  const supplierOptions = lookups.parties.map((p) => ({
    value: p.id,
    label: `${p.code} — ${p.nameAr}`,
  }));
  const warehouseOptions = lookups.warehouses.map((w) => ({
    value: w.id,
    label: `${w.code} — ${w.nameAr}`,
  }));

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        invoiceDate: invoiceDate.format('YYYY-MM-DD'),
        dueDate: dueDate?.format('YYYY-MM-DD'),
        supplierId,
        warehouseId,
        paymentType,
        cashAccountId: paymentType === 'CASH' ? cashAccountId : undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitCost: String(l.price ?? 0),
            discountPct: l.discountPct != null ? String(l.discountPct) : undefined,
          })),
      } as never;
      const res = isNew
        ? await purchasesControllerCreateInvoice(payload)
        : await purchasesControllerUpdateInvoice(invoice!.id, payload);
      return res as never;
    },
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      const data = (res as { data?: { id: string } }).data;
      onSaved(data?.id ?? invoice?.id ?? '');
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const canSave =
    !!supplierId && !!warehouseId && (paymentType === 'CREDIT' || !!cashAccountId) &&
    lines.some((l) => l.itemId && l.qty);

  if (loading) return <Typography.Text>{t('common.loading')}</Typography.Text>;

  return (
    <Card
      title={
        <Space>
          <Button
            type="text"
            icon={i18n.dir() === 'rtl' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
            onClick={onBack}
          />
          {isNew ? t('purchases.newInvoice') : invoice?.invoiceNo ?? `#${invoice?.id}`}
        </Space>
      }
    >
      {contextHolder}
      <Space wrap style={{ marginBottom: 16 }}>
        <div data-field="supplier" onKeyDown={enterTo(() => focusNamedField('warehouse'))}>
          <Typography.Text type="secondary">{t('purchases.supplier')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 260, display: 'block' }}
            options={supplierOptions}
            value={supplierId}
            onChange={setSupplierId}
          />
        </div>
        <div data-field="warehouse" onKeyDown={enterTo(() => focusNamedField('supplierInvoiceNo'))}>
          <Typography.Text type="secondary">{t('purchases.warehouse')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 200, display: 'block' }}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </div>
        <div
          data-field="supplierInvoiceNo"
          onKeyDown={enterTo(() => focusNamedField('supplierInvoiceDate'))}
        >
          <Typography.Text type="secondary">{t('purchases.supplierInvoiceNo')}</Typography.Text>
          <Input
            style={{ width: 160, display: 'block' }}
            value={supplierInvoiceNo}
            onChange={(e) => setSupplierInvoiceNo(e.target.value)}
            maxLength={100}
          />
        </div>
        <div
          data-field="supplierInvoiceDate"
          onKeyDown={enterTo(() => focusNamedField('invoiceDate'))}
        >
          <Typography.Text type="secondary">{t('purchases.supplierInvoiceDate')}</Typography.Text>
          <DatePicker
            style={{ display: 'block' }}
            value={supplierInvoiceDate}
            onChange={setSupplierInvoiceDate}
            allowClear
          />
        </div>
        <div data-field="invoiceDate" onKeyDown={enterTo(() => focusNamedField('dueDate'))}>
          <Typography.Text type="secondary">{t('purchases.invoiceDate')}</Typography.Text>
          <DatePicker
            style={{ display: 'block' }}
            value={invoiceDate}
            onChange={(d) => d && setInvoiceDate(d)}
          />
        </div>
        <div data-field="dueDate" onKeyDown={enterTo(() => focusNamedField('paymentType'))}>
          <Typography.Text type="secondary">{t('purchases.dueDate')}</Typography.Text>
          <DatePicker
            style={{ display: 'block' }}
            value={dueDate}
            onChange={setDueDate}
            allowClear
          />
        </div>
        <div
          data-field="paymentType"
          onKeyDown={enterTo(() =>
            paymentType === 'CASH' ? focusNamedField('cashAccount') : focusFirstGridCell(),
          )}
        >
          <Typography.Text type="secondary">{t('purchases.paymentType')}</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 140, display: 'block' }}
            value={paymentType}
            onChange={setPaymentType}
            options={[
              { value: 'CASH', label: t('purchases.CASH') },
              { value: 'CREDIT', label: t('purchases.CREDIT') },
            ]}
          />
        </div>
        {paymentType === 'CASH' && (
          <div data-field="cashAccount" onKeyDown={enterTo(focusFirstGridCell)}>
            <Typography.Text type="secondary">{t('purchases.cashAccount')}</Typography.Text>
            <GridSelect
              enterOpens
              style={{ width: 220, display: 'block' }}
              options={lookups.cashAccountOptions}
              value={cashAccountId}
              onChange={setCashAccountId}
            />
          </div>
        )}
      </Space>

      <InvoiceLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={lookups.itemOptions}
        priceLabel={t('purchases.unitCost')}
        focusSignal={1}
      />

      <div style={{ marginTop: 16, textAlign: 'end' }}>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          disabled={!canSave}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {isNew ? t('common.saveDraft') : t('common.save')}
        </Button>
      </div>
    </Card>
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
  invoice?: PurchaseInvoice;
  loading: boolean;
  onBack: () => void;
  onEdit: () => void;
  onPost: (id: string) => void;
  onDelete: (id: string) => void;
  posting: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [, contextHolder] = message.useMessage();
  if (loading || !invoice) {
    return <Typography.Text>{t('common.loading')}</Typography.Text>;
  }
  const isDraft = invoice.status === 'DRAFT';
  return (
    <Card
      title={
        <Space>
          <Button
            type="text"
            icon={i18n.dir() === 'rtl' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
            onClick={onBack}
          />
          <Typography.Text strong>
            {invoice.invoiceNo ?? `#${invoice.id}`}
          </Typography.Text>
          <Tag color={invoice.paymentType === 'CASH' ? 'green' : 'blue'}>
            {t(`purchases.${invoice.paymentType}`)}
          </Tag>
          <StatusBar status={invoice.status} />
        </Space>
      }
      extra={
        <Space>
          {contextHolder}
          {isDraft && (
            <>
              <Button onClick={onEdit}>{t('common.edit')}</Button>
              <Popconfirm
                title={t('purchases.postConfirm')}
                onConfirm={() => {
                  onPost(invoice.id);
                }}
              >
                <Button type="primary" loading={posting}>
                  {t('common.post')}
                </Button>
              </Popconfirm>
              <Popconfirm
                title={t('common.deleteConfirm')}
                onConfirm={() => onDelete(invoice.id)}
              >
                <Button danger icon={<DeleteOutlined />} />
              </Popconfirm>
            </>
          )}
        </Space>
      }
    >
      <Descriptions size="small" column={3} style={{ marginBottom: 16 }}>
        <Descriptions.Item label={t('purchases.supplier')}>
          {invoice.supplier?.nameAr}
        </Descriptions.Item>
        <Descriptions.Item label={t('purchases.supplierInvoiceNo')}>
          {invoice.supplierInvoiceNo ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('purchases.invoiceDate')}>
          {dayjs(invoice.invoiceDate).format('YYYY-MM-DD')}
        </Descriptions.Item>
        <Descriptions.Item label={t('purchases.dueDate')}>
          {invoice.dueDate ? dayjs(invoice.dueDate).format('YYYY-MM-DD') : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('purchases.net')}>{money(invoice.netTotal)}</Descriptions.Item>
        <Descriptions.Item label={t('purchases.tax')}>{money(invoice.taxTotal)}</Descriptions.Item>
        <Descriptions.Item label={t('purchases.grandTotal')}>
          <Typography.Text strong>{money(invoice.grandTotal)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('purchases.paid')}>{money(invoice.paidAmount)}</Descriptions.Item>
        {!!invoice.costTotal && Number(invoice.costTotal) > 0 && (
          <Descriptions.Item label={t('purchases.costTotal')}>
            {money(invoice.costTotal)}
          </Descriptions.Item>
        )}
      </Descriptions>
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
              l.item ? `${l.item.code} — ${l.item.nameAr}` : l.itemId,
          },
          { title: t('stock.qty'), dataIndex: 'qtyBase', width: 90, align: 'end' as const, render: money },
          { title: t('purchases.unitCost'), dataIndex: 'unitCost', width: 110, align: 'end' as const, render: money },
          { title: t('purchases.discountPct'), dataIndex: 'discountPct', width: 90, align: 'end' as const },
          { title: t('purchases.net'), dataIndex: 'netAmount', width: 110, align: 'end' as const, render: money },
          { title: t('purchases.tax'), dataIndex: 'taxAmount', width: 100, align: 'end' as const, render: money },
          { title: t('purchases.total'), dataIndex: 'lineTotal', width: 110, align: 'end' as const, render: money },
        ]}
      />
    </Card>
  );
}

// ------------------------------------------------------------- returns tab

function PurchaseReturnsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  const { data: returns, isLoading } = useQuery({
    queryKey: ['purchase-returns', statusFilter],
    queryFn: () =>
      purchasesControllerListReturns({ status: statusFilter ?? '' }).then(
        (r) => r.data as unknown as PurchaseReturn[],
      ),
  });
  const { data: view } = useQuery({
    queryKey: ['purchase-return', viewId],
    queryFn: () =>
      purchasesControllerGetReturn(viewId!).then((r) => r.data as unknown as PurchaseReturn),
    enabled: !!viewId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['purchase-returns'] });
    void queryClient.invalidateQueries({ queryKey: ['purchase-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) => purchasesControllerPostReturn(id, idemHeaders()),
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
      width: 140,
      render: (v: string | null, r: PurchaseReturn) => v ?? `#${r.id}`,
    },
    {
      title: t('purchases.date'),
      dataIndex: 'returnDate',
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('purchases.invoice'),
      dataIndex: 'originalInvoice',
      render: (_: unknown, r: PurchaseReturn) => r.originalInvoice?.invoiceNo ?? `#${r.originalInvoiceId}`,
    },
    {
      title: t('purchases.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseReturn) => r.supplier?.nameAr ?? '—',
    },
    {
      title: t('purchases.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`purchases.${v}`)}</Tag>,
    },
    { title: t('purchases.grandTotal'), dataIndex: 'grandTotal', width: 120, align: 'end' as const, render: money },
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
      render: (_: unknown, r: PurchaseReturn) => (
        <Space>
          <Button size="small" onClick={() => setViewId(r.id)}>{t('common.view')}</Button>
          {r.status === 'DRAFT' && (
            <>
              <Button size="small" type="primary" onClick={() => post.mutate(r.id)}>
                {t('common.post')}
              </Button>
              <Button size="small" danger onClick={() => del.mutate(r.id)}>
                {t('common.delete')}
              </Button>
            </>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {contextHolder}
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
        <Select
          allowClear
          placeholder={t('common.status')}
          style={{ width: 160 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'DRAFT', label: t('common.draft') },
            { value: 'POSTED', label: t('common.posted') },
          ]}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          {t('purchases.newReturn')}
        </Button>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={returns ?? []}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
      />
      <PurchaseReturnModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          invalidate();
        }}
      />
      <Modal
        open={!!viewId}
        title={view?.returnNo ?? t('purchases.returnDetail')}
        onCancel={() => setViewId(null)}
        footer={null}
        width={720}
      >
        {view && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={t('purchases.invoice')}>
                {view.originalInvoice?.invoiceNo}
              </Descriptions.Item>
              <Descriptions.Item label={t('purchases.supplier')}>
                {view.supplier?.nameAr}
              </Descriptions.Item>
              <Descriptions.Item label={t('purchases.refundType')}>
                {t(`purchases.${view.refundType}`)}
              </Descriptions.Item>
              <Descriptions.Item label={t('purchases.grandTotal')}>
                {money(view.grandTotal)}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={view.lines ?? []}
              columns={[
                { title: '#', width: 50, render: (_: unknown, l: ReturnLine) => l.originalLine?.lineNo },
                {
                  title: t('items.title'),
                  render: (_: unknown, l: ReturnLine) =>
                    l.item ? `${l.item.code} — ${l.item.nameAr}` : l.itemId,
                },
                { title: t('stock.qty'), dataIndex: 'qtyBase', width: 100, align: 'end' as const, render: money },
                { title: t('purchases.total'), dataIndex: 'lineTotal', width: 120, align: 'end' as const, render: money },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  );
}

function PurchaseReturnModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
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
  const [qtyByLine, setQtyByLine] = useState<Record<string, number>>({});

  const lookups = usePurchaseLookups();
  const { data: invoices } = useQuery({
    queryKey: ['purchase-invoices', 'POSTED'],
    queryFn: () =>
      purchasesControllerListInvoices({ status: 'POSTED', paymentType: '', supplierId: '' }).then(
        (r) => r.data as unknown as PurchaseInvoice[],
      ),
    enabled: open,
  });
  const { data: invoice } = useQuery({
    queryKey: ['purchase-invoice', invoiceId],
    queryFn: () =>
      purchasesControllerGetInvoice(invoiceId!).then((r) => r.data as unknown as PurchaseInvoice),
    enabled: !!invoiceId,
  });

  const create = useMutation({
    mutationFn: () =>
      purchasesControllerCreateReturn({
        returnDate: returnDate.format('YYYY-MM-DD'),
        originalInvoiceId: invoiceId,
        refundType,
        cashAccountId: refundType === 'CASH' ? cashAccountId : undefined,
        reason: reason || undefined,
        lines: (invoice?.lines ?? [])
          .filter((l) => (qtyByLine[l.id] ?? 0) > 0)
          .map((l) => ({ originalLineId: l.id, qty: String(qtyByLine[l.id]) })),
      } as never),
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
      const id = (created as { data?: { id: string } }).data?.id;
      if (!id) throw new Error('no id');
      await purchasesControllerPostReturn(id, idemHeaders());
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

  const hasLines = Object.values(qtyByLine).some((q) => q > 0);

  return (
    <Modal
      open={open}
      title={t('purchases.newReturn')}
      onCancel={onClose}
      width={760}
      footer={[
        <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button
          key="draft"
          disabled={!invoiceId || !hasLines}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          {t('common.saveDraft')}
        </Button>,
        <Button
          key="post"
          type="primary"
          disabled={!invoiceId || !hasLines}
          loading={postCreated.isPending}
          onClick={() => postCreated.mutate()}
        >
          {t('purchases.createAndPost')}
        </Button>,
      ]}
      destroyOnHidden
    >
      {contextHolder}
      <Space wrap style={{ marginBottom: 12 }}>
        <div>
          <Typography.Text type="secondary">{t('purchases.invoice')}</Typography.Text>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 280, display: 'block' }}
            options={(invoices ?? []).map((i) => ({
              value: i.id,
              label: `${i.invoiceNo ?? `#${i.id}`} — ${i.supplier?.nameAr ?? ''} — ${money(i.grandTotal)}`,
            }))}
            value={invoiceId}
            onChange={(v) => {
              setInvoiceId(v);
              setQtyByLine({});
            }}
          />
        </div>
        <div>
          <Typography.Text type="secondary">{t('purchases.date')}</Typography.Text>
          <DatePicker style={{ display: 'block' }} value={returnDate} onChange={(d) => d && setReturnDate(d)} />
        </div>
        <div>
          <Typography.Text type="secondary">{t('purchases.refundType')}</Typography.Text>
          <Select
            style={{ width: 140, display: 'block' }}
            value={refundType}
            onChange={setRefundType}
            options={[
              { value: 'CASH', label: t('purchases.CASH') },
              { value: 'CREDIT', label: t('purchases.CREDIT') },
            ]}
          />
        </div>
        {refundType === 'CASH' && (
          <div>
            <Typography.Text type="secondary">{t('purchases.cashAccount')}</Typography.Text>
            <Select
              showSearch
              optionFilterProp="label"
              style={{ width: 200, display: 'block' }}
              options={lookups.cashAccountOptions}
              value={cashAccountId}
              onChange={setCashAccountId}
            />
          </div>
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <Typography.Text type="secondary">{t('common.reason')}</Typography.Text>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </div>
      </Space>

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
                l.item ? `${l.item.code} — ${l.item.nameAr}` : l.itemId,
            },
            {
              title: t('stock.qty'),
              dataIndex: 'qtyBase',
              width: 100,
              align: 'end' as const,
              render: (v: string) => Number(v).toFixed(3),
            },
            {
              title: t('purchases.returnQty'),
              width: 130,
              render: (_: unknown, l: InvoiceLine) => (
                <InputNumber
                  min={0}
                  max={Number(l.qtyBase)}
                  value={qtyByLine[l.id] ?? 0}
                  onChange={(v) => setQtyByLine((m) => ({ ...m, [l.id]: v ?? 0 }))}
                  style={{ width: '100%' }}
                  size="small"
                />
              ),
            },
            {
              title: t('purchases.total'),
              dataIndex: 'lineTotal',
              width: 110,
              align: 'end' as const,
              render: money,
            },
          ]}
        />
      )}
    </Modal>
  );
}
