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
import { useEffect, useMemo, useState } from 'react';
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
  settingsControllerListTaxCategories,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';

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
  salePrice?: string | null;
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
  nameEn?: string | null;
  controlType?: string | null;
  children?: AccountNode[];
}
interface InvoiceLine {
  id: string;
  lineNo: number;
  itemId: string;
  qtyBase: string;
  unitPrice: string;
  discountPct: string;
  netAmount: string;
  taxAmount: string;
  lineTotal: string;
  item?: { code: string; nameAr: string };
}
interface SalesInvoice {
  id: string;
  invoiceNo: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  customerId: string;
  warehouseId: string;
  paymentType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  netTotal: string;
  taxTotal: string;
  grandTotal: string;
  paidAmount: string;
  costTotal?: string;
  customer?: Party;
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
interface SalesReturn {
  id: string;
  returnNo: string | null;
  returnDate: string;
  originalInvoiceId: string;
  refundType: 'CASH' | 'CREDIT';
  status: 'DRAFT' | 'POSTED';
  grandTotal: string;
  reason?: string | null;
  customer?: Party;
  originalInvoice?: { invoiceNo: string | null };
  lines?: ReturnLine[];
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

function useSalesLookups() {
  const parties = useQuery({
    queryKey: ['parties', 'sales'],
    queryFn: () =>
      partiesControllerList({ partyType: 'CUSTOMER', isActive: '' }).then(
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
    const m = new Map<string, string>();
    for (const tc of taxes.data ?? []) m.set(tc.id, tc.rate);
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
          label: codeAndName(i),
          price: i.salePrice ?? null,
          taxRate: taxRateById.get(i.taxCategoryId ?? '') ?? taxRateById.get(defaultTaxId ?? '') ?? '0',
          itemKind: i.itemKind,
        })),
    [items.data, taxRateById, defaultTaxId],
  );

