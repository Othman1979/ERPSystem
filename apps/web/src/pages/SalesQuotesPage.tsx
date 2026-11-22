import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { formatDate } from '../format/date';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import {
  catalogControllerListItems,
  partiesControllerList,
  salesCycleControllerAcceptQuote,
  salesCycleControllerCancelQuote,
  salesCycleControllerConvertQuote,
  salesCycleControllerCopyQuote,
  salesCycleControllerCreateQuote,
  salesCycleControllerDeleteQuote,
  salesCycleControllerGetQuote,
  salesCycleControllerListQuotes,
  salesCycleControllerRejectQuote,
  salesCycleControllerSendQuote,
  salesCycleControllerUpdateQuote,
  warehousesControllerList,
  type ItemListItemDto,
  type SalesCycleControllerListQuotesSort,
  type SalesCycleControllerListQuotesStatus,
  type SalesCycleQuoteDetailDto,
  type SalesCycleQuoteLineViewDto,
  type SalesCycleQuoteListItemDto,
  type SalesQuoteStatus,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { useCompany } from '../components/CompanyProfileForm';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { GridSelect, focusNamedField } from '../components/GridSelect';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { ResponsiveTable } from '../components/ResponsiveTable';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { ReasonModal } from '../components/ReasonModal';
import { PICKER_PAGE_SIZE, RemoteSelect } from '../components/RemoteSelect';
import { tableLocale } from '../components/QueryState';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { useCostCenters } from '../hooks/useCostCenters';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { useRemoteOptions } from '../hooks/useRemoteOptions';
import { useNewFromUrl } from '../useNewFromUrl';
import { idemHeaders } from '../idempotency';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { formatDate } from '../format/date';
import { invalidateSalesCycle, salesCycleKeys } from './sales/cycleQueryKeys';
import { apiErrorText as errorText } from '../components/ExportButtons';
import { CustomerFilter } from './sales/CustomerFilter';
import { SalesLinesGrid, type SalesLineDraft } from './sales/SalesLinesGrid';
import { convertQuoteBody, defaultValidUntil, isQuoteExpired, salesQuoteBody } from './sales/quotePayload';
import { missingSalesPriceLines } from './sales/salesLines';
import { EnterNav } from '../components/EnterNav';

// ------------------------------------------------------------------ types

/** What the page shows: the list, a new quote, or one saved quote. */
type Screen = { kind: 'list' } | { kind: 'new' } | { kind: 'quote'; id: string };

/** An item as the item picker holds it: a search result, or a line of a saved quote. */
type ItemRow = Pick<ItemListItemDto, 'id' | 'code' | 'nameAr' | 'nameEn' | 'itemKind' | 'salePrice'>;

const STATUSES: SalesQuoteStatus[] = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED'];

const STATUS_TONE: Record<SalesQuoteStatus, StatusTone> = {
  DRAFT: 'neutral',
  SENT: 'info',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'danger',
};

// ------------------------------------------------------------------ page

export function SalesQuotesPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // An order links here with ?quoteId=...: that quote opens. The address is cleaned up below.
  const linkedId = params.get('quoteId');
  const [screen, setScreen] = useState<Screen>(() => (linkedId ? { kind: 'quote', id: linkedId } : { kind: 'list' }));
  useEffect(() => {
    if (!linkedId) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('quoteId');
        return next;
      },
      { replace: true },
    );
  }, [linkedId, setParams]);
  useNewFromUrl(() => setScreen({ kind: 'new' }));

  return (
    <div>
      <PageHeader title={t('nav.salesQuotes')} />
      {screen.kind === 'list' ? (
        <QuotesList onOpen={(id) => setScreen({ kind: 'quote', id })} onNew={() => setScreen({ kind: 'new' })} />
      ) : (
        <QuoteScreen
          key={screen.kind === 'quote' ? `quote-${screen.id}` : 'new'}
          id={screen.kind === 'quote' ? screen.id : undefined}
          onBack={() => setScreen({ kind: 'list' })}
          onOpen={(id) => setScreen({ kind: 'quote', id })}
        />
      )}
    </div>
  );
}

