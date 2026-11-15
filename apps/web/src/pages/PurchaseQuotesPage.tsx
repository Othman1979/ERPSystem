import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import {
  ApiError,
  partiesControllerList,
  procurementControllerCancelQuote,
  procurementControllerCloseQuote,
  procurementControllerComparison,
  procurementControllerConvertRequest,
  procurementControllerCreateQuote,
  procurementControllerDeleteQuote,
  procurementControllerGetQuote,
  procurementControllerGetRequest,
  procurementControllerListQuotes,
  procurementControllerListRequests,
  procurementControllerReceiveQuote,
  procurementControllerSendQuote,
  procurementControllerUpdateQuote,
  warehousesControllerList,
  type ComparisonOfferDto,
  type ProcurementControllerListQuotesSort,
  type ProcurementControllerListQuotesStatus,
  type PurchaseQuoteDetailDto,
  type PurchaseQuoteLineViewDto,
  type PurchaseQuoteListItemDto,
  type PurchaseRequestDetailDto,
  type ReceivePurchaseQuoteDto,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { GridSelect } from '../components/GridSelect';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { PrintPdfButton } from '../components/PrintPdfButton';
import { PICKER_PAGE_SIZE, RemoteSelect } from '../components/RemoteSelect';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { tableLocale } from '../components/QueryState';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { useCostCenters } from '../hooks/useCostCenters';
import { idemHeaders } from '../idempotency';
import { useNewFromUrl } from '../useNewFromUrl';
import { codeAndName, displayName } from '../i18n/displayName';
import { amountCell, qtyCell, unitCostCell } from '../format/cells';
import { dec } from '../format/number';
import {
  convertBody,
  defaultPicks,
  missingReceivePrices,
  quoteBody,
  receiveBody,
  withPick,
  type QuotePicks,
} from './procurement/quotePayload';
import { invalidateProcurement, procurementKeys } from './procurement/queryKeys';

// ------------------------------------------------------------------ shared

/** The toast API of antd's message.useMessage(), passed down so every screen shares one holder. */
type MessageApi = ReturnType<typeof message.useMessage>[0];

/** The request picker's label: its number and its date. */
function requestLabel(r: { id: string; requestNo: string | null; requestDate: string }): string {
  return `${r.requestNo ?? `#${r.id}`} — ${dayjs(r.requestDate).format('YYYY-MM-DD')}`;
}

/** The request picker's option for a loaded request, if there is one. */
function requestOption(r: { id: string; requestNo: string | null; requestDate: string } | undefined) {
  return r ? { value: r.id, label: requestLabel(r) } : undefined;
}

/** The request the quote or comparison is for; loaded for its open lines and remaining quantities. */
function useRequestDetail(requestId?: string) {
  return useQuery({
    queryKey: procurementKeys.request(requestId),
    queryFn: ({ signal }) =>
      procurementControllerGetRequest(requestId!, { signal }).then((r) => r.data),
    enabled: !!requestId,
  });
}

/** Approved requests only: quotes and comparisons are made for them (ADR-025 §1). */
function ApprovedRequestPicker({
  value,
  selected,
  status,
  disabled,
  onChange,
}: {
  value?: string;
  selected?: { value: string; label: string };
  status?: 'error';
  disabled?: boolean;
  onChange: (value: string | undefined) => void;
}) {
  const { t } = useTranslation();
  return (
    <RemoteSelect
      queryKey={procurementKeys.requestPick('APPROVED')}
      fetchOptions={(q, signal) =>
        procurementControllerListRequests(
          { status: 'APPROVED', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
          { signal },
        ).then((r) => r.data.items.map((i) => ({ value: i.id, label: requestLabel(i) })))
      }
      selected={selected}
      value={value}
      status={status}
      disabled={disabled}
      placeholder={t('procurement.selectRequest')}
      onChange={onChange}
    />
  );
}

function QuoteStatus({ status }: { status: string }) {
  const { t } = useTranslation();
  const tone: Record<string, StatusTone> = {
    DRAFT: 'neutral',
    SENT: 'info',
    RECEIVED: 'success',
    CLOSED: 'neutral',
    CANCELLED: 'danger',
  };
  return <StatusTag tone={tone[status] ?? 'neutral'}>{t(`procurement.statuses.${status}`)}</StatusTag>;
}

// ------------------------------------------------------------------ page

export function PurchaseQuotesPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  // A request can open this page (?requestId=...): its quote and comparison start from it.
  // The state keeps the value after the address is cleaned up below.
  const requestIdParam = params.get('requestId') ?? undefined;
  const [initialRequestId, setInitialRequestId] = useState(requestIdParam);
  // Drop the one-off flags from the address, so a refresh or Back does not replay them.
  // `new` is read by QuotesTab (useNewFromUrl), which drops it too; both removals are safe to repeat.
  useEffect(() => {
    if (requestIdParam) setInitialRequestId(requestIdParam);
    if (!params.has('requestId') && !params.has('new')) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('requestId');
        next.delete('new');
        return next;
      },
      { replace: true },
    );
  }, [requestIdParam, params, setParams]);
  const [tab, setTab] = useState('quotes');
  return (
    <div>
      <PageHeader title={t('nav.purchaseQuotes')} />
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'quotes',
            label: t('procurement.quotes'),
            children: <QuotesTab initialRequestId={initialRequestId} />,
          },
          {
            key: 'comparison',
            label: t('procurement.comparison'),
            children: <ComparisonTab initialRequestId={initialRequestId} />,
          },
        ]}
      />
    </div>
  );
}

