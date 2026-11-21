import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Table,
  Typography,
  message,
} from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  catalogControllerGetItem,
  catalogControllerListItems,
  procurementControllerApproveRequest,
  procurementControllerCancelRequest,
  procurementControllerCloseRequest,
  procurementControllerCreateRequest,
  procurementControllerDeleteRequest,
  procurementControllerGetRequest,
  procurementControllerListRequests,
  procurementControllerRejectRequest,
  procurementControllerSubmitRequest,
  procurementControllerUpdateRequest,
  type ItemListItemDto,
  type ProcurementControllerListRequestsSort,
  type ProcurementControllerListRequestsStatus,
  type PurchaseOrderStatus,
  type PurchaseQuoteStatus,
  type PurchaseRequestDetailDto,
  type PurchaseRequestLineViewDto,
  type ProcurementSupplierRefDto,
  type PurchaseRequestListItemDto,
  type PurchaseRequestStatus,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { GridHint } from '../components/GridHint';
import {
  enterTo,
  focusCellEl,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
  isSelectDropdownOpen,
} from '../components/GridSelect';
import { cellLabel } from '../components/gridA11y';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { useNewFromUrl } from '../useNewFromUrl';
import { idemHeaders } from '../idempotency';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import { amountCell, qtyCell } from '../format/cells';
import { codeAndName } from '../i18n/displayName';
import {
  approvalBlockedAsOwnDocument,
  purchaseRequestBody,
  requestActions,
  type RequestAction,
} from './procurement/requestPayload';
import { invalidateProcurement, procurementKeys } from './procurement/queryKeys';

// ------------------------------------------------------------------ helpers

const REQUEST_STATUSES: readonly PurchaseRequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'CLOSED',
];

