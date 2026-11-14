import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
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
import { selectCashBank, useAccounts } from '../hooks/useAccounts';
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
import { ListToolbar } from '../components/ListToolbar';
import { RemoteSelect, PICKER_PAGE_SIZE } from '../components/RemoteSelect';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { useNewFromUrl } from '../useNewFromUrl';
import { salesInvoiceBody, salesInvoiceFormDefaults } from './sales/invoicePayload';
import {
  ApiError,
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
  type ItemListItemDto,
  type SalesControllerListInvoicesPaymentType,
  type SalesControllerListInvoicesSort,
  type SalesControllerListInvoicesStatus,
  type SalesControllerListReturnsSort,
  type SalesControllerListReturnsStatus,
  type SalesInvoiceLineViewDto,
  type SalesInvoiceDetailDto,
  type SalesInvoiceListItemDto,
  type SalesReturnLineViewDto,
  type SalesReturnListItemDto,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import {
  EInvoiceNotice,
  EInvoiceQrPanel,
  EInvoiceStatusTag,
  isInFlight,
} from './einvoice/EInvoiceStatus';

// ------------------------------------------------------------------ types

/** Lines as the detail endpoints return them. */
type InvoiceLine = SalesInvoiceLineViewDto;
type ReturnLine = SalesReturnLineViewDto;

/**
 * An item as the item picker holds it: a search result, or a line taken from a saved
 * invoice (which carries its own tax rate; the search response does not).
 */
type ItemRow = Pick<
  ItemListItemDto,
  'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'salePrice' | 'taxCategoryId'
> & { taxRate?: string };

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

/** Picker option for an item row; without its own rate, the item's tax category's, then the default's. */
function itemOption(
  row: ItemRow,
  taxRateById: ReadonlyMap<string, string>,
  defaultTaxId?: string,
): InvoiceItemOption {
  return {
    id: row.id,
    label: codeAndName(row),
    price: row.salePrice ?? null,
    taxRate:
      row.taxRate ??
      taxRateById.get(row.taxCategoryId ?? '') ??
      taxRateById.get(defaultTaxId ?? '') ??
      '0',
    itemKind: row.itemKind,
  };
}

/** Small reference lists only; customers and items are searched on the server (ADR-022 §8). */
function useSalesLookups() {
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) =>
      warehousesControllerList({ signal }).then((r) => r.data),
  });
  const taxes = useQuery({
    queryKey: ['tax-categories'],
    queryFn: ({ signal }) =>
      settingsControllerListTaxCategories({ signal }).then((r) => r.data),
  });
  const accounts = useAccounts(selectCashBank);

  const taxRateById = useMemo(() => {
    const m = new Map<string, string>();
    for (const tc of taxes.data ?? []) m.set(tc.id, tc.rate);
    return m;
  }, [taxes.data]);
  const defaultTaxId = useMemo(
    () => (taxes.data ?? []).find((x) => x.isDefault)?.id,
    [taxes.data],
  );

  const cashAccountOptions = useMemo(
    () => (accounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) })),
    [accounts.data],
  );

  return {
    warehouses: warehouses.data ?? [],
    taxRateById,
    defaultTaxId,
    cashAccountOptions,
  };
}

// ------------------------------------------------------------- invoices tab

function InvoicesTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<SalesControllerListInvoicesStatus | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'form' | 'view'>('list');
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const lookups = useSalesLookups();
  useNewFromUrl(() => {
    setInvoiceId(null);
    setScreen('form');
  });

  const [paymentFilter, setPaymentFilter] = useState<SalesControllerListInvoicesPaymentType | undefined>(undefined);
  // Server-paged (ADR-022): search, filters, sort and page go to the API.
  const list = usePagedQuery<
    SalesInvoiceListItemDto,
    { status?: SalesControllerListInvoicesStatus; paymentType?: SalesControllerListInvoicesPaymentType },
    SalesControllerListInvoicesSort
  >({
    key: ['sales-invoices', 'list'],
    filters: { status: statusFilter, paymentType: paymentFilter },
    defaultSort: '-invoiceDate',
    fetch: (params, signal) => salesControllerListInvoices(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });
  const invoicesQuery = list.query;
  const { isLoading } = invoicesQuery;

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: ({ signal }) =>
      salesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
    enabled: (screen === 'view' || screen === 'form') && !!invoiceId,
    // Just posted: follow the e-invoice until JoFotara answers, so the QR shows up.
    refetchInterval: (query) => (screen === 'view' && isInFlight(query.state.data?.einvoice?.status) ? 4000 : false),
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
      key: 'invoiceNo',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesInvoiceListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'invoiceDate',
      key: 'invoiceDate',
      sorter: true,
      sortOrder: list.sortOrderOf('invoiceDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesInvoiceListItemDto) => displayName(r.customer) ?? '—',
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
      key: 'grandTotal',
      sorter: true,
      sortOrder: list.sortOrderOf('grandTotal'),
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
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('sales.searchPlaceholder')}
        filters={
          <>
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
            <Select
              allowClear
              placeholder={t('sales.paymentType')}
              value={paymentFilter}
              onChange={setPaymentFilter}
              options={[
                { value: 'CREDIT', label: t('sales.CREDIT') },
                { value: 'CASH', label: t('sales.CASH') },
              ]}
            />
          </>
        }
        count={list.total}
        actions={
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
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={list.rows}
        locale={tableLocale(invoicesQuery)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
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
  invoice?: SalesInvoiceDetailDto;
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
  const formDefaults = salesInvoiceFormDefaults(invoice);
  const [paymentType, setPaymentType] = useState<'CASH' | 'CREDIT'>(formDefaults.paymentType);
  const [cashAccountId, setCashAccountId] = useState<string | undefined>(formDefaults.cashAccountId);
  const [lines, setLines] = useState<InvoiceLineDraft[]>(() => {
    if (invoice?.lines.length) {
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

  const warehouseOptions = lookups.warehouses.map((w) => ({
    value: w.id,
    label: codeAndName(w),
  }));

  // Items are searched on the server; the lines' own items stay labelled and priced.
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
    if (!invoice) return;
    rememberItems(
      invoice.lines.flatMap((l): ItemRow[] =>
        l.item
          ? [
              {
                id: l.itemId,
                code: l.item.code,
                nameAr: l.item.nameAr,
                nameEn: null,
                itemKind: l.item.itemKind,
                salePrice: l.unitPrice,
                taxCategoryId: null,
                taxRate: l.taxRate,
              },
            ]
          : [],
      ),
    );
  }, [invoice, rememberItems]);
  const itemOptions = items
    .withSelected(lines.map((l) => l.itemId))
    .map((row) => itemOption(row, lookups.taxRateById, lookups.defaultTaxId));

  const save = useMutation({
    mutationFn: async () => {
      // trySave checks these before it saves; this narrows them for the request type.
      if (!customerId || !warehouseId) throw new Error('customer and warehouse are required');
      const payload = salesInvoiceBody(
        {
          invoiceDate: invoiceDate.format('YYYY-MM-DD'),
          dueDate: dueDate?.format('YYYY-MM-DD'),
          customerId,
          warehouseId,
          paymentType,
          cashAccountId,
          lines,
        },
        invoice,
      );
      const res = isNew
        ? await salesControllerCreateInvoice(payload)
        : await salesControllerUpdateInvoice(invoice!.id, payload);
      return res;
    },
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      onSaved(res.data.id);
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
    customer: !customerId,
    warehouse: !warehouseId,
    cashAccount: paymentType === 'CASH' && !cashAccountId,
    lines: !lines.some((l) => l.itemId && l.qty),
  };
  const trySave = () => {
    if (save.isPending) return;
    const firstMissing = (['customer', 'warehouse', 'cashAccount'] as const).find((k) => missing[k]);
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
      title={isNew ? t('sales.newInvoice') : t('sales.invoiceTitle')}
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
          field="customer"
          label={t('sales.customer')}
          required
          error={requiredError(missing.customer)}
          onKeyDown={enterTo(() => focusNamedField('warehouse'))}
        >
          {/* Searches customers on the server by code or name (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['parties', 'pick', 'CUSTOMER']}
            fetchOptions={(q, signal) =>
              partiesControllerList(
                { partyType: 'CUSTOMER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
                { signal },
              ).then((r) =>
                r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
              )
            }
            selected={
              invoice?.customer
                ? { value: invoice.customer.id, label: codeAndName(invoice.customer) }
                : undefined
            }
            status={requiredError(missing.customer) ? 'error' : undefined}
            value={customerId}
            onChange={setCustomerId}
          />
        </DocField>
        <DocField
          field="warehouse"
          label={t('sales.warehouse')}
          required
          error={requiredError(missing.warehouse)}
          onKeyDown={enterTo(() => focusNamedField('invoiceDate'))}
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
          field="invoiceDate"
          label={t('sales.invoiceDate')}
          onKeyDown={enterTo(() => focusNamedField('dueDate'))}
        >
          <DatePicker value={invoiceDate} onChange={(d) => d && setInvoiceDate(d)} />
        </DocField>
        <DocField
          field="dueDate"
          label={t('sales.dueDate')}
          onKeyDown={enterTo(() => focusNamedField('paymentType'))}
        >
          <DatePicker value={dueDate} onChange={setDueDate} allowClear />
        </DocField>
        <DocField
          field="paymentType"
          label={t('sales.paymentType')}
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
              { value: 'CREDIT', label: t('sales.CREDIT') },
              { value: 'CASH', label: t('sales.CASH') },
            ]}
          />
        </DocField>
        {paymentType === 'CASH' && (
          <DocField
            field="cashAccount"
            label={t('sales.cashAccount')}
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
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
      />
    </DocLayout>
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
  invoice?: SalesInvoiceDetailDto;
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
    modal.confirm({ title: t('sales.postConfirm'), onOk: () => onPost(invoice.id) });
  };
  useDocShortcuts({ onPost: confirmPost });
  if (loading || !invoice) {
    return <Typography.Text>{t('common.loading')}</Typography.Text>;
  }
  const remaining = dec(invoice.grandTotal).minus(dec(invoice.paidAmount));
  return (
    <DocLayout
      title={t('sales.invoiceTitle')}
      docNo={invoice.invoiceNo ?? `#${invoice.id}`}
      status={invoice.status}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          {isDraft && (
            <>
              <Button onClick={onEdit}>{t('common.edit')}</Button>
              <Popconfirm title={t('sales.postConfirm')} onConfirm={() => onPost(invoice.id)}>
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
          <PrintPdfButton path={`/sales-invoices/${invoice.id}/pdf`} />
        </>
      }
    >
      <EInvoiceNotice einvoice={invoice.einvoice} />
      <DocFields>
        <DocField label={t('sales.customer')}>
          <DocValue>{displayName(invoice.customer)}</DocValue>
        </DocField>
        <DocField label={t('sales.paymentType')}>
          <DocValue>
            <Tag color={invoice.paymentType === 'CASH' ? 'green' : 'blue'}>
              {t(`sales.${invoice.paymentType}`)}
            </Tag>
          </DocValue>
        </DocField>
        <DocField label={t('sales.invoiceDate')}>
          <DocValue>{dayjs(invoice.invoiceDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('sales.dueDate')}>
          <DocValue>{invoice.dueDate ? dayjs(invoice.dueDate).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        <DocField label={t('sales.net')}>
          <DocValue>{amountCell(invoice.netTotal)}</DocValue>
        </DocField>
        <DocField label={t('sales.tax')}>
          <DocValue>{amountCell(invoice.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('sales.grandTotal')}>
          <DocValue>{amountCell(invoice.grandTotal)}</DocValue>
        </DocField>
        <DocField label={`${t('sales.paid')} / ${t('sales.remaining')}`}>
          <DocValue>
            {amountCell(invoice.paidAmount)}
            <span style={{ margin: '0 6px' }}>/</span>
            <Typography.Text type={remaining.gt(0) && !isDraft ? 'danger' : undefined}>
              {amountCell(remaining)}
            </Typography.Text>
          </DocValue>
        </DocField>
        {dec(invoice.costTotal).gt(0) && (
          <DocField label={t('sales.costTotal')}>
            <DocValue>{amountCell(invoice.costTotal)}</DocValue>
          </DocField>
        )}
        {invoice.einvoice && (
          <DocField label={t('einvoice.field')}>
            <DocValue>
              <EInvoiceStatusTag status={invoice.einvoice.status} />
            </DocValue>
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
          { title: t('sales.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('sales.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('sales.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('sales.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('sales.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
      />
      <EInvoiceQrPanel einvoice={invoice.einvoice} />
    </DocLayout>
  );
}

// ------------------------------------------------------------- returns tab

function ReturnsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<SalesControllerListReturnsStatus | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    SalesReturnListItemDto,
    { status?: SalesControllerListReturnsStatus },
    SalesControllerListReturnsSort
  >({
    key: ['sales-returns', 'list'],
    filters: { status: statusFilter },
    defaultSort: '-returnDate',
    fetch: (params, signal) => salesControllerListReturns(params, { signal }).then((r) => r.data),
    enabled: !modalOpen && !viewId,
  });

  const { data: view } = useQuery({
    queryKey: ['sales-return', viewId],
    queryFn: ({ signal }) =>
      salesControllerGetReturn(viewId!, { signal }).then((r) => r.data),
    enabled: !!viewId,
    refetchInterval: (query) => (isInFlight(query.state.data?.einvoice?.status) ? 4000 : false),
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
      key: 'returnNo',
      sorter: true,
      sortOrder: list.sortOrderOf('returnNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null, r: SalesReturnListItemDto) => v ?? `#${r.id}`,
    },
    {
      title: t('sales.date'),
      dataIndex: 'returnDate',
      key: 'returnDate',
      sorter: true,
      sortOrder: list.sortOrderOf('returnDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('sales.invoice'),
      dataIndex: 'originalInvoice',
      render: (_: unknown, r: SalesReturnListItemDto) => r.originalInvoice?.invoiceNo ?? `#${r.originalInvoiceId}`,
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesReturnListItemDto) => displayName(r.customer) ?? '—',
    },
    {
      title: t('sales.refundType'),
      dataIndex: 'refundType',
      width: 110,
      render: (v: string) => <Tag color={v === 'CASH' ? 'green' : 'blue'}>{t(`sales.${v}`)}</Tag>,
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
      render: (_: unknown, r: SalesReturnListItemDto) => (
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
      <ReturnForm
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
          title={t('sales.returnDetail')}
          docNo={view?.returnNo}
          status={view?.status}
          onBack={() => setViewId(null)}
          actions={<PrintPdfButton path={`/sales-returns/${viewId}/pdf`} />}
        >
          {view ? (
            <>
              <EInvoiceNotice einvoice={view.einvoice} />
              <DocFields>
                <DocField label={t('sales.invoice')}>
                  <DocValue>
                    <span className="doc-no">{view.originalInvoice?.invoiceNo ?? '—'}</span>
                  </DocValue>
                </DocField>
                <DocField label={t('sales.customer')}>
                  <DocValue>{displayName(view.customer)}</DocValue>
                </DocField>
                <DocField label={t('sales.date')}>
                  <DocValue>{dayjs(view.returnDate).format('YYYY-MM-DD')}</DocValue>
                </DocField>
                <DocField label={t('sales.refundType')}>
                  <DocValue>{t(`sales.${view.refundType}`)}</DocValue>
                </DocField>
                <DocField label={t('sales.grandTotal')}>
                  <DocValue>{amountCell(view.grandTotal)}</DocValue>
                </DocField>
                {view.reason && (
                  <DocField label={t('common.reason')}>
                    <DocValue>{view.reason}</DocValue>
                  </DocField>
                )}
                {view.einvoice && (
                  <DocField label={t('einvoice.field')}>
                    <DocValue>
                      <EInvoiceStatusTag status={view.einvoice.status} />
                    </DocValue>
                  </DocField>
                )}
              </DocFields>
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={view.lines ?? []}
                columns={[
                  { title: '#', width: 50, render: (_: unknown, l: ReturnLine) => l.originalLine.lineNo },
                  {
                    title: t('items.title'),
                    render: (_: unknown, l: ReturnLine) =>
                      l.item ? codeAndName(l.item) : l.itemId,
                  },
                  { title: t('stock.qty'), dataIndex: 'qtyBase', width: 100, align: 'right' as const, render: qtyCell },
                  { title: t('sales.total'), dataIndex: 'lineTotal', width: 120, align: 'right' as const, render: amountCell },
                ]}
              />
              <EInvoiceQrPanel einvoice={view.einvoice} />
            </>
          ) : (
            <div className="doc-section">{t('common.loading')}</div>
          )}
        </DocLayout>
      </>
    );
  }

  return (
    <div>
      {contextHolder}
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('sales.searchPlaceholder')}
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
        count={list.total}
        actions={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            {t('sales.newReturn')}
          </Button>
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
      />
    </div>
  );
}

function ReturnForm({
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

  const lookups = useSalesLookups();
  const { data: invoice } = useQuery({
    queryKey: ['sales-invoice', invoiceId],
    queryFn: ({ signal }) =>
      salesControllerGetInvoice(invoiceId!, { signal }).then((r) => r.data),
    enabled: !!invoiceId,
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!invoiceId) throw new Error('return needs an invoice');
      return salesControllerCreateReturn({
        returnDate: returnDate.format('YYYY-MM-DD'),
        originalInvoiceId: invoiceId,
        refundType,
        cashAccountId: refundType === 'CASH' ? cashAccountId : undefined,
        reason: reason || undefined,
        lines: (invoice?.lines ?? [])
          .filter((l) => dec(qtyByLine[l.id]).gt(0))
          .map((l) => ({ originalLineId: l.id, qty: qtyByLine[l.id] })),
      });
    },
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
      await salesControllerPostReturn(created.data.id, { headers: idemHeaders() });
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
      title={t('sales.newReturn')}
      status="DRAFT"
      onBack={onClose}
      actions={
        <>
          <Button loading={create.isPending} onClick={() => trySave(false)}>
            {t('common.saveDraft')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          <Button type="primary" loading={postCreated.isPending} onClick={() => trySave(true)}>
            {t('sales.createAndPost')}
          </Button>
        </>
      }
    >
      {contextHolder}
      <DocFields>
        <DocField label={t('sales.invoice')} required error={invoiceError}>
          {/* Searches posted invoices on the server by number or customer (ADR-022 §8). */}
          <RemoteSelect
            queryKey={['sales-invoices', 'pick-posted']}
            placeholder={t('sales.searchPlaceholder')}
            fetchOptions={(q, signal) =>
              salesControllerListInvoices({ status: 'POSTED', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
                (r) =>
                  r.data.items.map((i) => ({
                    value: i.id,
                    label: `${i.invoiceNo ?? `#${i.id}`} — ${displayName(i.customer) ?? ''} — ${money(i.grandTotal)}`,
                  })),
              )
            }
            status={invoiceError ? 'error' : undefined}
            value={invoiceId}
            onChange={(v) => {
              setInvoiceId(v);
              setQtyByLine({});
            }}
          />
        </DocField>
        <DocField label={t('sales.date')}>
          <DatePicker value={returnDate} onChange={(d) => d && setReturnDate(d)} />
        </DocField>
        <DocField label={t('sales.refundType')}>
          <Radio.Group
            name="refundType"
            optionType="button"
            buttonStyle="solid"
            value={refundType}
            onChange={(e) => setRefundType(e.target.value)}
            options={[
              { value: 'CREDIT', label: t('sales.CREDIT') },
              { value: 'CASH', label: t('sales.CASH') },
            ]}
          />
        </DocField>
        {refundType === 'CASH' && (
          <DocField label={t('sales.cashAccount')}>
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
    </DocLayout>
  );
}