  const cashAccountOptions = useMemo(() => {
    const flat: { id: string; code: string; nameAr: string; nameEn?: string | null }[] = [];
    const walk = (ns: AccountNode[]) => {
      for (const n of ns) {
        if (n.controlType === 'CASH' || n.controlType === 'BANK') {
          flat.push({ id: n.id, code: n.code, nameAr: n.nameAr, nameEn: n.nameEn });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(accounts.data ?? []);
    return flat.map((a) => ({ value: a.id, label: codeAndName(a) }));
  }, [accounts.data]);

  return {
    parties: parties.data ?? [],
    warehouses: warehouses.data ?? [],
    itemOptions,
    cashAccountOptions,
  };
}

// ------------------------------------------------------------- invoices tab

function InvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>('list');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useSalesLookups();

  const { data: invoices, isLoading } = useQuery({
    queryKey: ['sales-invoices', statusFilter],
    queryFn: () =>
      salesControllerListInvoices({ status: statusFilter ?? '', paymentType: '', customerId: '' }).then(
        (r) => r.data as unknown as SalesInvoice[],
      ),
    enabled: screen === 'list',
  });

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: () =>
      salesControllerGetInvoice(invoiceId!).then((r) => r.data as unknown as SalesInvoice),
    enabled: (screen === 'view' || screen === 'form') && !!invoiceId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['sales-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['sales-invoice'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const post = useMutation({
    mutationFn: (id: string) => salesControllerPostInvoice(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => salesControllerDeleteInvoice(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      setScreen('list');
      invalidate();
    },
    onError,
  });

  const columns = [
    {
      title: t('sales.invoiceNo'),
      dataIndex: 'invoiceNo',
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesInvoice) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'invoiceDate',
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesInvoice) => displayName(r.customer) ?? '—',
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
      <InvoiceView
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
          {t('sales.newInvoice')}
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

function InvoiceForm({
  lookups,
  invoice,
  loading,
  isNew,
  onBack,
  onSaved,
}: {
  lookups: ReturnType<typeof useSalesLookups>;
  invoice?: SalesInvoice;
  loading: boolean;
  isNew: boolean;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
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
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>(
    invoice?.paymentType ?? 'CREDIT',
  );
  const [cashAccountId, setCashAccountId] = useState<string | undefined>();
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => {
    if (invoice?.lines?.length) {
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

  const customerOptions = lookups.parties.map((p) => ({
    value: p.id,
    label: codeAndName(p),
  }));
  const warehouseOptions = lookups.warehouses.map((w) => ({
    value: w.id,
    label: codeAndName(w),
  }));

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        invoiceDate: invoiceDate.format('YYYY-MM-DD'),
        dueDate: dueDate?.format('YYYY-MM-DD'),
        customerId,
        warehouseId,
        paymentType,
        cashAccountId: paymentType === 'CASH' ? cashAccountId : undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitPrice: l.price ?? '0',
            discountPct: l.discountPct ?? undefined,
          })),
      } as never;
      const res = isNew
        ? await salesControllerCreateInvoice(payload)
        : await salesControllerUpdateInvoice(invoice!.id, payload);
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
    !!customerId && !!warehouseId && (paymentType === 'CREDIT' || !!cashAccountId) &&
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
          {isNew ? t('sales.newInvoice') : invoice?.invoiceNo ?? `#${invoice?.id}`}
        </Space>
      }
    >
      {contextHolder}
      <Space wrap style={{ marginBottom: 16 }}>
        <div data-field="customer" onKeyDown={enterTo(() => focusNamedField('warehouse'))}>
          <Typography.Text type="secondary">{t('sales.customer')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 260, display: 'block' }}
            options={customerOptions}
            value={customerId}
            onChange={setCustomerId}
          />
        </div>
        <div data-field="warehouse" onKeyDown={enterTo(() => focusNamedField('invoiceDate'))}>
          <Typography.Text type="secondary">{t('sales.warehouse')} *</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 200, display: 'block' }}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </div>
        <div data-field="invoiceDate" onKeyDown={enterTo(() => focusNamedField('dueDate'))}>
          <Typography.Text type="secondary">{t('sales.invoiceDate')}</Typography.Text>
          <DatePicker
            style={{ display: 'block' }}
            value={invoiceDate}
            onChange={(d) => d && setInvoiceDate(d)}
          />
        </div>
        <div data-field="dueDate" onKeyDown={enterTo(() => focusNamedField('paymentType'))}>
          <Typography.Text type="secondary">{t('sales.dueDate')}</Typography.Text>
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
          <Typography.Text type="secondary">{t('sales.paymentType')}</Typography.Text>
          <GridSelect
            enterOpens
            style={{ width: 140, display: 'block' }}
            value={paymentType}
            onChange={setPaymentType}
            options={[
              { value: 'CASH', label: t('sales.CASH') },
              { value: 'CREDIT', label: t('sales.CREDIT') },
            ]}
          />
        </div>
        {paymentType === 'CASH' && (
          <div
            data-field="cashAccount"
            onKeyDown={enterTo(focusFirstGridCell)}
          >
            <Typography.Text type="secondary">{t('sales.cashAccount')}</Typography.Text>
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

function InvoiceView({
  invoice,
  loading,
  onBack,
  onEdit,
  onPost,
  onDelete,
  posting,
}: {
  invoice?: SalesInvoice;
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
            {t(`sales.${invoice.paymentType}`)}
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
                title={t('sales.postConfirm')}
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
        <Descriptions.Item label={t('sales.customer')}>
          {displayName(invoice.customer)}
        </Descriptions.Item>
        <Descriptions.Item label={t('sales.invoiceDate')}>
          {dayjs(invoice.invoiceDate).format('YYYY-MM-DD')}
        </Descriptions.Item>
        <Descriptions.Item label={t('sales.dueDate')}>
          {invoice.dueDate ? dayjs(invoice.dueDate).format('YYYY-MM-DD') : '—'}
        </Descriptions.Item>
        <Descriptions.Item label={t('sales.net')}>{money(invoice.netTotal)}</Descriptions.Item>
        <Descriptions.Item label={t('sales.tax')}>{money(invoice.taxTotal)}</Descriptions.Item>
        <Descriptions.Item label={t('sales.grandTotal')}>
          <Typography.Text strong>{money(invoice.grandTotal)}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('sales.paid')}>{money(invoice.paidAmount)}</Descriptions.Item>
        {dec(invoice.costTotal).gt(0) && (
          <Descriptions.Item label={t('sales.costTotal')}>
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
              l.item ? codeAndName(l.item) : l.itemId,
          },
          { title: t('stock.qty'), dataIndex: 'qtyBase', width: 90, align: 'right' as const, render: qtyCell },
          { title: t('sales.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('sales.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('sales.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('sales.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('sales.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
      />
    </Card>
  );
}

// ------------------------------------------------------------- returns tab

function ReturnsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  const { data: returns, isLoading } = useQuery({
    queryKey: ['sales-returns', statusFilter],
    queryFn: () =>
      salesControllerListReturns({ status: statusFilter ?? '' }).then(
        (r) => r.data as unknown as SalesReturn[],
      ),
  });
  const { data: view } = useQuery({
    queryKey: ['sales-return', viewId],
    queryFn: () =>
      salesControllerGetReturn(viewId!).then((r) => r.data as unknown as SalesReturn),
    enabled: !!viewId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['sales-returns'] });
    void queryClient.invalidateQueries({ queryKey: ['sales-invoices'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
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
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesReturn) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'returnDate',
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.invoice'),
      dataIndex: 'originalInvoice',
      render: (_: unknown, r: SalesReturn) => r.originalInvoice?.invoiceNo ?? `#${r.originalInvoiceId}`,
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesReturn) => displayName(r.customer) ?? '—',
    },
    {
      title: t('sales.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`sales.${v}`)}</Tag>,
    },
    { title: t('sales.grandTotal'), dataIndex: 'grandTotal', width: 120, align: 'right' as const, render: amountCell },
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
      render: (_: unknown, r: SalesReturn) => (
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
          {t('sales.newReturn')}
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
      <ReturnModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={() => {
          setModalOpen(false);
          invalidate();
        }}
      />
      <Modal
        open={!!viewId}
        title={view?.returnNo ?? t('sales.returnDetail')}
        onCancel={() => setViewId(null)}
        footer={null}
        width={720}
      >
        {view && (
          <>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={t('sales.invoice')}>
                {view.originalInvoice?.invoiceNo}
              </Descriptions.Item>
              <Descriptions.Item label={t('sales.customer')}>
                {displayName(view.customer)}
              </Descriptions.Item>
              <Descriptions.Item label={t('sales.refundType')}>
                {t(`sales.${view.refundType}`)}
              </Descriptions.Item>
              <Descriptions.Item label={t('sales.grandTotal')}>
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
                    l.item ? codeAndName(l.item) : l.itemId,
                },
                { title: t('stock.qty'), dataIndex: 'qtyBase', width: 100, align: 'right' as const, render: qtyCell },
                { title: t('sales.total'), dataIndex: 'lineTotal', width: 120, align: 'right' as const, render: amountCell },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  );
}

function ReturnModal({
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
  const [qtyByLine, setQtyByLine] = useState<Record<string, string>>({});

  const lookups = useSalesLookups();
  const { data: invoices } = useQuery({
    queryKey: ['sales-invoices', 'POSTED'],
    queryFn: () =>
      salesControllerListInvoices({ status: 'POSTED', paymentType: '', customerId: '' }).then(
        (r) => r.data as unknown as SalesInvoice[],
      ),
    enabled: open,
  });
  const { data: invoice } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: () =>
      salesControllerGetInvoice(invoiceId!).then((r) => r.data as unknown as SalesInvoice),
    enabled: !!invoiceId,
  });

  const create = useMutation({
    mutationFn: () =>
      salesControllerCreateReturn({
        returnDate: returnDate.format('YYYY-MM-DD'),
        originalInvoiceId: invoiceId,
        refundType,
        cashAccountId: refundType === 'CASH' ? cashAccountId : undefined,
        reason: reason || undefined,
        lines: (invoice?.lines ?? [])
          .filter((l) => dec(qtyByLine[l.id]).gt(0))
          .map((l) => ({ originalLineId: l.id, qty: qtyByLine[l.id] })),
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
      await salesControllerPostReturn(id, { headers: idemHeaders() });
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

  return (
    <Modal
      open={open}
      title={t('sales.newReturn')}
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
          {t('sales.createAndPost')}
        </Button>,
      ]}
      destroyOnHidden
    >
      {contextHolder}
      <Space wrap style={{ marginBottom: 12 }}>
        <div>
          <Typography.Text type="secondary">{t('sales.invoice')}</Typography.Text>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 280, display: 'block' }}
            options={(invoices ?? []).map((i) => ({
              value: i.id,
              label: `${i.invoiceNo ?? `#${i.id}`} — ${displayName(i.customer) ?? ''} — ${money(i.grandTotal)}`,
            }))}
            value={invoiceId}
            onChange={(v) => {
              setInvoiceId(v);
              setQtyByLine({});
            }}
          />
        </div>
        <div>
          <Typography.Text type="secondary">{t('sales.date')}</Typography.Text>
          <DatePicker style={{ display: 'block' }} value={returnDate} onChange={(d) => d && setReturnDate(d)} />
        </div>
        <div>
          <Typography.Text type="secondary">{t('sales.refundType')}</Typography.Text>
          <Select
            style={{ width: 140, display: 'block' }}
            value={refundType}
            onChange={setRefundType}
            options={[
              { value: 'CASH', label: t('sales.CASH') },
              { value: 'CREDIT', label: t('sales.CREDIT') },
            ]}
          />
        </div>
        {refundType === 'CASH' && (
          <div>
            <Typography.Text type="secondary">{t('sales.cashAccount')}</Typography.Text>
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
    </Modal>
  );
}