function QuoteStatusTag({ status }: { status: SalesQuoteStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={STATUS_TONE[status]}>{t(`salesCycle.quoteStatuses.${status}`)}</StatusTag>;
}

// ------------------------------------------------------------------ list

function QuotesList({ onOpen, onNew }: { onOpen: (id: string) => void; onNew: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [statusFilter, setStatusFilter] = useState<SalesCycleControllerListQuotesStatus | undefined>(undefined);
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [from, setFrom] = useState<string | undefined>(undefined);
  const [to, setTo] = useState<string | undefined>(undefined);
  const today = dayjs().format('YYYY-MM-DD');

  // Server-paged (ADR-022): search, filters, sort and page go to the API.
  const list = usePagedQuery<
    SalesCycleQuoteListItemDto,
    { status?: SalesCycleControllerListQuotesStatus; customerId?: string; from?: string; to?: string },
    SalesCycleControllerListQuotesSort
  >({
    key: salesCycleKeys.quoteList(),
    filters: { status: statusFilter, customerId, from, to },
    defaultSort: '-quoteDate',
    fetch: (params, signal) => salesCycleControllerListQuotes(params, { signal }).then((r) => r.data),
  });

  const columns = [
    {
      title: t('salesCycle.quoteNo'),
      dataIndex: 'quoteNo',
      key: 'quoteNo',
      sorter: true,
      sortOrder: list.sortOrderOf('quoteNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('salesCycle.quoteDate'),
      dataIndex: 'quoteDate',
      key: 'quoteDate',
      sorter: true,
      sortOrder: list.sortOrderOf('quoteDate'),
      width: 110,
      render: (v: string) => formatDate(v),
    },
    {
      title: t('sales.customer'),
      dataIndex: 'customer',
      render: (_: unknown, r: SalesCycleQuoteListItemDto) => displayName(r.customer) ?? '—',
    },
    {
      title: t('salesCycle.validUntil'),
      dataIndex: 'validUntil',
      width: 170,
      render: (v: string | null, r: SalesCycleQuoteListItemDto) => (
        <Space size={6} wrap>
          {v ? formatDate(v) : '—'}
          {isQuoteExpired(r.status, v, today) && <StatusTag tone="warning">{t('salesCycle.expired')}</StatusTag>}
        </Space>
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 130,
      render: (v: SalesQuoteStatus) => <QuoteStatusTag status={v} />,
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
  ];

  return (
    <div>
      <ListToolbar
        search={list.search}
        onSearch={list.setSearch}
        searchPlaceholder={t('salesCycle.searchQuotes')}
        filters={
          <Space wrap>
            <Select
              allowClear
              style={{ minWidth: 150 }}
              placeholder={t('common.status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUSES.map((s) => ({ value: s, label: t(`salesCycle.quoteStatuses.${s}`) }))}
            />
            <CustomerFilter value={customerId} onChange={setCustomerId} />
            <DatePicker.RangePicker
              allowClear
              format="YYYY-MM-DD"
              value={from && to ? [dayjs(from), dayjs(to)] : null}
              onChange={(_, dateStrings) => {
                setFrom(dateStrings[0] || undefined);
                setTo(dateStrings[1] || undefined);
              }}
            />
          </Space>
        }
        count={list.total}
        actions={
          can(PERMISSIONS.SALES_MANAGE) && (
            <Button type="primary" icon={<PlusOutlined />} onClick={onNew}>
              {t('salesCycle.newQuote')}
            </Button>
          )
        }
      />
      <ResponsiveTable<SalesCycleQuoteListItemDto>
        rowKey="id"
        loading={list.query.isLoading}
        dataSource={list.rows}
        locale={tableLocale(list.query)}
        columns={columns}
        size="small"
        pagination={list.pagination}
        onChange={list.onTableChange}
        onRow={(r) => ({ onClick: () => onOpen(r.id), style: { cursor: 'pointer' } })}
        mobileCard={{
          title: (quote) => quote.quoteNo ?? t('procurement.draftNo'),
          subtitle: (quote) => `${formatDate(quote.quoteDate)} · ${displayName(quote.customer) ?? '—'}`,
          amount: (quote) => amountCell(quote.grandTotal),
          status: (quote) => <QuoteStatusTag status={quote.status} />,
          meta: (quote) => (quote.validUntil ? [<span>{t('salesCycle.validUntil')}: {formatDate(quote.validUntil)}</span>] : []),
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ screen

/** Loads a saved quote: a draft opens in the editor, anything else in the view. */
function QuoteScreen({ id, onBack, onOpen }: { id?: string; onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.SALES_MANAGE);
  const detail = useQuery({
    queryKey: salesCycleKeys.quote(id),
    queryFn: ({ signal }) => salesCycleControllerGetQuote(id!, { signal }).then((r) => r.data),
    enabled: !!id,
  });

  if (id && detail.isError) return <Alert type="error" showIcon message={t('common.loadFailed')} />;
  if (id && detail.isPending) return <Typography.Text>{t('common.loading')}</Typography.Text>;

  const quote = detail.data;
  if (quote && (quote.status !== 'DRAFT' || !canManage)) {
    return <QuoteView quote={quote} onBack={onBack} onOpen={onOpen} />;
  }
  return <QuoteEditor quote={quote} onBack={onBack} onSaved={onOpen} />;
}

// ------------------------------------------------------------------ editor

function QuoteEditor({
  quote,
  onBack,
  onSaved,
}: {
  /** The DRAFT being edited; undefined for a new quote. */
  quote?: SalesCycleQuoteDetailDto;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const company = useCompany();
  const costCenters = useCostCenters();
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const isNew = !quote;
  const [cancelOpen, setCancelOpen] = useState(false);

  // Keyboard entry starts at the first field the user must fill.
  useEffect(() => {
    const id = requestAnimationFrame(() => focusNamedField('customer'));
    return () => cancelAnimationFrame(id);
  }, []);

  const [quoteDate, setQuoteDate] = useState<Dayjs>(quote ? dayjs(quote.quoteDate) : dayjs());
  const [customerId, setCustomerId] = useState<string | undefined>(quote?.customerId);
  const [warehouseId, setWarehouseId] = useState<string | undefined>(quote?.warehouseId ?? undefined);
  const [costCenterId, setCostCenterId] = useState<string | undefined>(quote?.costCenterId ?? undefined);
  const [validUntil, setValidUntil] = useState<Dayjs | null>(quote?.validUntil ? dayjs(quote.validUntil) : null);
  const [description, setDescription] = useState(quote?.description ?? '');
  // A new quote starts with the company's validity; once the user sets a date, that stays.
  const validTouched = useRef(!!quote);
  useEffect(() => {
    if (validTouched.current || !company.data) return;
    const days = defaultValidUntil(quoteDate.format('YYYY-MM-DD'), company.data.quoteValidityDays);
    setValidUntil(days ? dayjs(days) : null);
  }, [company.data, quoteDate]);
  const changeValidUntil = (d: Dayjs | null) => {
    validTouched.current = true;
    setValidUntil(d);
  };

  const [lines, setLines] = useState<SalesLineDraft[]>(() =>
    quote?.lines.length
      ? quote.lines.map((l, i) => ({
          key: i + 1,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId ?? undefined,
          qty: l.qty,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
        }))
      : [{ key: 1 }, { key: 2 }],
  );
  const lineSeq = useRef(lines.length);

  // Items are searched on the server; the lines' own items stay labelled.
  const items = useRemoteOptions<ItemRow>({
    key: ['items', 'pick', { isActive: 'true' }],
    fetch: (q, signal) =>
      catalogControllerListItems({ pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}), isActive: 'true' }, { signal }).then(
        (r) => r.data.items,
      ),
  });
  const { remember: rememberItems } = items;
  useEffect(() => {
    rememberItems(
      (quote?.lines ?? []).map(
        (l: SalesCycleQuoteLineViewDto): ItemRow => ({
          id: l.itemId,
          code: l.item.code,
          nameAr: l.item.nameAr,
          nameEn: l.item.nameEn,
          itemKind: l.item.itemKind,
          salePrice: null,
        }),
      ),
    );
  }, [quote, rememberItems]);
  const itemOptions = items.withSelected(lines.map((l) => l.itemId)).map((row) => ({ value: row.id, label: codeAndName(row) }));

  const persist = async (): Promise<string> => {
    const body = salesQuoteBody({
      customerId: customerId!,
      warehouseId,
      costCenterId,
      quoteDate: quoteDate.format('YYYY-MM-DD'),
      validUntil: validUntil?.format('YYYY-MM-DD'),
      description,
      lines,
    });
    const res = quote ? await salesCycleControllerUpdateQuote(quote.id, body) : await salesCycleControllerCreateQuote(body);
    return res.data.id;
  };

  const onError = (err: unknown) => apiMessage.error(errorText(t, err));
  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      void invalidateSalesCycle(queryClient);
      onSaved(id);
    },
    onError,
  });
  // Send saves the draft first, so the sent quote is the one on screen (as the purchase order does).
  const send = useMutation({
    mutationFn: async () => {
      const id = await persist();
      await salesCycleControllerSendQuote(id, { headers: idemHeaders() });
      return id;
    },
    onSuccess: (id) => {
      apiMessage.success(t('salesCycle.sent'));
      void invalidateSalesCycle(queryClient);
      onSaved(id);
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => salesCycleControllerCancelQuote(quote!.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('salesCycle.cancelled'));
      void invalidateSalesCycle(queryClient);
      onBack();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => salesCycleControllerDeleteQuote(quote!.id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateSalesCycle(queryClient);
      onBack();
    },
    onError,
  });

  const busy = save.isPending || send.isPending || cancel.isPending || remove.isPending;

  // Save stays enabled: an attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const priceGaps = missingSalesPriceLines(lines);
  const missing = {
    customer: !customerId,
    lines: !lines.some((l) => l.itemId && l.qty),
    prices: priceGaps.length > 0,
  };
  /** True when the form may be saved; otherwise marks what is missing. */
  const checkForm = (): boolean => {
    if (busy) return false;
    if (missing.customer) {
      setTried(true);
      focusNamedField('customer');
      return false;
    }
    if (missing.lines) {
      setTried(true);
      apiMessage.warning(t('stock.minLines'));
      return false;
    }
    if (missing.prices) {
      setTried(true);
      apiMessage.warning(t('salesCycle.priceRequired'));
      return false;
    }
    return true;
  };
  const saveDraft = () => {
    if (checkForm()) save.mutate();
  };
  const sendQuote = () => {
    if (checkForm()) send.mutate();
  };
  useDocShortcuts({ onSave: saveDraft });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);

  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }));

  return (
    <DocLayout
      title={isNew ? t('salesCycle.newQuote') : t('salesCycle.quoteTitle')}
      docNo={quote ? (quote.quoteNo ?? t('procurement.draftNo')) : undefined}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={saveDraft}>
            {isNew ? t('common.saveDraft') : t('common.save')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          {quote && (
            <>
              <Popconfirm title={t('salesCycle.confirmSend')} onConfirm={sendQuote}>
                <Button disabled={busy} loading={send.isPending}>
                  {t('procurement.send')}
                </Button>
              </Popconfirm>
              <Button danger disabled={busy} onClick={() => setCancelOpen(true)}>
                {t('procurement.cancel')}
              </Button>
              <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate()}>
                <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} disabled={busy} loading={remove.isPending} />
              </Popconfirm>
            </>
          )}
        </>
      }
    >
      <EnterNav>
        <DocFields>
          <DocField field="customer" label={t('sales.customer')} required error={requiredError(missing.customer)}>
            <RemoteSelect
              queryKey={['parties', 'pick', 'CUSTOMER']}
              fetchOptions={(q, signal) =>
                partiesControllerList({ partyType: 'CUSTOMER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) }, { signal }).then(
                  (r) => r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) })),
                )
              }
              selected={quote?.customer ? { value: quote.customer.id, label: codeAndName(quote.customer) } : undefined}
              status={requiredError(missing.customer) ? 'error' : undefined}
              value={customerId}
              onChange={setCustomerId}
            />
          </DocField>
          <DocField field="warehouse" label={t('sales.warehouse')}>
            <GridSelect
              allowClear
              placeholder={t('salesCycle.warehouseOptional')}
              options={warehouseOptions}
              value={warehouseId}
              onChange={(v: string | undefined) => setWarehouseId(v)}
            />
          </DocField>
          <DocField label={t('salesCycle.quoteDate')} required>
            <DatePicker value={quoteDate} onChange={(d) => d && setQuoteDate(d)} />
          </DocField>
          <DocField label={t('salesCycle.validUntil')}>
            <DatePicker value={validUntil} onChange={changeValidUntil} allowClear />
          </DocField>
          {costCenters.enabled && (
            <DocField field="costCenter" label={<CostCenterLabel />}>
              <CostCenterSelect rows={costCenters.rows} value={costCenterId} onChange={setCostCenterId} />
            </DocField>
          )}
          <DocField label={t('salesCycle.description')} wide>
            <Input value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
          </DocField>
        </DocFields>

        <SalesLinesGrid
          lines={lines}
          onChange={setLines}
          itemOptions={itemOptions}
          onItemSearch={items.onSearch}
          priceOf={(itemId) => items.byId(itemId)?.salePrice ?? undefined}
          nextKey={() => {
            lineSeq.current += 1;
            return lineSeq.current;
          }}
          lineError={tried && missing.lines ? t('common.requiredField') : undefined}
          priceGaps={new Set(tried ? priceGaps : [])}
        />

        {cancelOpen && (
          <ReasonModal
            title={t('salesCycle.cancelTitle')}
            okText={t('procurement.cancel')}
            busy={cancel.isPending}
            onClose={() => setCancelOpen(false)}
            onConfirm={(reason) => cancel.mutate(reason)}
          />
        )}
      </EnterNav>
    </DocLayout>
  );
}

