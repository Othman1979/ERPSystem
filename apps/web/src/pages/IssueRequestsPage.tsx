import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Button,
  DatePicker,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Table,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  catalogControllerListItems,
  goodsNotesControllerPost,
  issueRequestsControllerApprove,
  issueRequestsControllerCancel,
  issueRequestsControllerClose,
  issueRequestsControllerCreate,
  issueRequestsControllerDelete,
  issueRequestsControllerGet,
  issueRequestsControllerList,
  issueRequestsControllerReject,
  issueRequestsControllerSubmit,
  issueRequestsControllerUpdate,
  receivingControllerIssue,
  warehousesControllerList,
  type GoodsNoteDetailDto,
  type IssueRequestDetailDto,
  type IssueRequestListItemDto,
  type IssueRequestLineViewDto,
  type IssueRequestStatus,
  type IssueRequestsControllerListSort,
  type IssueRequestsControllerListStatus,
  type ItemListItemDto,
} from '@erp/api-client';
import { useAuth } from '../auth/AuthContext';
import { PERMISSIONS } from '../auth/permissions';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { focusFirstGridCell, focusNamedField } from '../components/GridSelect';
import { ItemLinesGrid, emptyItemLine, type ItemLineDraft } from '../components/ItemLinesGrid';
import { ListToolbar } from '../components/ListToolbar';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { StatusTag, type StatusTone } from '../components/StatusTag';
import { useNewFromUrl } from '../useNewFromUrl';
import { idemHeaders } from '../idempotency';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import { useCostCenters } from '../hooks/useCostCenters';
import { useAccounts, type AccountRow } from '../hooks/useAccounts';
import { qtyCell } from '../format/cells';
import { toDecimal } from '../format/number';
import { codeAndName } from '../i18n/displayName';
import { invalidateStockDocument } from '../stockQueries';
import { approvalBlockedAsOwnDocument } from './procurement/requestPayload';
import {
  issueFromRequestBody,
  issueRequestActions,
  issueRequestBody,
  issueRequestGaps,
  overRemainingLineIds,
  type IssueRequestAction,
  type IssueRequestLineInput,
  type IssueRowInput,
} from './procurement/issueRequestPayload';

// ------------------------------------------------------------------ helpers

const ISSUE_REQUEST_KEY = 'issue-requests' as const;
const issueKeys = {
  list: () => [ISSUE_REQUEST_KEY, 'list'] as const,
  detail: (id: string | undefined) => [ISSUE_REQUEST_KEY, 'detail', id] as const,
};
/** Refreshes every issue request query (and the stock figures a posted issue moves). */
const invalidateIssueRequests = (queryClient: ReturnType<typeof useQueryClient>) =>
  queryClient.invalidateQueries({ queryKey: [ISSUE_REQUEST_KEY] });

const REQUEST_STATUSES: readonly IssueRequestStatus[] = [
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
      return 'success';
    case 'REJECTED':
      return 'danger';
    default:
      return 'neutral';
  }
}

function StatusLabel({ status }: { status: IssueRequestStatus }) {
  const { t } = useTranslation();
  return <StatusTag tone={statusTone(status)}>{t(`issueRequests.statuses.${status}`)}</StatusTag>;
}

const isoDate = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD') : undefined);

/** A line that still has quantity to issue. */
const hasRemaining = (l: IssueRequestLineViewDto) => {
  const d = toDecimal(l.remainingQty);
  return !!d && d.gt(0);
};

/** Expense accounts a request may name: active postable expense accounts. Module-level for a stable select. */
const selectExpenseAccounts = (rows: AccountRow[]): AccountRow[] =>
  rows.filter((a) => a.accountType === 'EXPENSE' && a.isActive && a.isPostable);

const lineInput = (l: ItemLineDraft): IssueRequestLineInput => ({
  itemId: l.itemId,
  qty: l.qty,
  note: l.description,
});

// ------------------------------------------------------------------ page