/** Colour carries meaning only (UI-13): waiting for approval needs attention, a refusal is blocked. */
function statusTone(status: string): StatusTone {
  switch (status) {
    case 'SUBMITTED':
      return 'warning';
    case 'APPROVED':
    case 'RECEIVED':
      return 'success';
    case 'SENT':
      return 'info';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function StatusLabel({ status }: { status: PurchaseRequestStatus | PurchaseQuoteStatus | PurchaseOrderStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={statusTone(status)}>{t(`procurement.statuses.${status}`)}</StatusTag>;
}

const isoDate = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : undefined);

/** Sentinel for "the item's base unit" in the unit picker; the payload sends no itemUnitId for it. */
const BASE_UNIT = 'base';

/** Next free line key; keys are only for React and the grid's focus, not sent to the API. */
const nextLineKey = (lines: readonly { key: number }[]) =>
  lines.reduce((max, l) => Math.max(max, l.key), 0) + 1;

// ------------------------------------------------------------------ page

export function PurchaseRequestsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [screen, setScreen] = useState<'list' | 'entry'>('list');
  // null: a new request.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProcurementControllerListRequestsStatus | undefined>(undefined);
  const canManage = can(PERMISSIONS.PURCHASE_REQUEST_MANAGE);

  const openNew = () => {
    setRequestId(null);
    setScreen('entry');
  };
  useNewFromUrl(() => {
    if (canManage) openNew();
  });

  // Server-paged (ADR-022): search, status filter, sort and page go to the API.
  const list = usePagedQuery<
    PurchaseRequestListItemDto,
    { status?: ProcurementControllerListRequestsStatus },
    ProcurementControllerListRequestsSort
  >({
    key: procurementKeys.requestList(),
    filters: { status: statusFilter },
    defaultSort: '-requestDate',
    fetch: (params, signal) => procurementControllerListRequests(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });

  const detail = useQuery({
    queryKey: procurementKeys.request(requestId ?? undefined),
    queryFn: ({ signal }) => procurementControllerGetRequest(requestId!, { signal }).then((r) => r.data),
    enabled: screen === 'entry' && !!requestId,
  });
  const request = detail.data;

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  // One mutation for the state changes on a submitted or approved request (approve, reject,
  // cancel, close). Each user action gets its own Idempotency-Key (ADR-025 §15). Submit lives
  // in the editor, because it saves the form first.
  type StateChange =
    | { kind: 'approve' | 'close'; id: string }
    | { kind: 'reject' | 'cancel'; id: string; reason: string };
  const change = useMutation({
    mutationFn: (c: StateChange) => {
      const options = { headers: idemHeaders() };
      switch (c.kind) {
        case 'approve':
          return procurementControllerApproveRequest(c.id, options);
        case 'close':
          return procurementControllerCloseRequest(c.id, options);
        case 'reject':
          return procurementControllerRejectRequest(c.id, { reason: c.reason }, options);
        case 'cancel':
          return procurementControllerCancelRequest(c.id, { reason: c.reason }, options);
      }
    },
    onSuccess: (_res, c) => {
      const done: Record<StateChange['kind'], string> = {
        approve: 'procurement.approved',
        reject: 'procurement.rejected',
        cancel: 'procurement.cancelled',
        close: 'procurement.closed',
      };
      apiMessage.success(t(done[c.kind]));
    },
    onError,
    // Settled, not success: a failed call may still have changed the server.
    onSettled: () => invalidateProcurement(queryClient),
  });

  const remove = useMutation({
    mutationFn: (id: string) => procurementControllerDeleteRequest(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      backToList();
    },
    onError,
    onSettled: () => invalidateProcurement(queryClient),
  });

  const actionPending = change.isPending || remove.isPending;

  const backToList = () => {
    setScreen('list');
    setRequestId(null);
  };
  const openRequest = (id: string) => {
    setRequestId(id);
    setScreen('entry');
  };

  const columns = [
    {
      title: t('procurement.requestNo'),
      dataIndex: 'requestNo',
      key: 'requestNo',
      sorter: true,
      sortOrder: list.sortOrderOf('requestNo'),
      className: 'nowrap',
      width: 150,
      render: (v: string | null) => v ?? t('procurement.draftNo'),
    },
    {
      title: t('procurement.requestDate'),
      dataIndex: 'requestDate',
      key: 'requestDate',
      sorter: true,
      sortOrder: list.sortOrderOf('requestDate'),
      width: 120,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('procurement.neededBy'),
      dataIndex: 'neededBy',
      width: 120,
      render: (v: string | null) => isoDate(v) ?? '—',
    },
    {
      title: t('stock.lines'),
      dataIndex: '_count',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, r: PurchaseRequestListItemDto) => r._count.lines,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 140,
      render: (v: PurchaseRequestStatus) => <StatusLabel status={v} />,
    },
  ];

  let body: ReactNode;
  if (screen === 'entry') {
    if (requestId && !request) {
      body = (
        <Typography.Text>{detail.isError ? t('errors.INTERNAL') : t('common.loading')}</Typography.Text>
      );
    } else if (!request || (request.status === 'DRAFT' && canManage)) {
      body = (
        <RequestEditor
          key={request?.id ?? 'new'}
          request={request}
          onBack={backToList}
          onSaved={(id) => setRequestId(id)}
          onDelete={(id) => remove.mutate(id)}
          actionPending={actionPending}
        />
      );
    } else {
      body = (
        <RequestView
          request={request}
          onBack={backToList}
          actionPending={actionPending}
          onApprove={(id) => change.mutate({ kind: 'approve', id })}
          onReject={(id, reason) => change.mutateAsync({ kind: 'reject', id, reason })}
          onCancel={(id, reason) => change.mutateAsync({ kind: 'cancel', id, reason })}
          onClose={(id) => change.mutate({ kind: 'close', id })}
          onOrder={(id) => navigate(`/purchase-orders?requestId=${encodeURIComponent(id)}`)}
          onQuote={(id) => navigate(`/purchase-quotes?requestId=${encodeURIComponent(id)}`)}
        />
      );
    }
  } else {
    body = (
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
              options={REQUEST_STATUSES.map((s) => ({ value: s, label: t(`procurement.statuses.${s}`) }))}
            />
          }
          count={list.total}
          actions={
            canManage ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
                {t('procurement.newRequest')}
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
          onRow={(r) => ({ onClick: () => openRequest(r.id), style: { cursor: 'pointer' } })}
         scroll={{ x: 'max-content' }}/>
      </div>
    );
  }

  return (
    <div>
      {contextHolder}
      <PageHeader title={t('nav.purchaseRequests')} />
      {body}
    </div>
  );
}

// ---------------------------------------------------------- editor (DRAFT)

interface LineDraft {
  key: number;
  itemId?: string;
  /** Absent means the item's base unit. */
  itemUnitId?: string;
  // Decimal strings (InputNumber stringMode), never JS floats.
  qty?: string | null;
  estimatedPrice?: string | null;
  note?: string;
}

const emptyLine = (key: number): LineDraft => ({ key });

function RequestEditor({
  request,
  onBack,
  onSaved,
  onDelete,
  actionPending,
}: {
  /** Undefined for a new request. */
  request?: PurchaseRequestDetailDto;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDelete: (id: string) => void;
  actionPending: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [requestDate, setRequestDate] = useState<Dayjs>(request ? dayjs(request.requestDate) : dayjs());
  const [neededBy, setNeededBy] = useState<Dayjs | null>(request?.neededBy ? dayjs(request.neededBy) : null);
  const [notes, setNotes] = useState(request?.notes ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    request?.lines.length
      ? request.lines.map((l) => ({
          key: l.lineNo,
          itemId: l.itemId,
          itemUnitId: l.itemUnitId ?? undefined,
          qty: l.qty,
          estimatedPrice: l.estimatedPrice ?? undefined,
          note: l.note ?? undefined,
        }))
      : [emptyLine(1), emptyLine(2)],
  );

  // Items are searched on the server (ADR-022 §8), as on the purchase invoices.
  const items = useRemoteOptions<ItemListItemDto>({
    key: ['items', 'pick', { isActive: 'true' }],
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, ...(q ? { q } : {}), isActive: 'true', purchasable: 'true' },
        { signal },
      ).then((r) => r.data.items),
  });
  // Labels of the saved lines' items, for those the search no longer returns.
  const savedLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of request?.lines ?? []) m.set(l.itemId, codeAndName(l.item));
    return m;
  }, [request]);
  // Current matches and the chosen rows, then the saved lines' items that neither covers.
  const rows = items.withSelected(lines.map((l) => l.itemId)).map((r) => ({
    value: r.id,
    label: codeAndName(r),
  }));
  const shown = new Set(rows.map((r) => r.value));
  for (const l of lines) {
    const label = l.itemId ? savedLabels.get(l.itemId) : undefined;
    if (l.itemId && label && !shown.has(l.itemId)) {
      shown.add(l.itemId);
      rows.push({ value: l.itemId, label });
    }
  }
  const itemOptions = rows;

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  // Creates the request, or updates the draft, with the form as it is now. Returns its id.
  const persist = async (): Promise<string> => {
    const body = purchaseRequestBody(
      {
        requestDate: requestDate.format('YYYY-MM-DD'),
        neededBy: neededBy?.format('YYYY-MM-DD'),
        notes,
      },
      lines,
    );
    if (!request) {
      const res = await procurementControllerCreateRequest(body);
      return res.data.id;
    }
    await procurementControllerUpdateRequest(request.id, body);
    return request.id;
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      onSaved(id);
    },
    onError,
    onSettled: () => invalidateProcurement(queryClient),
  });

  // Submit saves the draft first, so the submitted request is the one on screen. If the
  // save fails, the error shows and nothing is submitted.
  const submit = useMutation({
    mutationFn: async () => {
      const id = await persist();
      await procurementControllerSubmitRequest(id, { headers: idemHeaders() });
    },
    onSuccess: () => apiMessage.success(t('procurement.submitted')),
    onError,
    onSettled: () => invalidateProcurement(queryClient),
  });

  /** Lines the request would send: a request needs at least one complete line. */
  const completeLineCount = () =>
    purchaseRequestBody({ requestDate: requestDate.format('YYYY-MM-DD') }, lines).lines.length;

  // Save stays enabled: a save with no complete line says what is missing instead.
  const trySave = () => {
    if (save.isPending || submit.isPending) return;
    if (completeLineCount() === 0) {
      apiMessage.warning(t('stock.minLines'));
      focusFirstGridCell();
      return;
    }
    save.mutate();
  };
  // The same check as trySave, then save and submit in one go.
  const submitRequest = () => {
    if (save.isPending || submit.isPending || actionPending) return;
    if (completeLineCount() === 0) {
      apiMessage.warning(t('stock.minLines'));
      focusFirstGridCell();
      return;
    }
    submit.mutate();
  };
  useDocShortcuts({ onSave: trySave });

  const actions = request ? requestActions(request.status, can) : [];
  const busy = save.isPending || submit.isPending || actionPending;

  return (
    <DocLayout
      title={request ? t('procurement.requestTitle') : t('procurement.newRequest')}
      docNo={request ? (request.requestNo ?? t('procurement.draftNo')) : undefined}
      status="DRAFT"
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <Button
            loading={save.isPending}
            disabled={busy}
            icon={<SaveOutlined />}
            onClick={trySave}
          >
            {request ? t('common.save') : t('common.saveDraft')}
            <span className="doc-kbd">Ctrl+S</span>
          </Button>
          {request && actions.includes('submit') && (
            <Popconfirm title={t('procurement.confirmSubmit')} onConfirm={submitRequest} disabled={busy}>
              <Button type="primary" loading={submit.isPending} disabled={busy}>
                {t('procurement.submit')}
              </Button>
            </Popconfirm>
          )}
          {request && actions.includes('delete') && (
            <Popconfirm
              title={t('common.confirmDelete')}
              onConfirm={() => onDelete(request.id)}
              disabled={busy}
            >
              <Button danger icon={<DeleteOutlined />} disabled={busy} aria-label={t('common.delete')} />
            </Popconfirm>
          )}
        </>
      }
    >
      <DocFields>
        <DocField field="requestDate" label={t('procurement.requestDate')} required>
          <DatePicker value={requestDate} onChange={(d) => d && setRequestDate(d)} />
        </DocField>
        <DocField
          field="neededBy"
          label={t('procurement.neededBy')}
          onKeyDown={enterTo(() => focusNamedField('notes'))}
        >
          <DatePicker value={neededBy} onChange={setNeededBy} allowClear />
        </DocField>
        <DocField field="notes" label={t('procurement.notes')} wide onKeyDown={enterTo(focusFirstGridCell)}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>

      <RequestLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('procurement.noEffectHint')}
      </Typography.Text>
    </DocLayout>
  );
}