// ------------------------------------------------------------- quotes tab

function QuotesTab({ initialRequestId }: { initialRequestId?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PURCHASE_MANAGE);
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [statusFilter, setStatusFilter] = useState<ProcurementControllerListQuotesStatus | undefined>(undefined);
  const [screen, setScreen] = useState<'list' | 'form' | 'view' | 'receive'>('list');
  const [quoteId, setQuoteId] = useState<string | null>(null);
  useNewFromUrl(() => {
    setQuoteId(null);
    setScreen('form');
  });

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    PurchaseQuoteListItemDto,
    { status?: ProcurementControllerListQuotesStatus },
    ProcurementControllerListQuotesSort
  >({
    key: procurementKeys.quoteList(),
    filters: { status: statusFilter },
    defaultSort: '-quoteDate',
    fetch: (params, signal) => procurementControllerListQuotes(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });

  const detail = useQuery({
    queryKey: procurementKeys.quote(quoteId ?? undefined),
    queryFn: ({ signal }) => procurementControllerGetQuote(quoteId!, { signal }).then((r) => r.data),
    enabled: screen !== 'list' && !!quoteId,
  });

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  const send = useMutation({
    mutationFn: (id: string) => procurementControllerSendQuote(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('procurement.sent'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const close = useMutation({
    mutationFn: (id: string) => procurementControllerCloseQuote(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('procurement.closed'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      procurementControllerCancelQuote(id, { reason }, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('procurement.cancelled'));
      void invalidateProcurement(queryClient);
    },
    onError,
  });
  const receive = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReceivePurchaseQuoteDto }) =>
      procurementControllerReceiveQuote(id, body, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('procurement.received'));
      void invalidateProcurement(queryClient);
      setScreen('view');
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => procurementControllerDeleteQuote(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      void invalidateProcurement(queryClient);
      setQuoteId(null);
      setScreen('list');
    },
    onError,
  });

  const columns = [
    {
      title: t('procurement.quoteNo'),
      dataIndex: 'quoteNo',
      key: 'quoteNo',
      sorter: true,
      sortOrder: list.sortOrderOf('quoteNo'),
      className: 'nowrap',
      width: 140,
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('procurement.quoteDate'),
      dataIndex: 'quoteDate',
      key: 'quoteDate',
      sorter: true,
      sortOrder: list.sortOrderOf('quoteDate'),
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('procurement.supplier'),
      dataIndex: 'supplier',
      render: (_: unknown, r: PurchaseQuoteListItemDto) => codeAndName(r.supplier),
    },
    {
      title: t('procurement.request'),
      dataIndex: 'request',
      width: 140,
      render: (_: unknown, r: PurchaseQuoteListItemDto) => r.request.requestNo ?? `#${r.request.id}`,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 130,
      render: (v: string) => <QuoteStatus status={v} />,
    },
    {
      title: t('purchases.grandTotal'),
      dataIndex: 'grandTotal',
      key: 'grandTotal',
      sorter: true,
      sortOrder: list.sortOrderOf('grandTotal'),
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
  ];

  // One message holder for every screen, so a toast survives a switch between them.
  const renderScreen = (): ReactNode => {
    if (screen === 'form') {
      if (quoteId && !detail.data) return <Typography.Text>{t('common.loading')}</Typography.Text>;
      return (
        <QuoteForm
          key={quoteId ?? 'new'}
          quote={quoteId ? detail.data : undefined}
          initialRequestId={initialRequestId}
          apiMessage={apiMessage}
          onBack={() => {
            setQuoteId(null);
            setScreen('list');
          }}
          onSaved={(id) => {
            setQuoteId(id);
            setScreen('view');
          }}
        />
      );
    }

    if ((screen === 'view' || screen === 'receive') && quoteId) {
      if (!detail.data) return <Typography.Text>{t('common.loading')}</Typography.Text>;
      if (screen === 'receive') {
        return (
          <QuoteReceive
            quote={detail.data}
            busy={receive.isPending}
            onBack={() => setScreen('view')}
            onSubmit={(body) => receive.mutate({ id: detail.data!.id, body })}
          />
        );
      }
      return (
        <QuoteView
          quote={detail.data}
          canManage={canManage}
          busy={send.isPending || close.isPending || cancel.isPending || del.isPending}
          onBack={() => {
            setQuoteId(null);
            setScreen('list');
          }}
          onEdit={() => setScreen('form')}
          onReceive={() => setScreen('receive')}
          onSend={(id) => send.mutate(id)}
          onClose={(id) => close.mutate(id)}
          onCancel={(id, reason) => cancel.mutateAsync({ id, reason })}
          onDelete={(id) => del.mutate(id)}
        />
      );
    }

    return (
      <div>
        <ListToolbar
          search={list.search}
          onSearch={list.setSearch}
          filters={
            <Select
              allowClear
              placeholder={t('common.status')}
              value={statusFilter}
              onChange={setStatusFilter}
              options={(['DRAFT', 'SENT', 'RECEIVED', 'CLOSED', 'CANCELLED'] as const).map((s) => ({
                value: s,
                label: t(`procurement.statuses.${s}`),
              }))}
            />
          }
          count={list.total}
          actions={
            canManage ? (
              <Button
                type="primary"
                onClick={() => {
                  setQuoteId(null);
                  setScreen('form');
                }}
              >
                {t('procurement.newQuote')}
              </Button>
            ) : undefined
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
          onRow={(r) => ({
            onClick: () => {
              setQuoteId(r.id);
              setScreen('view');
            },
            style: { cursor: 'pointer' },
          })}
        />
      </div>
    );
  };

  return (
    <>
      {contextHolder}
      {renderScreen()}
    </>
  );
}

// ------------------------------------------------------------ quote form

/** A line of the quote form: a request line and the quantity quoted for it. */
interface DraftLine {
  requestLineId: string;
  lineNo: number;
  label: string;
  qty: string;
}

/** A new quote takes the request's open lines, each for what the request still needs. */
function requestDraftLines(request: PurchaseRequestDetailDto): DraftLine[] {
  return request.lines
    .filter((l) => dec(l.remainingQty).gt(0))
    .map((l) => ({
      requestLineId: l.id,
      lineNo: l.lineNo,
      label: codeAndName(l.item) ?? l.itemId,
      qty: l.remainingQty,
    }));
}

function quoteDraftLines(quote: PurchaseQuoteDetailDto): DraftLine[] {
  return quote.lines.map((l) => ({
    requestLineId: l.requestLineId,
    lineNo: l.requestLine.lineNo,
    label: codeAndName(l.item) ?? l.itemId,
    qty: l.qty,
  }));
}

function QuoteForm({
  quote,
  initialRequestId,
  apiMessage,
  onBack,
  onSaved,
}: {
  /** The DRAFT being edited; undefined for a new quote. */
  quote?: PurchaseQuoteDetailDto;
  initialRequestId?: string;
  apiMessage: MessageApi;
  onBack: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [requestId, setRequestId] = useState<string | undefined>(quote?.requestId ?? initialRequestId);
  const request = useRequestDetail(requestId);
  const [supplierId, setSupplierId] = useState<string | undefined>(quote?.supplierId);
  const [quoteDate, setQuoteDate] = useState<Dayjs>(quote ? dayjs(quote.quoteDate) : dayjs());
  const [validUntil, setValidUntil] = useState<Dayjs | null>(
    quote?.validUntil ? dayjs(quote.validUntil) : null,
  );
  const [notes, setNotes] = useState(quote?.notes ?? '');
  // null until the lines are known: a new quote's come with its request's detail.
  const [lines, setLines] = useState<DraftLine[] | null>(quote ? quoteDraftLines(quote) : null);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (lines === null && request.data && request.data.id === requestId) {
      setLines(requestDraftLines(request.data));
    }
  }, [lines, request.data, requestId]);

  const changeRequest = (id: string | undefined) => {
    setRequestId(id);
    setLines(null);
  };

  // What is still open on the request, for each line's remaining column.
  const remainingOf = (requestLineId: string): string | undefined =>
    request.data?.lines.find((l) => l.id === requestLineId)?.remainingQty;

  const save = useMutation({
    mutationFn: (): Promise<{ data: { id: string } }> => {
      const body = quoteBody({
        supplierId: supplierId!,
        quoteDate: quoteDate.format('YYYY-MM-DD'),
        validUntil: validUntil?.format('YYYY-MM-DD'),
        notes,
        lines: lines ?? [],
      });
      return quote
        ? procurementControllerUpdateQuote(quote.id, body)
        : procurementControllerCreateQuote({ requestId: requestId!, ...body });
    },
    onSuccess: (res) => {
      apiMessage.success(t('common.saved'));
      void invalidateProcurement(queryClient);
      onSaved(res.data.id);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const missing = {
    request: !requestId,
    supplier: !supplierId,
    lines: !(lines ?? []).some((l) => dec(l.qty).gt(0)),
  };
  const trySave = () => {
    if (save.isPending) return;
    if (missing.request || missing.supplier) {
      setTried(true);
      return;
    }
    if (missing.lines) {
      setTried(true);
      apiMessage.warning(t('procurement.noLinesLeft'));
      return;
    }
    save.mutate();
  };
  useDocShortcuts({ onSave: trySave });
  const requiredError = (gap: boolean) => (tried && gap ? t('common.requiredField') : undefined);

  return (
    <DocLayout
      title={quote ? t('procurement.quoteTitle') : t('procurement.newQuote')}
      docNo={quote ? (quote.quoteNo ?? t('procurement.draftNo')) : undefined}
      onBack={onBack}
      actions={
        <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={trySave}>
          {quote ? t('common.save') : t('common.saveDraft')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      <DocFields>
        <DocField label={t('procurement.request')} required error={requiredError(missing.request)}>
          <ApprovedRequestPicker
            value={requestId}
            selected={requestOption(request.data)}
            status={requiredError(missing.request) ? 'error' : undefined}
            // The lines of a saved quote stay with its request.
            disabled={!!quote}
            onChange={changeRequest}
          />
        </DocField>
        <DocField label={t('procurement.supplier')} required error={requiredError(missing.supplier)}>
          <RemoteSelect
            queryKey={['parties', 'pick', 'SUPPLIER']}
            fetchOptions={(q, signal) =>
              partiesControllerList(
                { partyType: 'SUPPLIER', pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}) },
                { signal },
              ).then((r) => r.data.items.map((p) => ({ value: p.id, label: codeAndName(p) ?? p.id })))
            }
            selected={
              quote?.supplier ? { value: quote.supplier.id, label: codeAndName(quote.supplier) ?? quote.supplier.id } : undefined
            }
            status={requiredError(missing.supplier) ? 'error' : undefined}
            value={supplierId}
            onChange={setSupplierId}
          />
        </DocField>
        <DocField label={t('procurement.quoteDate')} required>
          <DatePicker value={quoteDate} onChange={(d) => d && setQuoteDate(d)} />
        </DocField>
        <DocField label={t('procurement.validUntil')}>
          <DatePicker value={validUntil} onChange={setValidUntil} allowClear />
        </DocField>
        <DocField label={t('procurement.notes')} wide>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>

      <Table
        rowKey="requestLineId"
        size="small"
        pagination={false}
        loading={!!requestId && request.isLoading}
        dataSource={lines ?? []}
        locale={{ emptyText: t('procurement.noLinesLeft') }}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('procurement.item'), dataIndex: 'label' },
          {
            title: t('procurement.remaining'),
            width: 120,
            align: 'right' as const,
            render: (_: unknown, l: DraftLine) => qtyCell(remainingOf(l.requestLineId)),
          },
          {
            title: t('procurement.qty'),
            width: 140,
            render: (_: unknown, l: DraftLine) => (
              <InputNumber<string>
                stringMode
                min="0"
                size="small"
                aria-label={t('procurement.qty')}
                value={l.qty}
                style={{ width: '100%' }}
                onChange={(v) =>
                  setLines((ls) =>
                    ls?.map((x) => (x.requestLineId === l.requestLineId ? { ...x, qty: v ?? '' } : x)) ?? null,
                  )
                }
              />
            ),
          },
          {
            title: '',
            width: 60,
            render: (_: unknown, l: DraftLine) => (
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={t('common.delete')}
                onClick={() => setLines((ls) => ls?.filter((x) => x.requestLineId !== l.requestLineId) ?? null)}
              />
            ),
          },
        ]}
      />
    </DocLayout>
  );
}

// ------------------------------------------------------------ quote view

function QuoteView({
  quote,
  canManage,
  busy,
  onBack,
  onEdit,
  onReceive,
  onSend,
  onClose,
  onCancel,
  onDelete,
}: {
  quote: PurchaseQuoteDetailDto;
  canManage: boolean;
  busy: boolean;
  onBack: () => void;
  onEdit: () => void;
  onReceive: () => void;
  onSend: (id: string) => void;
  onClose: (id: string) => void;
  onCancel: (id: string, reason: string) => Promise<unknown>;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonTried, setReasonTried] = useState(false);
  const isDraft = quote.status === 'DRAFT';
  const isOpen = quote.status === 'SENT' || quote.status === 'RECEIVED';

  const confirmCancel = async () => {
    if (!reason.trim()) {
      setReasonTried(true);
      return;
    }
    try {
      await onCancel(quote.id, reason.trim());
      setCancelOpen(false);
      setReason('');
      setReasonTried(false);
    } catch {
      // The mutation has already shown the error; the dialog stays open for a retry.
    }
  };

  return (
    <DocLayout
      title={t('procurement.quoteTitle')}
      docNo={quote.quoteNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <>
          {canManage && isDraft && (
            <>
              <Button onClick={onEdit}>{t('common.edit')}</Button>
              <Popconfirm title={t('procurement.confirmSend')} onConfirm={() => onSend(quote.id)}>
                <Button type="primary" disabled={busy}>
                  {t('procurement.send')}
                </Button>
              </Popconfirm>
              <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => onDelete(quote.id)}>
                <Button danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
              </Popconfirm>
            </>
          )}
          {canManage && quote.status === 'SENT' && (
            <Button type="primary" onClick={onReceive}>
              {t('procurement.receive')}
            </Button>
          )}
          {canManage && isOpen && (
            <>
              <Popconfirm title={t('procurement.confirmClose')} onConfirm={() => onClose(quote.id)}>
                <Button disabled={busy}>{t('procurement.close')}</Button>
              </Popconfirm>
              <Button danger onClick={() => setCancelOpen(true)}>
                {t('procurement.cancel')}
              </Button>
            </>
          )}
          {/* The RFQ goes to the supplier: its PDF is the document sent, not the screen. */}
          <PrintPdfButton path={`/purchase-quotes/${quote.id}/pdf`} />
        </>
      }
    >
      <DocFields>
        <DocField label={t('common.status')}>
          <DocValue>
            <QuoteStatus status={quote.status} />
          </DocValue>
        </DocField>
        <DocField label={t('procurement.request')}>
          <DocValue>{quote.request.requestNo ?? `#${quote.request.id}`}</DocValue>
        </DocField>
        <DocField label={t('procurement.supplier')}>
          <DocValue>{displayName(quote.supplier) ?? '—'}</DocValue>
        </DocField>
        <DocField label={t('procurement.quoteDate')}>
          <DocValue>{dayjs(quote.quoteDate).format('YYYY-MM-DD')}</DocValue>
        </DocField>
        <DocField label={t('procurement.validUntil')}>
          <DocValue>{quote.validUntil ? dayjs(quote.validUntil).format('YYYY-MM-DD') : '—'}</DocValue>
        </DocField>
        <DocField label={t('procurement.supplierRef')}>
          <DocValue>{quote.supplierRef ?? '—'}</DocValue>
        </DocField>
        <DocField label={t('procurement.net')}>
          <DocValue>{amountCell(quote.netTotal)}</DocValue>
        </DocField>
        <DocField label={t('procurement.tax')}>
          <DocValue>{amountCell(quote.taxTotal)}</DocValue>
        </DocField>
        <DocField label={t('purchases.grandTotal')}>
          <DocValue>{amountCell(quote.grandTotal)}</DocValue>
        </DocField>
        {quote.notes && (
          <DocField label={t('procurement.notes')} wide>
            <DocValue>{quote.notes}</DocValue>
          </DocField>
        )}
        {quote.status === 'CANCELLED' && quote.cancelReason && (
          <DocField label={t('procurement.reason')} wide>
            <DocValue>{t('procurement.cancelledReason', { reason: quote.cancelReason })}</DocValue>
          </DocField>
        )}
      </DocFields>
      <Typography.Text type="secondary">
        {quote.pricesIncludeTax ? t('procurement.pricesIncludeTax') : t('procurement.pricesExcludeTax')}
      </Typography.Text>

      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={quote.lines}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('procurement.item'), render: (_: unknown, l: PurchaseQuoteLineViewDto) => codeAndName(l.item) ?? l.itemId },
          { title: t('procurement.qty'), dataIndex: 'qty', width: 100, align: 'right' as const, render: qtyCell },
          { title: t('procurement.unitPrice'), dataIndex: 'unitPrice', width: 110, align: 'right' as const, render: unitCostCell },
          { title: t('procurement.discountPct'), dataIndex: 'discountPct', width: 90, align: 'right' as const },
          { title: t('procurement.net'), dataIndex: 'netAmount', width: 110, align: 'right' as const, render: amountCell },
          { title: t('procurement.tax'), dataIndex: 'taxAmount', width: 100, align: 'right' as const, render: amountCell },
          { title: t('procurement.total'), dataIndex: 'lineTotal', width: 110, align: 'right' as const, render: amountCell },
        ]}
      />

      <Modal
        open={cancelOpen}
        title={t('procurement.cancelTitle')}
        okText={t('procurement.cancel')}
        okButtonProps={{ danger: true, loading: busy }}
        cancelText={t('common.close')}
        onOk={() => void confirmCancel()}
        onCancel={() => {
          setCancelOpen(false);
          setReasonTried(false);
        }}
      >
        <Form layout="vertical">
          <Form.Item
            label={t('procurement.reason')}
            required
            validateStatus={reasonTried && !reason.trim() ? 'error' : undefined}
            help={reasonTried && !reason.trim() ? t('procurement.reasonRequired') : undefined}
          >
            <Input.TextArea
              value={reason}
              maxLength={500}
              autoSize={{ minRows: 2, maxRows: 5 }}
              onChange={(e) => setReason(e.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </DocLayout>
  );
}

// ------------------------------------------------------- price entry

/** Typed prices of a SENT quote, keyed by quote line id; blank strings until typed. */
interface PriceDraft {
  unitPrice: string;
  discountPct: string;
}

function QuoteReceive({
  quote,
  busy,
  onBack,
  onSubmit,
}: {
  quote: PurchaseQuoteDetailDto;
  busy: boolean;
  onBack: () => void;
  onSubmit: (body: ReceivePurchaseQuoteDto) => void;
}) {
  const { t } = useTranslation();
  const [prices, setPrices] = useState<Record<string, PriceDraft>>(() =>
    Object.fromEntries(
      quote.lines.map((l) => [l.id, { unitPrice: l.unitPrice ?? '', discountPct: l.discountPct ?? '' }]),
    ),
  );
  const [supplierRef, setSupplierRef] = useState(quote.supplierRef ?? '');
  const [validUntil, setValidUntil] = useState<Dayjs | null>(
    quote.validUntil ? dayjs(quote.validUntil) : null,
  );
  const [tried, setTried] = useState(false);

  const priceOf = (id: string): PriceDraft => prices[id] ?? { unitPrice: '', discountPct: '' };
  const setPrice = (id: string, patch: Partial<PriceDraft>) =>
    setPrices((p) => ({ ...p, [id]: { ...priceOf(id), ...patch } }));
  // Every line needs a price above zero (ADR-025 §10). The helper lists the lines without one;
  // their cells are marked after a first try, and the call is blocked until they are filled.
  const missing = new Set(
    missingReceivePrices(quote.lines.map((l) => ({ lineId: l.id, unitPrice: priceOf(l.id).unitPrice }))),
  );

  const submit = () => {
    if (busy) return;
    if (quote.lines.length === 0 || missing.size > 0) {
      setTried(true);
      return;
    }
    onSubmit(
      receiveBody(
        quote.lines.map((l) => ({
          lineId: l.id,
          unitPrice: priceOf(l.id).unitPrice,
          discountPct: priceOf(l.id).discountPct,
        })),
        supplierRef,
        validUntil?.format('YYYY-MM-DD'),
      ),
    );
  };
  useDocShortcuts({ onSave: submit });

  return (
    <DocLayout
      title={t('procurement.receive')}
      docNo={quote.quoteNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={submit}>
          {t('common.save')}
          <span className="doc-kbd">Ctrl+S</span>
        </Button>
      }
    >
      {tried && missing.size > 0 && (
        <Alert type="warning" showIcon message={t('procurement.quotesUi.missingPrices')} />
      )}
      <DocFields>
        <DocField label={t('procurement.supplierRef')}>
          <Input value={supplierRef} maxLength={100} onChange={(e) => setSupplierRef(e.target.value)} />
        </DocField>
        <DocField label={t('procurement.validUntil')}>
          <DatePicker value={validUntil} onChange={setValidUntil} allowClear />
        </DocField>
      </DocFields>
      <Typography.Text type="secondary">
        {quote.pricesIncludeTax ? t('procurement.pricesIncludeTax') : t('procurement.pricesExcludeTax')}
      </Typography.Text>

      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={quote.lines}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          { title: t('procurement.item'), render: (_: unknown, l: PurchaseQuoteLineViewDto) => codeAndName(l.item) ?? l.itemId },
          { title: t('procurement.qty'), dataIndex: 'qty', width: 100, align: 'right' as const, render: qtyCell },
          {
            title: t('procurement.unitPrice'),
            width: 150,
            render: (_: unknown, l: PurchaseQuoteLineViewDto) => (
              <InputNumber<string>
                stringMode
                min="0"
                size="small"
                aria-label={t('procurement.quotesUi.priceFor', { item: l.item.code, line: l.lineNo })}
                status={tried && missing.has(l.id) ? 'error' : undefined}
                value={priceOf(l.id).unitPrice}
                style={{ width: '100%' }}
                onChange={(v) => setPrice(l.id, { unitPrice: v ?? '' })}
              />
            ),
          },
          {
            title: t('procurement.discountPct'),
            width: 110,
            render: (_: unknown, l: PurchaseQuoteLineViewDto) => (
              <InputNumber<string>
                stringMode
                min="0"
                max="100"
                size="small"
                aria-label={t('procurement.quotesUi.discountFor', { item: l.item.code, line: l.lineNo })}
                value={priceOf(l.id).discountPct}
                style={{ width: '100%' }}
                onChange={(v) => setPrice(l.id, { discountPct: v ?? '' })}
              />
            ),
          },
        ]}
      />
    </DocLayout>
  );
}