export function IssueRequestsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [screen, setScreen] = useState<'list' | 'entry'>('list');
  // null: a new issue request.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<IssueRequestsControllerListStatus | undefined>(undefined);
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
    IssueRequestListItemDto,
    { status?: IssueRequestsControllerListStatus },
    IssueRequestsControllerListSort
  >({
    key: issueKeys.list(),
    filters: { status: statusFilter },
    defaultSort: '-requestDate',
    fetch: (params, signal) => issueRequestsControllerList(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });

  const detail = useQuery({
    queryKey: issueKeys.detail(requestId ?? undefined),
    queryFn: ({ signal }) => issueRequestsControllerGet(requestId!, { signal }).then((r) => r.data),
    enabled: screen === 'entry' && !!requestId,
  });
  const request = detail.data;

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  // One mutation for the state changes on a submitted or approved request. Each user action
  // gets its own Idempotency-Key (ADR-025 §15). Submit lives in the editor, because it saves
  // the form first; issuing lives in the issue dialog.
  type StateChange =
    | { kind: 'approve' | 'close'; id: string }
    | { kind: 'reject' | 'cancel'; id: string; reason: string };
  const change = useMutation({
    mutationFn: (c: StateChange) => {
      const options = { headers: idemHeaders() };
      switch (c.kind) {
        case 'approve':
          return issueRequestsControllerApprove(c.id, options);
        case 'close':
          return issueRequestsControllerClose(c.id, options);
        case 'reject':
          return issueRequestsControllerReject(c.id, { reason: c.reason }, options);
        case 'cancel':
          return issueRequestsControllerCancel(c.id, { reason: c.reason }, options);
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
    onSettled: () => invalidateIssueRequests(queryClient),
  });

  const remove = useMutation({
    mutationFn: (id: string) => issueRequestsControllerDelete(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      backToList();
    },
    onError,
    onSettled: () => invalidateIssueRequests(queryClient),
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
      title: t('issueRequests.requestNo'),
      dataIndex: 'requestNo',
      key: 'requestNo',
      sorter: true,
      sortOrder: list.sortOrderOf('requestNo'),
      className: 'nowrap',
      width: 150,
      render: (v: string | null) => v ?? t('issueRequests.draftNo'),
    },
    {
      title: t('issueRequests.requestDate'),
      dataIndex: 'requestDate',
      key: 'requestDate',
      sorter: true,
      sortOrder: list.sortOrderOf('requestDate'),
      width: 120,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('stock.warehouse'),
      dataIndex: 'warehouse',
      render: (_: unknown, r: IssueRequestListItemDto) => codeAndName(r.warehouse),
    },
    {
      title: t('issueRequests.costCenter'),
      dataIndex: 'costCenter',
      render: (_: unknown, r: IssueRequestListItemDto) => (r.costCenter ? codeAndName(r.costCenter) : '—'),
    },
    {
      title: t('issueRequests.lines'),
      dataIndex: '_count',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, r: IssueRequestListItemDto) => r._count.lines,
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 140,
      render: (v: IssueRequestStatus) => <StatusLabel status={v} />,
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
        <IssueRequestEditor
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
        <IssueRequestView
          request={request}
          onBack={backToList}
          actionPending={actionPending}
          onApprove={(id) => change.mutate({ kind: 'approve', id })}
          onReject={(id, reason) => change.mutateAsync({ kind: 'reject', id, reason })}
          onCancel={(id, reason) => change.mutateAsync({ kind: 'cancel', id, reason })}
          onClose={(id) => change.mutate({ kind: 'close', id })}
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
              options={REQUEST_STATUSES.map((s) => ({ value: s, label: t(`issueRequests.statuses.${s}`) }))}
            />
          }
          count={list.total}
          actions={
            canManage ? (
              <Button type="primary" icon={<PlusOutlined />} onClick={openNew}>
                {t('issueRequests.newRequest')}
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
        />
      </div>
    );
  }

  return (
    <div>
      {contextHolder}
      <PageHeader title={t('nav.issueRequests')} />
      {body}
    </div>
  );
}

// ---------------------------------------------------------- editor (DRAFT)

function IssueRequestEditor({
  request,
  onBack,
  onSaved,
  onDelete,
  actionPending,
}: {
  /** Undefined for a new issue request. */
  request?: IssueRequestDetailDto;
  onBack: () => void;
  onSaved: (id: string) => void;
  onDelete: (id: string) => void;
  actionPending: boolean;
}) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const costCenters = useCostCenters();
  const expenseAccounts = useAccounts(selectExpenseAccounts);
  const [requestDate, setRequestDate] = useState<Dayjs>(request ? dayjs(request.requestDate) : dayjs());
  const [warehouseId, setWarehouseId] = useState<string | undefined>(request?.warehouseId ?? undefined);
  const [costCenterId, setCostCenterId] = useState<string | undefined>(request?.costCenterId ?? undefined);
  const [expenseAccountId, setExpenseAccountId] = useState<string | undefined>(
    request?.expenseAccountId ?? undefined,
  );
  const [notes, setNotes] = useState(request?.notes ?? '');
  const [lines, setLines] = useState<ItemLineDraft[]>(() =>
    request?.lines.length
      ? request.lines.map((l) => ({
          key: l.lineNo,
          itemId: l.itemId,
          qty: l.qty,
          description: l.note ?? undefined,
        }))
      : [emptyItemLine(1), emptyItemLine(2)],
  );
  // Set after a save attempt with gaps, so the missing fields show their error.
  const [tried, setTried] = useState(false);

  const warehouses = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
  });
  const warehouseOptions = (warehouses.data ?? []).map((w) => ({ value: w.id, label: codeAndName(w) }));

  // Items are searched on the server (ADR-022 §8). Stock items only: an issue moves stock.
  const items = useRemoteOptions<ItemListItemDto>({
    key: ['items', 'pick', { stocked: 'true' }],
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, stocked: 'true', ...(q ? { q } : {}) },
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
  const itemOptions = items.withSelected(lines.map((l) => l.itemId)).map((r) => ({
    value: r.id,
    label: codeAndName(r),
  }));
  const shown = new Set(itemOptions.map((r) => r.value));
  for (const l of lines) {
    const label = l.itemId ? savedLabels.get(l.itemId) : undefined;
    if (l.itemId && label && !shown.has(l.itemId)) {
      shown.add(l.itemId);
      itemOptions.push({ value: l.itemId, label });
    }
  }

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const form = () => ({
    requestDate: requestDate.format('YYYY-MM-DD'),
    warehouseId,
    costCenterId: costCenters.enabled ? costCenterId : undefined,
    expenseAccountId,
    notes,
  });
  const gaps = () => issueRequestGaps({ warehouseId }, lines.map(lineInput));

  // Creates the request, or updates the draft, with the form as it is now. Returns its id.
  const persist = async (): Promise<string> => {
    const body = issueRequestBody(form(), lines.map(lineInput));
    if (!body) throw new Error('issue request incomplete');
    if (!request) {
      const res = await issueRequestsControllerCreate(body, { headers: idemHeaders() });
      return res.data.id;
    }
    await issueRequestsControllerUpdate(request.id, body, { headers: idemHeaders() });
    return request.id;
  };

  const save = useMutation({
    mutationFn: persist,
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      onSaved(id);
    },
    onError,
    onSettled: () => invalidateIssueRequests(queryClient),
  });

  // Submit saves the draft first, so the submitted request is the one on screen. If the
  // save fails, the error shows and nothing is submitted.
  const submit = useMutation({
    mutationFn: async () => {
      const id = await persist();
      await issueRequestsControllerSubmit(id, { headers: idemHeaders() });
    },
    onSuccess: () => apiMessage.success(t('procurement.submitted')),
    onError,
    onSettled: () => invalidateIssueRequests(queryClient),
  });

  /** Marks the missing fields and says what is missing; true when the form is complete. */
  const checkGaps = (): boolean => {
    const missing = gaps();
    if (missing.length === 0) return true;
    setTried(true);
    if (missing.includes('warehouse')) {
      apiMessage.warning(t('issueRequests.warehouseRequired'));
      focusNamedField('warehouse');
    } else {
      apiMessage.warning(t('stock.minLines'));
      focusFirstGridCell();
    }
    return false;
  };

  // Save stays enabled: a save with a gap says what is missing instead.
  const trySave = () => {
    if (save.isPending || submit.isPending) return;
    if (checkGaps()) save.mutate();
  };
  // The same check as trySave, then save and submit in one go.
  const submitRequest = () => {
    if (save.isPending || submit.isPending || actionPending) return;
    if (checkGaps()) submit.mutate();
  };
  useDocShortcuts({ onSave: trySave });

  const actions = request ? issueRequestActions(request.status, can) : [];
  const busy = save.isPending || submit.isPending || actionPending;
  const warehouseError = tried && !warehouseId ? t('common.requiredField') : undefined;

  return (
    <DocLayout
      title={request ? t('issueRequests.requestTitle') : t('issueRequests.newRequest')}
      docNo={request ? (request.requestNo ?? t('issueRequests.draftNo')) : undefined}
      status="DRAFT"
      onBack={onBack}
      actions={
        <>
          {contextHolder}
          <Button loading={save.isPending} disabled={busy} icon={<SaveOutlined />} onClick={trySave}>
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
            <Popconfirm title={t('common.confirmDelete')} onConfirm={() => onDelete(request.id)} disabled={busy}>
              <Button danger icon={<DeleteOutlined />} disabled={busy} aria-label={t('common.delete')} />
            </Popconfirm>
          )}
        </>
      }
    >
      <DocFields>
        <DocField field="requestDate" label={t('issueRequests.requestDate')} required>
          <DatePicker value={requestDate} onChange={(d) => d && setRequestDate(d)} />
        </DocField>
        <DocField field="warehouse" label={t('stock.warehouse')} required error={warehouseError}>
          <Select
            aria-label={t('stock.warehouse')}
            showSearch
            optionFilterProp="label"
            loading={warehouses.isLoading}
            options={warehouseOptions}
            value={warehouseId}
            onChange={(v: string) => setWarehouseId(v)}
            status={warehouseError ? 'error' : undefined}
          />
        </DocField>
        {costCenters.enabled && (
          <DocField field="costCenter" label={<CostCenterLabel />}>
            <CostCenterSelect
              enterOpens
              rows={costCenters.rows}
              value={costCenterId}
              onChange={setCostCenterId}
            />
          </DocField>
        )}
        <DocField field="expenseAccount" label={t('issueRequests.expenseAccount')}>
          <Select
            aria-label={t('issueRequests.expenseAccount')}
            allowClear
            showSearch
            optionFilterProp="label"
            loading={expenseAccounts.isLoading}
            options={(expenseAccounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) }))}
            value={expenseAccountId}
            onChange={(v: string | undefined) => setExpenseAccountId(v)}
          />
        </DocField>
        <DocField field="notes" label={t('issueRequests.notes')} wide>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
        </DocField>
      </DocFields>

      <ItemLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        onItemSearch={items.onSearch}
        showDescription
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('issueRequests.noEffectHint')}
      </Typography.Text>
    </DocLayout>
  );
}