// ------------------------------------------------------------------ view

/** Read-only quote with the actions of its status (ADR-027 §2). Drafts open in the editor. */
function QuoteView({ quote, onBack, onOpen }: { quote: SalesCycleQuoteDetailDto; onBack: () => void; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [reasonAction, setReasonAction] = useState<'reject' | 'cancel' | null>(null);
  const [convertOpen, setConvertOpen] = useState(false);
  const [convertWarehouse, setConvertWarehouse] = useState<string | undefined>(undefined);
  const [createdOrder, setCreatedOrder] = useState<{ id: string; orderNo: string | null } | null>(null);
  // The order this quote was converted to: just now, or saved on the quote (review #56).
  const linkedOrder = createdOrder ?? quote.orders[0] ?? null;
  const canManage = can(PERMISSIONS.SALES_MANAGE);
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
    enabled: convertOpen,
  });

  const onError = (err: unknown) => apiMessage.error(errorText(t, err));
  const refresh = () => void invalidateSalesCycle(queryClient);

  const accept = useMutation({
    mutationFn: () => salesCycleControllerAcceptQuote(quote.id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('salesCycle.accepted'));
      refresh();
    },
    onError,
  });
  const reject = useMutation({
    mutationFn: (reason: string) => salesCycleControllerRejectQuote(quote.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('salesCycle.rejected'));
      refresh();
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => salesCycleControllerCancelQuote(quote.id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      setReasonAction(null);
      apiMessage.success(t('salesCycle.cancelled'));
      refresh();
    },
    onError,
  });
  const copy = useMutation({
    mutationFn: () => salesCycleControllerCopyQuote(quote.id, { headers: idemHeaders() }),
    onSuccess: (res) => {
      apiMessage.success(t('salesCycle.copied'));
      refresh();
      onOpen(res.data.id);
    },
    onError,
  });
  const convert = useMutation({
    mutationFn: (warehouseId: string | undefined) =>
      salesCycleControllerConvertQuote(quote.id, convertQuoteBody(warehouseId), { headers: idemHeaders() }),
    onSuccess: (res) => {
      setConvertOpen(false);
      apiMessage.success(t('salesCycle.converted'));
      setCreatedOrder({ id: res.data.id, orderNo: res.data.orderNo });
      refresh();
    },
    onError,
  });
  const busy = accept.isPending || reject.isPending || cancel.isPending || copy.isPending || convert.isPending;

  const askConvert = () => {
    if (quote.warehouse) convert.mutate(undefined);
    else setConvertOpen(true);
  };

  return (
    <DocLayout
      title={t('salesCycle.quoteTitle')}
      docNo={quote.quoteNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <QuoteStatusTag status={quote.status} />
          {canManage && quote.status === 'SENT' && (
            <>
              {/* A disabled button takes no hover, so the tooltip sits on a wrapper that does. */}
              <Tooltip title={quote.expired ? t('salesCycle.acceptExpiredHint') : undefined}>
                <span>
                  <Button
                    type="primary"
                    disabled={busy || quote.expired}
                    loading={accept.isPending}
                    onClick={() => accept.mutate()}
                  >
                    {t('salesCycle.accept')}
                  </Button>
                </span>
              </Tooltip>
              <Button danger disabled={busy} onClick={() => setReasonAction('reject')}>
                {t('salesCycle.reject')}
              </Button>
              <Button danger disabled={busy} onClick={() => setReasonAction('cancel')}>
                {t('procurement.cancel')}
              </Button>
            </>
          )}
          {canManage && quote.status === 'ACCEPTED' && (
            <Button type="primary" disabled={busy} loading={convert.isPending} onClick={askConvert}>
              {t('salesCycle.convertToOrder')}
            </Button>
          )}
          {canManage && (
            <Popconfirm title={t('salesCycle.confirmCopy')} onConfirm={() => copy.mutate()}>
              <Button disabled={busy} loading={copy.isPending}>
                {t('salesCycle.copy')}
              </Button>
            </Popconfirm>
          )}
          <PrintPdfButton path={`/sales-quotes/${quote.id}/pdf`} />
        </>
      }
    >
      <EnterNav>
        {quote.expired && (
          <Alert
            type="warning"
            showIcon
            message={t('salesCycle.expiredNotice', { date: formatDate(quote.validUntil ?? '') })}
          />
        )}
        {linkedOrder && (
          <Alert
            type={createdOrder ? 'success' : 'info'}
            showIcon
            message={
              <Space wrap>
                {createdOrder ? t('salesCycle.orderCreated') : t('salesCycle.convertedTo')}
                <Link to={`/sales-orders?orderId=${linkedOrder.id}`}>{linkedOrder.orderNo ?? `#${linkedOrder.id}`}</Link>
              </Space>
            }
          />
        )}
        {quote.status === 'CANCELLED' && quote.cancelReason && (
          <Alert type="warning" showIcon message={t('procurement.cancelledReason', { reason: quote.cancelReason })} />
        )}
        {quote.status === 'REJECTED' && quote.rejectReason && (
          <Alert type="warning" showIcon message={t('salesCycle.rejectedReason', { reason: quote.rejectReason })} />
        )}
        <DocFields>
          <DocField label={t('common.status')}>
            <DocValue>
              <QuoteStatusTag status={quote.status} />
            </DocValue>
          </DocField>
          <DocField label={t('sales.customer')}>
            <DocValue>{displayName(quote.customer) ?? '—'}</DocValue>
          </DocField>
          <DocField label={t('sales.warehouse')}>
            <DocValue>{quote.warehouse ? codeAndName(quote.warehouse) : '—'}</DocValue>
          </DocField>
          <DocField label={t('salesCycle.quoteDate')}>
            <DocValue>{formatDate(quote.quoteDate)}</DocValue>
          </DocField>
          <DocField label={t('salesCycle.validUntil')}>
            <DocValue>{quote.validUntil ? formatDate(quote.validUntil) : '—'}</DocValue>
          </DocField>
          {quote.costCenter && (
            <DocField label={t('costCenters.documentField')}>
              <DocValue>{codeAndName(quote.costCenter)}</DocValue>
            </DocField>
          )}
          <DocField label={t('sales.net')}>
            <DocValue>{amountCell(quote.netTotal)}</DocValue>
          </DocField>
          <DocField label={t('sales.tax')}>
            <DocValue>{amountCell(quote.taxTotal)}</DocValue>
          </DocField>
          <DocField label={t('sales.grandTotal')}>
            <DocValue>{amountCell(quote.grandTotal)}</DocValue>
          </DocField>
          {quote.description && (
            <DocField label={t('salesCycle.description')} wide>
              <DocValue>{quote.description}</DocValue>
            </DocField>
          )}
        </DocFields>
        <Typography.Text type="secondary">
          {quote.pricesIncludeTax ? t('procurement.pricesIncludeTax') : t('procurement.pricesExcludeTax')}
        </Typography.Text>

        <Table<SalesCycleQuoteLineViewDto>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={quote.lines}
          columns={[
            { title: '#', dataIndex: 'lineNo', width: 50 },
            { title: t('procurement.item'), render: (_: unknown, l: SalesCycleQuoteLineViewDto) => codeAndName(l.item) },
            { title: t('procurement.qty'), dataIndex: 'qty', width: 100, align: 'right' as const, render: qtyCell },
            { title: t('procurement.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
            { title: t('procurement.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
            { title: t('procurement.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
            { title: t('procurement.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
            { title: t('procurement.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
          ]}
         scroll={{ x: 'max-content' }}/>

        {reasonAction && (
          <ReasonModal
            title={t(reasonAction === 'reject' ? 'salesCycle.rejectTitle' : 'salesCycle.cancelTitle')}
            okText={t(reasonAction === 'reject' ? 'salesCycle.reject' : 'procurement.cancel')}
            busy={reasonAction === 'reject' ? reject.isPending : cancel.isPending}
            onClose={() => setReasonAction(null)}
            onConfirm={(reason) => (reasonAction === 'reject' ? reject.mutate(reason) : cancel.mutate(reason))}
          />
        )}

        <Modal
          open={convertOpen}
          title={t('salesCycle.convertTitle')}
          okText={t('salesCycle.convertToOrder')}
          cancelText={t('common.cancel')}
          okButtonProps={{ disabled: !convertWarehouse }}
          confirmLoading={convert.isPending}
          onCancel={() => setConvertOpen(false)}
          onOk={() => convert.mutate(convertWarehouse)}
        >
          <Typography.Paragraph type="secondary">{t('salesCycle.convertWarehouseHint')}</Typography.Paragraph>
          <Form layout="vertical">
            <Form.Item label={t('sales.warehouse')} required>
              <Select
                value={convertWarehouse}
                onChange={setConvertWarehouse}
                loading={warehouses.isLoading}
                options={(warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }))}
              />
            </Form.Item>
          </Form>
        </Modal>
      </EnterNav>
    </DocLayout>
  );
}