// ------------------------------------------------------------ lines grid

const COL_ITEM = 1;
const COL_UNIT = 2;
const COL_QTY = 3;
const COL_PRICE = 4;
const COL_NOTE = 5;
// Editable columns in the order Enter and the arrows move through them.
const NAV_COLS = [COL_ITEM, COL_UNIT, COL_QTY, COL_PRICE, COL_NOTE];

/**
 * Lines of a purchase request: item, unit, quantity, optional estimated price and a note.
 * Same keyboard behaviour as the item grids (ItemLinesGrid): Enter moves right then down,
 * Enter on the last cell adds a line, the arrows move between cells.
 */
function RequestLinesGrid({
  lines,
  onChange,
  itemOptions,
  onItemSearch,
}: {
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  itemOptions: { value: string; label: string }[];
  onItemSearch: (text: string) => void;
}) {
  const { t } = useTranslation();
  const gridRef = useRef<HTMLTableElement>(null);

  const update = (key: number, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const remove = (key: number) => {
    const next = lines.filter((l) => l.key !== key);
    onChange(next.length ? next : [emptyLine(nextLineKey(lines))]);
  };

  const addRow = () => onChange([...lines, emptyLine(nextLineKey(lines))]);

  const focusCell = (row: number, col: number) => {
    focusCellEl(gridRef.current?.querySelector<HTMLElement>(`[data-cell="${row}-${col}"]`));
  };

  // Focus once the cell exists; retry once if the new row has not rendered yet.
  const focusSoon = (row: number, col: number) => {
    requestAnimationFrame(() => {
      if (gridRef.current?.querySelector(`[data-cell="${row}-${col}"]`)) focusCell(row, col);
      else setTimeout(() => focusCell(row, col), 60);
    });
  };

  const advance = (row: number, col: number) => {
    let nextRow = row;
    let nextPos = NAV_COLS.indexOf(col) + 1;
    if (nextPos >= NAV_COLS.length) {
      nextRow += 1;
      nextPos = 0;
    }
    if (nextRow >= lines.length) {
      addRow();
      focusSoon(nextRow, NAV_COLS[0]);
    } else {
      focusCell(nextRow, NAV_COLS[nextPos]);
    }
  };

  const onCellKeyDown = (e: KeyboardEvent, row: number, col: number) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    // An open list handles Enter itself (it picks, then GridSelect advances).
    if (isSelectDropdownOpen(e.currentTarget)) return;
    e.preventDefault();
    advance(row, col);
  };

  // Capture phase, so InputNumber's step-on-arrow and an open list do not swallow the keys.
  const onCellKeyDownCapture = (e: KeyboardEvent, row: number, col: number) => {
    if (e.nativeEvent.isComposing || isSelectDropdownOpen(e.currentTarget)) return;
    const key = e.key;
    if (!key.startsWith('Arrow')) return;
    const pos = NAV_COLS.indexOf(col);
    const isSelectCell = !!e.currentTarget.querySelector('.ant-select');
    if (isSelectCell && (key === 'ArrowUp' || key === 'ArrowDown')) return;

    let nr = row;
    let nc = pos;
    if (key === 'ArrowLeft') nc -= 1;
    else if (key === 'ArrowRight') nc += 1;
    else if (key === 'ArrowUp') nr -= 1;
    else nr += 1;
    if (nr < 0 || nr >= lines.length || nc < 0 || nc >= NAV_COLS.length) return;

    e.preventDefault();
    e.stopPropagation();
    focusCell(nr, NAV_COLS[nc]);
  };

  const cellProps = (row: number, col: number) => ({
    'data-cell': `${row}-${col}`,
    onKeyDownCapture: (e: KeyboardEvent) => onCellKeyDownCapture(e, row, col),
    onKeyDown: (e: KeyboardEvent) => onCellKeyDown(e, row, col),
  });

  return (
    <div className="entry-grid-frame">
      <div className="entry-grid-scroll">
        <table ref={gridRef} className="entry-grid">
          <thead>
            <tr>
              <th className="row-no">#</th>
              <th>{t('procurement.item')}</th>
              <th style={{ width: 150 }}>{t('procurement.unit')}</th>
              <th className="num-cell" style={{ width: 110 }}>{t('procurement.qty')}</th>
              <th className="num-cell" style={{ width: 130 }}>{t('procurement.estimatedPrice')}</th>
              <th>{t('procurement.lineNote')}</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, row) => (
              <tr key={l.key}>
                <td className="row-no">{row + 1}</td>
                <td {...cellProps(row, COL_ITEM)}>
                  <GridSelect
                    aria-label={cellLabel(t, t('procurement.item'), row)}
                    variant="borderless"
                    placeholder={t('procurement.item')}
                    options={itemOptions}
                    onRemoteSearch={onItemSearch}
                    value={l.itemId}
                    // A new item starts at its base unit.
                    onChange={(v: string) => update(l.key, { itemId: v, itemUnitId: undefined })}
                    onEnterSelect={() => advance(row, COL_ITEM)}
                    style={{ width: '100%' }}
                    size="small"
                  />
                </td>
                <td {...cellProps(row, COL_UNIT)}>
                  <UnitCell
                    label={cellLabel(t, t('procurement.unit'), row)}
                    itemId={l.itemId}
                    value={l.itemUnitId}
                    onChange={(unitId) => update(l.key, { itemUnitId: unitId })}
                    onEnterSelect={() => advance(row, COL_UNIT)}
                  />
                </td>
                <td className="num-cell" {...cellProps(row, COL_QTY)}>
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.qty'), row)}
                    variant="borderless"
                    stringMode
                    min="0.000001"
                    placeholder={t('procurement.qty')}
                    value={l.qty}
                    onChange={(v) => update(l.key, { qty: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td className="num-cell" {...cellProps(row, COL_PRICE)}>
                  <InputNumber<string>
                    aria-label={cellLabel(t, t('procurement.estimatedPrice'), row)}
                    variant="borderless"
                    stringMode
                    min="0"
                    placeholder={t('procurement.estimatedPrice')}
                    value={l.estimatedPrice}
                    onChange={(v) => update(l.key, { estimatedPrice: v })}
                    style={{ width: '100%' }}
                    size="small"
                    controls={false}
                  />
                </td>
                <td {...cellProps(row, COL_NOTE)}>
                  <Input
                    aria-label={cellLabel(t, t('procurement.lineNote'), row)}
                    variant="borderless"
                    placeholder={t('procurement.lineNote')}
                    maxLength={500}
                    value={l.note}
                    onChange={(e) => update(l.key, { note: e.target.value })}
                    size="small"
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  {lines.length > 1 && (
                    <Button
                      className="row-del"
                      type="text"
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={t('common.delete')}
                      onClick={() => remove(l.key)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="entry-grid-footer">
        <GridHint lineCount={lines.filter((l) => l.itemId).length} />
      </div>
    </div>
  );
}

/** Unit of a line: the item's base unit, or one of its units (ADR-025 §9). Loaded per item. */
function UnitCell({
  label,
  itemId,
  value,
  onChange,
  onEnterSelect,
}: {
  label: string;
  itemId?: string;
  value?: string;
  onChange: (unitId: string | undefined) => void;
  onEnterSelect: () => void;
}) {
  const { t } = useTranslation();
  const item = useQuery({
    queryKey: ['procurement-item-units', itemId],
    queryFn: ({ signal }) => catalogControllerGetItem(itemId!, { signal }).then((r) => r.data),
    enabled: !!itemId,
  });
  const options = useMemo(() => {
    if (!item.data) return [];
    return [
      { value: BASE_UNIT, label: codeAndName(item.data.baseUnit) },
      ...item.data.units
        .filter((u) => u.isActive)
        .map((u) => ({ value: u.id, label: codeAndName(u.unit) })),
    ];
  }, [item.data]);

  return (
    <GridSelect
      aria-label={label}
      variant="borderless"
      placeholder={t('procurement.unit')}
      disabled={!itemId}
      loading={item.isFetching}
      options={options}
      value={itemId ? (value ?? BASE_UNIT) : undefined}
      onChange={(v: string) => onChange(v === BASE_UNIT ? undefined : v)}
      onEnterSelect={onEnterSelect}
      style={{ width: '100%' }}
      size="small"
    />
  );
}

// ------------------------------------------------------ view (other statuses)

function RequestView({
  request,
  onBack,
  actionPending,
  onApprove,
  onReject,
  onCancel,
  onClose,
  onOrder,
  onQuote,
}: {
  request: PurchaseRequestDetailDto;
  onBack: () => void;
  actionPending: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string, reason: string) => Promise<unknown>;
  onClose: (id: string) => void;
  onOrder: (id: string) => void;
  onQuote: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const actions = requestActions(request.status, can);
  const has = (a: RequestAction) => actions.includes(a);
  // Only the owner may approve a document they touched (ADR-025 §2). Rejecting stays open.
  const approveBlocked = approvalBlockedAsOwnDocument({
    createdBy: request.createdBy,
    updatedBy: request.updatedBy,
    submittedBy: request.submittedBy,
    userId: me?.user.id,
    isOwner: me?.currentMembership?.roleCode === 'OWNER',
  });

  return (
    <DocLayout
      title={t('procurement.requestTitle')}
      docNo={request.requestNo ?? t('procurement.draftNo')}
      onBack={onBack}
      actions={
        <>
          {has('approve') &&
            (approveBlocked ? (
              <>
                <Button type="primary" disabled>
                  {t('procurement.approve')}
                </Button>
                <Typography.Text type="secondary">{t('procurement.ownDocument')}</Typography.Text>
              </>
            ) : (
              <Popconfirm title={t('procurement.confirmApprove')} onConfirm={() => onApprove(request.id)}>
                <Button type="primary" loading={actionPending}>
                  {t('procurement.approve')}
                </Button>
              </Popconfirm>
            ))}
          {has('reject') && (
            <Button danger onClick={() => setRejectOpen(true)}>
              {t('procurement.reject')}
            </Button>
          )}
          {has('orderFromRequest') && (
            <Button type="primary" onClick={() => onOrder(request.id)}>
              {t('procurement.orderFromRequest')}
            </Button>
          )}
          {has('quoteFromRequest') && (
            <Button onClick={() => onQuote(request.id)}>{t('procurement.quoteFromRequest')}</Button>
          )}
          {has('close') && (
            <Popconfirm title={t('procurement.confirmClose')} onConfirm={() => onClose(request.id)}>
              <Button>{t('procurement.close')}</Button>
            </Popconfirm>
          )}
          {has('cancel') && (
            <Button danger onClick={() => setCancelOpen(true)}>
              {t('procurement.cancel')}
            </Button>
          )}
        </>
      }
    >
      <DocFields>
        <DocField label={t('common.status')}>
          <DocValue>
            <StatusLabel status={request.status} />
          </DocValue>
        </DocField>
        <DocField label={t('procurement.requestDate')}>
          <DocValue>{isoDate(request.requestDate)}</DocValue>
        </DocField>
        <DocField label={t('procurement.neededBy')}>
          <DocValue>{isoDate(request.neededBy) ?? '—'}</DocValue>
        </DocField>
        {request.notes && (
          <DocField label={t('procurement.notes')} wide>
            <DocValue>{request.notes}</DocValue>
          </DocField>
        )}
        {request.status === 'REJECTED' && (
          <DocField label={t('procurement.reason')} wide>
            <DocValue>{request.rejectReason ?? '—'}</DocValue>
          </DocField>
        )}
        {request.status === 'CANCELLED' && (
          <DocField label={t('procurement.reason')} wide>
            <DocValue>{t('procurement.cancelledReason', { reason: request.cancelReason ?? '—' })}</DocValue>
          </DocField>
        )}
      </DocFields>

      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={request.lines}
        columns={[
          { title: '#', dataIndex: 'lineNo', width: 50 },
          {
            title: t('procurement.item'),
            render: (_: unknown, l: PurchaseRequestLineViewDto) => codeAndName(l.item),
          },
          {
            title: t('procurement.unit'),
            width: 120,
            render: (_: unknown, l: PurchaseRequestLineViewDto) =>
              l.itemUnit ? codeAndName(l.itemUnit.unit) : '—',
          },
          { title: t('procurement.qty'), dataIndex: 'qty', width: 110, align: 'right' as const, render: qtyCell },
          {
            title: t('procurement.ordered'),
            dataIndex: 'orderedQty',
            width: 110,
            align: 'right' as const,
            render: qtyCell,
          },
          {
            title: t('procurement.remaining'),
            dataIndex: 'remainingQty',
            width: 110,
            align: 'right' as const,
            render: qtyCell,
          },
          {
            title: t('procurement.estimatedPrice'),
            dataIndex: 'estimatedPrice',
            width: 120,
            align: 'right' as const,
            render: amountCell,
          },
          {
            title: t('procurement.lineNote'),
            dataIndex: 'note',
            render: (v: string | null) => v ?? '—',
          },
        ]}
       scroll={{ x: 'max-content' }}/>

      <Typography.Text strong>{t('procurement.quotes')}</Typography.Text>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={request.quotes}
        columns={[
          { title: t('procurement.quoteNo'), dataIndex: 'quoteNo', render: (v: string | null) => v ?? t('procurement.draftNo') },
          { title: t('procurement.supplier'), render: (_: unknown, q: { supplier: ProcurementSupplierRefDto }) => codeAndName(q.supplier) },
          { title: t('common.status'), dataIndex: 'status', render: (v: PurchaseQuoteStatus) => <StatusLabel status={v} /> },
          { title: t('procurement.total'), dataIndex: 'grandTotal', width: 130, align: 'right' as const, render: amountCell },
        ]}
       scroll={{ x: 'max-content' }}/>

      <Typography.Text strong>{t('procurement.orders')}</Typography.Text>
      <Table
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={request.orders}
        columns={[
          { title: t('procurement.orderNo'), dataIndex: 'orderNo', render: (v: string | null) => v ?? t('procurement.draftNo') },
          { title: t('procurement.supplier'), render: (_: unknown, o: { supplier: ProcurementSupplierRefDto }) => codeAndName(o.supplier) },
          { title: t('common.status'), dataIndex: 'status', render: (v: PurchaseOrderStatus) => <StatusLabel status={v} /> },
          { title: t('procurement.total'), dataIndex: 'grandTotal', width: 130, align: 'right' as const, render: amountCell },
        ]}
       scroll={{ x: 'max-content' }}/>

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('procurement.noEffectHint')}
      </Typography.Text>

      <ReasonDialog
        open={rejectOpen}
        title={t('procurement.rejectTitle')}
        okText={t('procurement.reject')}
        danger
        onCancel={() => setRejectOpen(false)}
        onConfirm={async (reason) => {
          await onReject(request.id, reason);
          setRejectOpen(false);
        }}
      />
      <ReasonDialog
        open={cancelOpen}
        title={t('procurement.cancelTitle')}
        okText={t('procurement.cancel')}
        danger
        onCancel={() => setCancelOpen(false)}
        onConfirm={async (reason) => {
          await onCancel(request.id, reason);
          setCancelOpen(false);
        }}
      />
    </DocLayout>
  );
}

/** Modal that asks for a reason; the reason is required (ReasonDto). A failed call keeps it open. */
function ReasonDialog({
  open,
  title,
  okText,
  danger,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  okText: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setReason('');
    setMissing(false);
    onCancel();
  };
  const ok = async () => {
    const text = reason.trim();
    if (!text) {
      setMissing(true);
      return;
    }
    setBusy(true);
    try {
      await onConfirm(text);
      setReason('');
    } catch {
      // The mutation already shows the error; keep the dialog open to retry.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      okText={okText}
      cancelText={t('common.cancel')}
      okButtonProps={{ danger, loading: busy }}
      onOk={ok}
      onCancel={close}
    >
      <Input.TextArea
        aria-label={t('procurement.reason')}
        aria-required
        aria-invalid={missing || undefined}
        rows={3}
        maxLength={500}
        value={reason}
        status={missing ? 'error' : undefined}
        onChange={(e) => {
          setReason(e.target.value);
          setMissing(false);
        }}
      />
      {missing && (
        <div role="alert" className="doc-field-error">
          {t('procurement.reasonRequired')}
        </div>
      )}
    </Modal>
  );
}