// ------------------------------------------------------ view (other statuses)

function IssueRequestView({
  request,
  onBack,
  actionPending,
  onApprove,
  onReject,
  onCancel,
  onClose,
}: {
  request: IssueRequestDetailDto;
  onBack: () => void;
  actionPending: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string, reason: string) => Promise<unknown>;
  onCancel: (id: string, reason: string) => Promise<unknown>;
  onClose: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const actions = issueRequestActions(request.status, can);
  const has = (a: IssueRequestAction) => actions.includes(a);
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
      title={t('issueRequests.requestTitle')}
      docNo={request.requestNo ?? t('issueRequests.draftNo')}
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
          {has('issue') && (
            <Button type="primary" onClick={() => setIssueOpen(true)}>
              {t('issueRequests.issueAction')}
            </Button>
          )}
          {has('reject') && (
            <Button danger onClick={() => setRejectOpen(true)}>
              {t('procurement.reject')}
            </Button>
          )}
          {has('close') && (
            <Popconfirm title={t('issueRequests.confirmClose')} onConfirm={() => onClose(request.id)}>
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
        <DocField label={t('issueRequests.requestDate')}>
          <DocValue>{isoDate(request.requestDate)}</DocValue>
        </DocField>
        <DocField label={t('stock.warehouse')}>
          <DocValue>{codeAndName(request.warehouse)}</DocValue>
        </DocField>
        {request.costCenter && (
          <DocField label={t('costCenters.documentField')}>
            <DocValue>{codeAndName(request.costCenter)}</DocValue>
          </DocField>
        )}
        {request.expenseAccount && (
          <DocField label={t('issueRequests.expenseAccount')}>
            <DocValue>{codeAndName(request.expenseAccount)}</DocValue>
          </DocField>
        )}
        {request.notes && (
          <DocField label={t('issueRequests.notes')} wide>
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
            title: t('issueRequests.item'),
            render: (_: unknown, l: IssueRequestLineViewDto) => codeAndName(l.item),
          },
          { title: t('issueRequests.qty'), dataIndex: 'qty', width: 110, align: 'right' as const, render: qtyCell },
          {
            title: t('issueRequests.issuedQty'),
            dataIndex: 'issuedQty',
            width: 110,
            align: 'right' as const,
            render: qtyCell,
          },
          {
            title: t('issueRequests.remainingQty'),
            dataIndex: 'remainingQty',
            width: 110,
            align: 'right' as const,
            render: qtyCell,
          },
          {
            title: t('issueRequests.lineNote'),
            dataIndex: 'note',
            render: (v: string | null) => v ?? '—',
          },
        ]}
      />

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('issueRequests.noEffectHint')}
      </Typography.Text>

      {issueOpen && (
        <IssueDialog request={request} onClose={() => setIssueOpen(false)} />
      )}
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

// ------------------------------------------------------- issue dialog

/**
 * Issues what is left of an approved request (ADR-026 §9): creates a draft goods issue
 * note with the quantities below, then offers to post it. The stock moves only on post.
 * Unmounted when closed, so every opening starts from the request's remaining quantities.
 */
function IssueDialog({ request, onClose }: { request: IssueRequestDetailDto; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [noteDate, setNoteDate] = useState<Dayjs>(dayjs());
  const issuable = request.lines.filter(hasRemaining);
  // Quantities to issue now, per request line; each starts at what is left.
  const [qtys, setQtys] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(issuable.map((l) => [l.id, l.remainingQty])),
  );
  // Set once the draft issue note exists: the dialog then offers to post it.
  const [note, setNote] = useState<GoodsNoteDetailDto | null>(null);

  const rows: IssueRowInput[] = request.lines.map((l) => ({
    issueRequestLineId: l.id,
    remainingQty: l.remainingQty,
    qty: qtys[l.id] ?? null,
  }));
  const overIds = overRemainingLineIds(rows);
  const overLine = request.lines.find((l) => l.id === overIds[0]);
  const body = issueFromRequestBody(noteDate.format('YYYY-MM-DD'), rows);

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const create = useMutation({
    mutationFn: async () => {
      if (!body) throw new Error('nothing to issue');
      const res = await receivingControllerIssue(request.id, body, { headers: idemHeaders() });
      return res.data;
    },
    onSuccess: (created) => setNote(created),
    onError,
    // Settled: a failed call may still have created the draft.
    onSettled: () => invalidateIssueRequests(queryClient),
  });

  const post = useMutation({
    mutationFn: (id: string) => goodsNotesControllerPost(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('issueRequests.issued'));
      onClose();
    },
    onError,
    onSettled: () => {
      void invalidateIssueRequests(queryClient);
      invalidateStockDocument(queryClient, 'goodsNote');
    },
  });

  const busy = create.isPending || post.isPending;

  return (
    <Modal
      open
      title={t('issueRequests.issueTitle')}
      onCancel={busy ? undefined : onClose}
      width={720}
      footer={
        note ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('issueRequests.later')}
            </Button>
            <Popconfirm
              title={t('issueRequests.confirmPost')}
              onConfirm={() => post.mutate(note.id)}
              disabled={busy}
            >
              <Button type="primary" loading={post.isPending} disabled={busy}>
                {t('issueRequests.postIssue')}
              </Button>
            </Popconfirm>
          </>
        ) : (
          <>
            <Button onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="primary"
              loading={create.isPending}
              disabled={busy || !body}
              onClick={() => create.mutate()}
            >
              {t('issueRequests.createIssue')}
            </Button>
          </>
        )
      }
    >
      {contextHolder}
      {note ? (
        <Typography.Paragraph>{t('issueRequests.issueDraftCreated')}</Typography.Paragraph>
      ) : (
        <>
          <Typography.Paragraph type="secondary">{t('issueRequests.issueHint')}</Typography.Paragraph>
          <DocFields>
            <DocField label={t('issueRequests.noteDate')} required>
              <DatePicker value={noteDate} onChange={(d) => d && setNoteDate(d)} />
            </DocField>
          </DocFields>
          {issuable.length === 0 ? (
            <Typography.Text type="secondary">{t('issueRequests.noneToIssue')}</Typography.Text>
          ) : (
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={issuable}
              columns={[
                { title: '#', dataIndex: 'lineNo', width: 50 },
                {
                  title: t('issueRequests.item'),
                  render: (_: unknown, l: IssueRequestLineViewDto) => codeAndName(l.item),
                },
                {
                  title: t('issueRequests.remainingQty'),
                  dataIndex: 'remainingQty',
                  width: 110,
                  align: 'right' as const,
                  render: qtyCell,
                },
                {
                  title: t('issueRequests.issueQty'),
                  width: 150,
                  render: (_: unknown, l: IssueRequestLineViewDto) => (
                    <InputNumber<string>
                      aria-label={`${t('issueRequests.issueQty')} ${l.lineNo}`}
                      stringMode
                      min="0"
                      max={l.remainingQty}
                      controls={false}
                      style={{ width: '100%' }}
                      value={qtys[l.id] ?? null}
                      onChange={(v) => setQtys((prev) => ({ ...prev, [l.id]: v }))}
                    />
                  ),
                },
              ]}
            />
          )}
          {overLine && (
            <div role="alert" className="doc-field-error">
              {t('issueRequests.overRemaining', { line: overLine.lineNo })}
            </div>
          )}
        </>
      )}
    </Modal>
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