// ------------------------------------------------------------ comparison tab

function ComparisonTab({ initialRequestId }: { initialRequestId?: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canManage = can(PERMISSIONS.PURCHASE_MANAGE);
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [requestId, setRequestId] = useState<string | undefined>(initialRequestId);
  const request = useRequestDetail(requestId);
  // null until the user chooses: the picks then follow the comparison's lowest offers.
  const [userPicks, setUserPicks] = useState<QuotePicks | null>(null);
  const [warehouseChoice, setWarehouseChoice] = useState<string | undefined>(undefined);
  const [orderDate, setOrderDate] = useState<Dayjs>(dayjs());
  const [expectedDate, setExpectedDate] = useState<Dayjs | null>(null);
  const costCenters = useCostCenters();
  const [costCenterId, setCostCenterId] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState('');
  const [created, setCreated] = useState<number | null>(null);
  const [tried, setTried] = useState(false);

  const comparison = useQuery({
    queryKey: procurementKeys.comparison(requestId),
    queryFn: ({ signal }) => procurementControllerComparison(requestId!, { signal }).then((r) => r.data),
    enabled: !!requestId,
  });
  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) ?? w.id }));
  // A company with a single warehouse does not need it picked.
  const warehouseId =
    warehouseChoice ?? (warehouses.data?.length === 1 ? warehouses.data[0].id : undefined);

  const picks: QuotePicks = useMemo(
    () => userPicks ?? (comparison.data ? defaultPicks(comparison.data) : {}),
    [userPicks, comparison.data],
  );
  const hasPicks = Object.keys(picks).length > 0;

  const convert = useMutation({
    mutationFn: () =>
      procurementControllerConvertRequest(
        requestId!,
        convertBody(
          {
            orderDate: orderDate.format('YYYY-MM-DD'),
            expectedDate: expectedDate?.format('YYYY-MM-DD'),
            warehouseId: warehouseId!,
            costCenterId: costCenters.enabled ? costCenterId : undefined,
            notes,
          },
          picks,
        ),
        { headers: idemHeaders() },
      ),
    onSuccess: async (res) => {
      const count = res.data.orders.length;
      setCreated(count);
      setUserPicks(null);
      apiMessage.success(t('procurement.ordersCreated', { count }));
      // The mutation stays pending until the comparison is fetched again, so the
      // button stays disabled meanwhile and a second click cannot create the orders twice.
      await invalidateProcurement(queryClient);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const submit = () => {
    if (convert.isPending || !hasPicks) return;
    if (!warehouseId) {
      setTried(true);
      return;
    }
    convert.mutate();
  };

  const lines = comparison.data?.lines ?? [];

  return (
    <div>
      {contextHolder}
      <DocFields>
        <DocField label={t('procurement.request')} required>
          <ApprovedRequestPicker
            value={requestId}
            selected={requestOption(request.data)}
            onChange={(id) => {
              setRequestId(id);
              setUserPicks(null);
              setCreated(null);
            }}
          />
        </DocField>
      </DocFields>

      {requestId &&
        lines.map((line) => {
          const open = dec(line.remainingQty).gt(0);
          return (
            <section key={line.requestLineId} className="doc-section">
              <DocFields>
                <DocField label={t('procurement.item')}>
                  <DocValue>{codeAndName(line.item) ?? line.item.id}</DocValue>
                </DocField>
                <DocField label={t('procurement.qty')}>
                  <DocValue>{qtyCell(line.qty)}</DocValue>
                </DocField>
                <DocField label={t('procurement.ordered')}>
                  <DocValue>{qtyCell(line.orderedQty)}</DocValue>
                </DocField>
                <DocField label={t('procurement.remaining')}>
                  <DocValue>{qtyCell(line.remainingQty)}</DocValue>
                </DocField>
              </DocFields>
              {!open && <Typography.Text type="secondary">{t('procurement.noLinesLeft')}</Typography.Text>}
              {open && line.offers.length === 0 && (
                <Typography.Text type="secondary">{t('procurement.quotesUi.noOfferYet')}</Typography.Text>
              )}
              {line.offers.length > 0 && (
                <Radio.Group
                  // An empty choice means the line is left out of the order.
                  value={picks[line.requestLineId] ?? ''}
                  disabled={!open || !canManage}
                  onChange={(e) => setUserPicks(withPick(picks, line.requestLineId, e.target.value as string))}
                >
                  <Radio
                    value=""
                    aria-label={t('procurement.quotesUi.skipFor', { item: line.item.code, line: line.lineNo })}
                  >
                    {t('procurement.quotesUi.skipLine')}
                  </Radio>
                  <Table<ComparisonOfferDto>
                    rowKey="quoteLineId"
                    size="small"
                    pagination={false}
                    dataSource={line.offers}
                    columns={[
                      {
                        title: t('procurement.chooseOffer'),
                        width: 110,
                        render: (_: unknown, o: ComparisonOfferDto) => (
                          <Radio
                            value={o.quoteLineId}
                            aria-label={t('procurement.quotesUi.offerFor', { item: line.item.code, line: line.lineNo })}
                          />
                        ),
                      },
                      {
                        title: t('procurement.supplier'),
                        render: (_: unknown, o: ComparisonOfferDto) => (
                          <Space>
                            {codeAndName(o.supplier) ?? o.supplier.id}
                            {o.lowest && <StatusTag tone="success">{t('procurement.lowest')}</StatusTag>}
                          </Space>
                        ),
                      },
                      {
                        title: t('procurement.quoteNo'),
                        render: (_: unknown, o: ComparisonOfferDto) => o.quoteNo ?? t('procurement.draftNo'),
                      },
                      {
                        title: t('procurement.unitPrice'),
                        dataIndex: 'unitPrice',
                        width: 110,
                        align: 'right' as const,
                        render: unitCostCell,
                      },
                      {
                        title: t('procurement.discountPct'),
                        dataIndex: 'discountPct',
                        width: 90,
                        align: 'right' as const,
                      },
                      {
                        title: t('procurement.unitTotal'),
                        dataIndex: 'unitTotal',
                        width: 130,
                        align: 'right' as const,
                        render: unitCostCell,
                      },
                      {
                        title: t('procurement.total'),
                        dataIndex: 'lineTotal',
                        width: 120,
                        align: 'right' as const,
                        render: amountCell,
                      },
                    ]}
                  />
                </Radio.Group>
              )}
            </section>
          );
        })}

      {requestId && lines.length > 0 && (
        <section className="doc-section">
          <DocFields>
            <DocField label={t('procurement.warehouse')} required error={tried && !warehouseId ? t('common.requiredField') : undefined}>
              <GridSelect
                enterOpens
                status={tried && !warehouseId ? 'error' : undefined}
                options={warehouseOptions}
                value={warehouseId}
                onChange={(v: string | undefined) => setWarehouseChoice(v)}
              />
            </DocField>
            <DocField label={t('procurement.orderDate')}>
              <DatePicker value={orderDate} onChange={(d) => d && setOrderDate(d)} />
            </DocField>
            <DocField label={t('procurement.expectedDate')}>
              <DatePicker value={expectedDate} onChange={setExpectedDate} allowClear />
            </DocField>
            {costCenters.enabled && (
              <DocField label={<CostCenterLabel />}>
                <CostCenterSelect rows={costCenters.rows} value={costCenterId} onChange={setCostCenterId} />
              </DocField>
            )}
            <DocField label={t('procurement.notes')} wide>
              <Input value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
            </DocField>
          </DocFields>
          <Space wrap>
            {canManage && (
              <Button type="primary" disabled={!hasPicks} loading={convert.isPending} onClick={submit}>
                {t('procurement.createOrders')}
              </Button>
            )}
            {created !== null && <Link to="/purchase-orders">{t('procurement.orders')}</Link>}
          </Space>
          <div>
            <Typography.Text type="secondary">{t('procurement.noEffectHint')}</Typography.Text>
          </div>
        </section>
      )}
    </div>
  );
}
