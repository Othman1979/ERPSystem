import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, PrinterOutlined, SaveOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Radio,
  DatePicker,
  Input,
  InputNumber,
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
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { PrintPdfButton } from '../components/PrintPdfButton';
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
import { useNewFromUrl } from '../useNewFromUrl';
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
          price: i.purchasePrice ?? null,
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

function PurchaseInvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>('list');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = usePurchaseLookups();
  useNewFromUrl(() => {
    setInvoiceId(null);
    setScreen('form');
  });

  const invoicesQuery = useQuery({
    queryKey: ['purchase-invoices', statusFilter],
    queryFn: () =>
      purchasesControllerListInvoices({ status: statusFilter ?? '', paymentType: '', supplierId: '' }).then(
        (r) => r.data as unknown as PurchaseInvoice[],
      ),
    enabled: screen === 'list',
  });
  const { data: invoices, isLoading } = invoicesQuery;

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
    mutationFn: (id: string) => purchasesControllerPostInvoice(id, { headers: idemHeaders() }),
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
      className: 'nowrap',
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
      render: (_: unknown, r: PurchaseInvoice) => displayName(r.supplier) ?? '—',
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

  const shown = (invoices ?? []).filter((r) =>
    matchesSearch(search, r.invoiceNo, displayName(r.supplier), r.supplierInvoiceNo),
  );

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
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
        count={shown.length}
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
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(invoicesQuery)}
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
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
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
        qty: l.qtyBase,
        price: l.unitCost,
        discountPct: l.discountPct,
      }));
    }
    return [emptyInvoiceLine(1), emptyInvoiceLine(2)];
  });

  const supplierOptions = lookups.parties.map((p) => ({
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
        supplierId,
        warehouseId,
        paymentType,
        cashAccountId: paymentType === 'CASH' ? cashAccountId : undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitCost: l.price ?? '0',
            discountPct: l.discountPct ?? undefined,
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

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const missing = {
    supplier: !supplierId,
    warehouse: !warehouseId,
    cashAccount: paymentType === 'CASH' && !cashAccountId,
    lines: !lines.some((l) => l.itemId && l.qty),
  };
  const trySave = () => {
    if (save.isPending) return;
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

  if (loading) return <Typography.Text>{t('common.loading')}</Typography.Text>;

  return (
    <DocLayout
      title={isNew ? t('purchases.newInvoice') : t('purchases.invoiceTitle')}
      docNo={invoice?.invoiceNo}
      status="DRAFT"
      onBack={onBack}
      actions={
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={trySave}>
          {isNew ? t('common.saveDraft') : t('common.save')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      {contextHolder}
      <DocFields>
        <DocField
          field="supplier"
          label={t('purchases.supplier')}
          required
          error={requiredError(missing.supplier)}
          onKeyDown={enterTo(() => focusNamedField('warehouse'))}
        >
          <GridSelect
            enterOpens
            status={requiredError(missing.supplier) ? 'error' : undefined}
            options={supplierOptions}
            value={supplierId}
            onChange={setSupplierId}
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
            enterOpens
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
          onKeyDown={enterTo(() => focusNamedField('paymentType'))}
        >
          <DatePicker value={dueDate} onChange={setDueDate} allowClear />
        </DocField>
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
              enterOpens
              status={requiredError(missing.cashAccount) ? 'error' : undefined}
              options={lookups.cashAccountOptions}
              value={cashAccountId}
              onChange={setCashAccountId}
            />
          </DocField>
        )}
      </DocFields>

      <InvoiceLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={lookups.itemOptions}
        priceLabel={t('purchases.unitCost')}
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
  invoice?: PurchaseInvoice;
  loading: boolean;
  onBack: () => void;
  onEdit: () => void;
  onPost: (id: string) => void;
  onDelete: (id: string) => void;
  posting: boolean;
}) {
  const { t } = useTranslation();
  const [, contextHolder] = message.useMessage();
  const { modal } = App.useApp();
  const isDraft = invoice?.status === 'DRAFT';
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
              <Button onClick={onEdit}>{t('common.edit')}</Button>
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
      <DocFields>
        <DocField label={t('purchases.supplier')}>
          <DocValue>{displayName(invoice.supplier)}</DocValue>
        </DocField>
        <DocField label={t('purchases.supplierInvoiceNo')}>
          <DocValue>{invoice.supplierInvoiceNo ?? '—'}</DocValue>
        </DocField>
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
        {dec(invoice.costTotal).gt(0) && (
          <DocField label={t('purchases.costTotal')}>
            <DocValue>{amountCell(invoice.costTotal)}</DocValue>
          </DocField>
        )}
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
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  const returnsQuery = useQuery({
    queryKey: ['purchase-returns', statusFilter],
    queryFn: () =>
      purchasesControllerListReturns({ status: statusFilter ?? '' }).then(
        (r) => r.data as unknown as PurchaseReturn[],
      ),
  });
  const { data: returns, isLoading } = returnsQuery;
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
      className: 'nowrap',
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
      render: (_: unknown, r: PurchaseReturn) => displayName(r.supplier) ?? '—',
    },
    {
      title: t('purchases.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`purchases.${v}`)}</Tag>,
    },
    { title: t('purchases.grandTotal'), dataIndex: 'grandTotal', width: 120, align: 'right' as const, render: amountCell },
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
                  { title: '#', width: 50, render: (_: unknown, l: ReturnLine) => l.originalLine?.lineNo },
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

  const shown = (returns ?? []).filter((r) =>
    matchesSearch(search, r.returnNo, r.originalInvoice?.invoiceNo, displayName(r.supplier)),
  );

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
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
        count={shown.length}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            {t('purchases.newReturn')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(returnsQuery)}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
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

  const lookups = usePurchaseLookups();
  const { data: invoices } = useQuery({
    queryKey: ['purchase-invoices', 'POSTED'],
    queryFn: () =>
      purchasesControllerListInvoices({ status: 'POSTED', paymentType: '', supplierId: '' }).then(
        (r) => r.data as unknown as PurchaseInvoice[],
      ),
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
      await purchasesControllerPostReturn(id, { headers: idemHeaders() });
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
          <Select
            showSearch
            optionFilterProp="label"
            status={invoiceError ? 'error' : undefined}
            options={(invoices ?? []).map((i) => ({
              value: i.id,
              label: `${i.invoiceNo ?? `#${i.id}`} — ${displayName(i.supplier) ?? ''} — ${money(i.grandTotal)}`,
            }))}
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
