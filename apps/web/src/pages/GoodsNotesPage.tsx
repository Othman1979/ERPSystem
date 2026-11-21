import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, PrinterOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Dropdown,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { DatePicker } from '../components/DatePicker';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  emptyItemLine,
  ItemLinesGrid,
  type ItemLineDraft,
} from '../components/ItemLinesGrid';
import {
  ApiError,
  catalogControllerListItems,
  goodsNotesControllerCreate,
  goodsNotesControllerDelete,
  goodsNotesControllerGet,
  goodsNotesControllerList,
  goodsNotesControllerPost,
  goodsNotesControllerUpdate,
  warehousesControllerList,
} from '@erp/api-client';
import type {
  GoodsNoteDetailDto,
  GoodsNoteLineWithItemDto,
  GoodsNoteListItemDto,
  GoodsNotesControllerListSort,
  ItemListItemDto,
} from '@erp/api-client';
import { goodsNoteBody } from './goods/goodsNotePayload';
import { CostCenterLabel, CostCenterSelect } from '../components/CostCenterField';
import { useCostCenters } from '../hooks/useCostCenters';
import { type AccountRow, useAccounts } from '../hooks/useAccounts';
import { idemHeaders } from '../idempotency';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { cellLabel } from '../components/gridA11y';
import { PageHeader } from '../components/PageHeader';
import { tableLocale } from '../components/QueryState';
import { ListToolbar } from '../components/ListToolbar';
import { usePagedQuery } from '../hooks/usePagedQuery';
import { PICKER_PAGE_SIZE, useRemoteOptions } from '../hooks/useRemoteOptions';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { codeAndName } from '../i18n/displayName';
import { qtyCell, unitCostCell } from '../format/cells';
import { invalidateStockDocument } from '../stockQueries';

type GoodsNote = GoodsNoteListItemDto;
type Item = ItemListItemDto;

const NOTE_TYPES = ['GRN', 'GIN'] as const;
type NoteType = (typeof NOTE_TYPES)[number];

const TYPE_LABEL: Record<NoteType, string> = {
  GRN: 'goods.entryVoucher',
  GIN: 'goods.exitVoucher',
};
const TYPE_TAG_COLOR: Record<NoteType, string> = { GRN: 'blue', GIN: 'orange' };

/** Postable expense accounts: the choices of a GIN's expense account (ADR-026 §8). Module-level so the select stays memoised. */
const selectExpenseAccounts = (rows: AccountRow[]): AccountRow[] =>
  rows.filter((a) => a.isActive && a.isPostable && a.accountType === 'EXPENSE');

/** Read-only header fields that name the source documents of a note (order, supplier, request, account, centre). */
function SourceFields({
  entry,
  withAccounts = true,
}: {
  entry: GoodsNoteDetailDto;
  /** False where the account and centre are already editable fields. */
  withAccounts?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {entry.purchaseOrder && (
        <DocField label={t('goods.purchaseOrder')}>
          <DocValue>{entry.purchaseOrder.orderNo ?? `#${entry.purchaseOrder.id}`}</DocValue>
        </DocField>
      )}
      {entry.supplier && (
        <DocField label={t('goods.supplier')}>
          <DocValue>{codeAndName(entry.supplier)}</DocValue>
        </DocField>
      )}
      {entry.issueRequest && (
        <DocField label={t('goods.issueRequest')}>
          <DocValue>{entry.issueRequest.requestNo ?? `#${entry.issueRequest.id}`}</DocValue>
        </DocField>
      )}
      {withAccounts && entry.expenseAccount && (
        <DocField label={t('goods.expenseAccount')}>
          <DocValue>{codeAndName(entry.expenseAccount)}</DocValue>
        </DocField>
      )}
      {withAccounts && entry.costCenter && (
        <DocField label={t('costCenters.documentField')}>
          <DocValue>{codeAndName(entry.costCenter)}</DocValue>
        </DocField>
      )}
    </>
  );
}

function TypeTag({ type }: { type: NoteType }) {
  const { t } = useTranslation();
  return <Tag color={TYPE_TAG_COLOR[type]}>{t(TYPE_LABEL[type])}</Tag>;
}

export function GoodsNotesPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('nav.goodsNotes')} />
      <GoodsNotesSection />
    </div>
  );
}

export function GoodsNotesSection({
  requestVoucher,
  onVoucherHandled,
}: {
  requestVoucher?: NoteType | null;
  onVoucherHandled?: () => void;
} = {}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [screen, setScreen] = useState<'list' | 'entry'>('list');
  const [entryId, setEntryId] = useState<string | null>(null); // null → new voucher
  const [typeFilter, setTypeFilter] = useState<NoteType | undefined>(undefined);

  // ---- new-voucher form state ----
  const [newType, setNewType] = useState<NoteType>('GRN');
  const [newDate, setNewDate] = useState<Dayjs>(dayjs());
  const [newWarehouseId, setNewWarehouseId] = useState<string | undefined>();
  const [newDescription, setNewDescription] = useState('');
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1), emptyItemLine(2)]);
  // GIN only (ADR-026 §8): expense account and department.
  const [newExpenseAccountId, setNewExpenseAccountId] = useState<string | undefined>();
  const [newCostCenterId, setNewCostCenterId] = useState<string | undefined>();
  const costCenters = useCostCenters();
  const expenseAccounts = useAccounts(selectExpenseAccounts);
  const expenseOptions = useMemo(
    () => (expenseAccounts.data ?? []).map((a) => ({ value: a.id, label: codeAndName(a) })),
    [expenseAccounts.data],
  );
  // Draft linked to an order or request: only quantities, date, description (and a GIN's account and centre) change.
  const [editDate, setEditDate] = useState<Dayjs>(dayjs());
  const [editDescription, setEditDescription] = useState('');
  const [editExpenseAccountId, setEditExpenseAccountId] = useState<string | undefined>();
  const [editCostCenterId, setEditCostCenterId] = useState<string | undefined>();
  const [editQty, setEditQty] = useState<Record<string, string | null>>({});
  // New notes start at the warehouse (required, no default); bumped by openNew.
  const [headerFocus, setHeaderFocus] = useState(0);
  useEffect(() => {
    if (!headerFocus) return;
    const id = requestAnimationFrame(() => focusNamedField('warehouse'));
    return () => cancelAnimationFrame(id);
  }, [headerFocus]);

  // Server-paged (ADR-022): search, sort and page go to the API.
  const list = usePagedQuery<GoodsNote, { noteType?: NoteType }, GoodsNotesControllerListSort>({
    key: ['goods-notes', 'list'],
    filters: { noteType: typeFilter },
    defaultSort: '-date',
    fetch: (params, signal) => goodsNotesControllerList(params, { signal }).then((r) => r.data),
    enabled: screen === 'list',
  });
  const notesQuery = list.query;
  const { isLoading } = notesQuery;
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['goods-note', entryId],
    queryFn: ({ signal }) => goodsNotesControllerGet(entryId!, { signal }).then((r) => r.data),
    enabled: screen === 'entry' && !!entryId,
  });

  // Stock items for the new voucher's grid: searched on the server (ADR-022 §8).
  const items = useRemoteOptions<Item>({
    key: ['items', 'pick', { stocked: 'true' }],
    enabled: screen === 'entry' && !entryId,
    fetch: (q, signal) =>
      catalogControllerListItems(
        { pageSize: PICKER_PAGE_SIZE, stocked: 'true', ...(q ? { q } : {}) },
        { signal },
      ).then((r) => r.data.items),
  });
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: ({ signal }) => warehousesControllerList({ signal }).then((r) => r.data),
    enabled: screen === 'entry' && !entryId,
  });

  const itemOptions = items
    .withSelected(lines.map((l) => l.itemId))
    .map((i) => ({ value: i.id, label: codeAndName(i) }));
  const warehouseOptions = (warehouses ?? []).map((w) => ({
    value: w.id,
    label: codeAndName(w),
  }));

  const invalidate = () => invalidateStockDocument(queryClient, 'goodsNote');
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openNew = (type: NoteType) => {
    setEntryId(null);
    setNewType(type);
    setNewDate(dayjs());
    setNewWarehouseId(undefined);
    setNewDescription('');
    setNewExpenseAccountId(undefined);
    setNewCostCenterId(undefined);
    setLines([emptyItemLine(1), emptyItemLine(2)]);
    setHeaderFocus((g) => g + 1);
    setScreen('entry');
  };

  const openEntry = (id: string) => {
    setEntryId(id);
    setScreen('entry');
  };

  const backToList = () => {
    setScreen('list');
    setEntryId(null);
  };

  useEffect(() => {
    if (requestVoucher) {
      openNew(requestVoucher);
      onVoucherHandled?.();
    }
  }, [requestVoucher]);

  const create = useMutation({
    mutationFn: async ({ andPost, warehouseId }: { andPost: boolean; warehouseId: string }) => {
      const res = await goodsNotesControllerCreate(
        goodsNoteBody({
          noteDate: newDate.format('YYYY-MM-DD'),
          warehouseId,
          noteType: newType,
          description: newDescription,
          expenseAccountId: newExpenseAccountId,
          costCenterId: newCostCenterId,
          lines: lines.map((l) => ({ itemId: l.itemId ?? '', qty: l.qty ?? '', unitCost: l.unitCost })),
        }),
      );
      const id = res.data.id;
      if (andPost) {
        await goodsNotesControllerPost(id, { headers: idemHeaders() });
      }
      return id;
    },
    onSuccess: (id) => {
      apiMessage.success(t('common.saved'));
      invalidate();
      if (id) {
        setEntryId(id);
      } else {
        backToList();
      }
    },
    onError,
  });

  const post = useMutation({
    mutationFn: (id: string) => goodsNotesControllerPost(id, { headers: idemHeaders() }),
    onSuccess: () => {
      apiMessage.success(t('common.done'));
      invalidate();
    },
    onError,
  });
  const del = useMutation({
    mutationFn: (id: string) => goodsNotesControllerDelete(id),
    onSuccess: () => {
      apiMessage.success(t('common.deleted'));
      invalidate();
      backToList();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: ReturnType<typeof goodsNoteBody> }) =>
      goodsNotesControllerUpdate(id, body),
    onSuccess: (_res, { id }) => {
      apiMessage.success(t('common.saved'));
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['goods-note', id] });
    },
    onError,
  });

  const canSave =
    !!newWarehouseId &&
    lines.some((l) => l.itemId && l.qty) &&
    (newType === 'GIN' ||
      lines.every((l) => !l.itemId || (l.qty && l.unitCost != null)));

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const saveNew = (andPost: boolean) => {
    if (create.isPending) return;
    // canSave already requires a warehouse; the explicit check narrows the id for the request.
    if (!canSave || !newWarehouseId) {
      setTried(true);
      if (!newWarehouseId) focusNamedField('warehouse');
      else apiMessage.error(t('errors.VALIDATION'));
      return;
    }
    create.mutate({ andPost, warehouseId: newWarehouseId });
  };

  // Shortcuts on an open note: Ctrl+S saves a new draft; Ctrl+Enter posts
  // (a new note is created and posted), behind a confirmation.
  const { modal } = App.useApp();
  const openDraft = screen === 'entry' && detail?.status === 'DRAFT' ? detail : null;
  const linkedDraft =
    openDraft && (openDraft.purchaseOrderId || openDraft.issueRequestId) ? openDraft : null;
  const isNewEntry = screen === 'entry' && !entryId;

  // Keep the edit form in step with the saved note (also after a save refetches it).
  useEffect(() => {
    if (!detail) return;
    setEditDate(dayjs(detail.noteDate));
    setEditDescription(detail.description ?? '');
    setEditExpenseAccountId(detail.expenseAccountId ?? undefined);
    setEditCostCenterId(detail.costCenterId ?? undefined);
    setEditQty(Object.fromEntries(detail.lines.map((l) => [l.id, l.qty])));
  }, [detail]);

  const saveLinked = () => {
    if (!linkedDraft || update.isPending) return;
    if (linkedDraft.lines.some((l) => !editQty[l.id])) {
      apiMessage.error(t('errors.VALIDATION'));
      return;
    }
    update.mutate({
      id: linkedDraft.id,
      body: goodsNoteBody(
        {
          noteType: linkedDraft.noteType,
          noteDate: editDate.format('YYYY-MM-DD'),
          warehouseId: linkedDraft.warehouseId,
          description: editDescription,
          expenseAccountId: editExpenseAccountId,
          costCenterId: editCostCenterId,
          lines: linkedDraft.lines.map((l) => ({
            itemId: l.itemId,
            qty: editQty[l.id] ?? '',
            poLineId: l.poLineId,
            issueRequestLineId: l.issueRequestLineId,
          })),
        },
        linkedDraft,
        true,
      ),
    });
  };

  useDocShortcuts({
    onSave: isNewEntry ? () => saveNew(false) : linkedDraft ? saveLinked : undefined,
    onPost:
      isNewEntry || openDraft
        ? () => {
            if (create.isPending || post.isPending) return;
            modal.confirm({
              title: t('journal.confirmPost'),
              onOk: () => (openDraft ? post.mutate(openDraft.id) : saveNew(true)),
            });
          }
        : undefined,
  });

  // ============================ LIST VIEW ============================
  if (screen === 'list') {
    return (
      <div>
        {contextHolder}
        <ListToolbar
          search={list.search}
          onSearch={list.setSearch}
          filters={
            <Select
              allowClear
              placeholder={t('goods.noteType')}
              value={typeFilter}
              onChange={setTypeFilter}
              options={NOTE_TYPES.map((vt) => ({ value: vt, label: t(TYPE_LABEL[vt]) }))}
            />
          }
          count={list.total}
          actions={
          <Dropdown.Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openNew('GRN')}
            menu={{
              items: NOTE_TYPES.map((vt) => ({
                key: vt,
                label: t(TYPE_LABEL[vt]),
              })),
              onClick: ({ key }) => openNew(key as NoteType),
            }}
          >
            {t('goods.entryVoucher')}
          </Dropdown.Button>
          }
        />
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={list.rows}
          locale={tableLocale(notesQuery)}
          size="small"
          pagination={list.pagination}
          onChange={list.onTableChange}
          onRow={(r) => ({ onClick: () => openEntry(r.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('goods.docNo'),
              dataIndex: 'docNo',
              key: 'docNo',
              sorter: true,
              sortOrder: list.sortOrderOf('docNo'),
              className: 'nowrap',
              width: 150,
              render: (v: string | null, r: GoodsNote) => v ?? `#${r.id}`,
            },
            {
              title: t('goods.noteType'),
              dataIndex: 'noteType',
              width: 130,
              render: (v: NoteType) => <TypeTag type={v} />,
            },
            {
              title: t('goods.date'),
              dataIndex: 'noteDate',
              key: 'date',
              sorter: true,
              sortOrder: list.sortOrderOf('date'),
              width: 110,
              render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
            },
            {
              title: t('stock.warehouse'),
              render: (_: unknown, r: GoodsNote) =>
                r.warehouse ? codeAndName(r.warehouse) : '—',
            },
            {
              title: t('common.description'),
              dataIndex: 'description',
              ellipsis: true,
              render: (v: string | null) => v ?? '—',
            },
            {
              title: t('common.status'),
              dataIndex: 'status',
              width: 100,
              render: (v: string) =>
                v === 'POSTED' ? (
                  <Tag color="green">{t('common.posted')}</Tag>
                ) : (
                  <Tag>{t('common.draft')}</Tag>
                ),
            },
            {
              title: t('common.actions'), key: 'actions',
              width: 200,
              render: (_: unknown, r: GoodsNote) => (
                <Space onClick={(ev) => ev.stopPropagation()}>
                  {r.status === 'DRAFT' && (
                    <>
                      <Popconfirm
                        title={t('journal.confirmPost')}
                        onConfirm={() => post.mutate(r.id)}
                      >
                        <Button size="small" type="primary">
                          {t('common.post')}
                        </Button>
                      </Popconfirm>
                      <Popconfirm
                        title={t('common.confirmDelete')}
                        onConfirm={() => del.mutate(r.id)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />} />
                      </Popconfirm>
                    </>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </div>
    );
  }

  // ============================ ENTRY VIEW ============================
  const isNew = !entryId;
  const entry = detail ?? null;

  const warehouseError = tried && !newWarehouseId ? t('common.requiredField') : undefined;

  return (
    <div>
      {contextHolder}
      <DocLayout
        title={isNew ? t(TYPE_LABEL[newType]) : entry ? t(TYPE_LABEL[entry.noteType]) : '…'}
        docNo={entry?.docNo}
        status={isNew ? 'DRAFT' : entry?.status}
        onBack={backToList}
        actions={
          isNew ? (
            <>
              <Button loading={create.isPending} onClick={() => saveNew(false)}>
                {t('journal.saveDraft')}
                <span className="doc-kbd">Ctrl+S</span>
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                loading={create.isPending}
                onClick={() => saveNew(true)}
              >
                {t('goods.createAndPost')}
                <span className="doc-kbd">Ctrl+Enter</span>
              </Button>
            </>
          ) : (
            entry && (
              <>
                {entry.status === 'DRAFT' && (
                  <>
                    {linkedDraft && (
                      <Button loading={update.isPending} onClick={saveLinked}>
                        {t('common.save')}
                        <span className="doc-kbd">Ctrl+S</span>
                      </Button>
                    )}
                    <Popconfirm
                      title={t('journal.confirmPost')}
                      onConfirm={() => post.mutate(entry.id)}
                    >
                      <Button type="primary" loading={post.isPending}>
                        {t('common.post')}
                        <span className="doc-kbd">Ctrl+Enter</span>
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title={t('common.confirmDelete')}
                      onConfirm={() => del.mutate(entry.id)}
                    >
                      <Button danger icon={<DeleteOutlined />}>
                        {t('common.delete')}
                      </Button>
                    </Popconfirm>
                  </>
                )}
                <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
                  {t('common.print')}
                </Button>
              </>
            )
          )
        }
      >
        {isNew ? (
          <DocFields>
            <DocField
              field="noteType"
              label={t('goods.noteType')}
              onKeyDown={enterTo(() => focusNamedField('date'))}
            >
              <GridSelect
                value={newType}
                onChange={setNewType}
                options={NOTE_TYPES.map((vt) => ({
                  value: vt,
                  label: t(TYPE_LABEL[vt]),
                }))}
              />
            </DocField>
            <DocField
              field="date"
              label={t('goods.date')}
              onKeyDown={enterTo(() => focusNamedField('warehouse'))}
            >
              <DatePicker value={newDate} onChange={(d) => d && setNewDate(d)} />
            </DocField>
            <DocField
              field="warehouse"
              label={t('stock.warehouse')}
              required
              error={warehouseError}
              onKeyDown={enterTo(() => focusNamedField('description'))}
            >
              <GridSelect
                status={warehouseError ? 'error' : undefined}
                options={warehouseOptions}
                value={newWarehouseId}
                onChange={setNewWarehouseId}
              />
            </DocField>
            <DocField
              field="description"
              label={t('common.description')}
              onKeyDown={enterTo(
                newType === 'GIN' ? () => focusNamedField('expenseAccount') : focusFirstGridCell,
              )}
            >
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
              />
            </DocField>
            {newType === 'GIN' && (
              <>
                <DocField
                  field="expenseAccount"
                  label={t('goods.expenseAccount')}
                  onKeyDown={enterTo(
                    costCenters.enabled ? () => focusNamedField('costCenter') : focusFirstGridCell,
                  )}
                >
                  <GridSelect
                    allowClear
                    options={expenseOptions}
                    value={newExpenseAccountId}
                    onChange={(v: string | undefined) => setNewExpenseAccountId(v ?? undefined)}
                  />
                </DocField>
                {costCenters.enabled && (
                  <DocField
                    field="costCenter"
                    label={<CostCenterLabel />}
                    onKeyDown={enterTo(focusFirstGridCell)}
                  >
                    <CostCenterSelect
                      rows={costCenters.rows}
                      value={newCostCenterId}
                      onChange={setNewCostCenterId}
                    />
                  </DocField>
                )}
              </>
            )}
          </DocFields>
        ) : linkedDraft ? (
          <DocFields>
            <DocField label={t('goods.noteType')}>
              <DocValue>
                <TypeTag type={linkedDraft.noteType} />
              </DocValue>
            </DocField>
            <DocField label={t('goods.date')}>
              <DatePicker value={editDate} onChange={(d) => d && setEditDate(d)} />
            </DocField>
            <DocField label={t('stock.warehouse')}>
              <DocValue>
                {linkedDraft.warehouse ? codeAndName(linkedDraft.warehouse) : '—'}
              </DocValue>
            </DocField>
            <DocField label={t('common.description')}>
              <Input
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                maxLength={500}
              />
            </DocField>
            {linkedDraft.noteType === 'GIN' && (
              <>
                <DocField label={t('goods.expenseAccount')}>
                  <GridSelect
                    allowClear
                    options={expenseOptions}
                    value={editExpenseAccountId}
                    onChange={(v: string | undefined) => setEditExpenseAccountId(v ?? undefined)}
                  />
                </DocField>
                {costCenters.enabled && (
                  <DocField label={<CostCenterLabel />}>
                    <CostCenterSelect
                      rows={costCenters.rows}
                      value={editCostCenterId}
                      onChange={setEditCostCenterId}
                    />
                  </DocField>
                )}
              </>
            )}
            <SourceFields entry={linkedDraft} withAccounts={false} />
          </DocFields>
        ) : (
          entry && (
            <DocFields>
              <DocField label={t('goods.noteType')}>
                <DocValue>
                  <TypeTag type={entry.noteType} />
                </DocValue>
              </DocField>
              <DocField label={t('goods.date')}>
                <DocValue>{dayjs(entry.noteDate).format('YYYY-MM-DD')}</DocValue>
              </DocField>
              <DocField label={t('stock.warehouse')}>
                <DocValue>{entry.warehouse ? codeAndName(entry.warehouse) : '—'}</DocValue>
              </DocField>
              <DocField label={t('warehouses.branch')}>
                <DocValue>{entry.branch ? codeAndName(entry.branch) : '—'}</DocValue>
              </DocField>
              <DocField label={t('common.description')}>
                <DocValue>{entry.description ?? '—'}</DocValue>
              </DocField>
              <SourceFields entry={entry} />
            </DocFields>
          )
        )}

        {isNew ? (
          <ItemLinesGrid
            lines={lines}
            onChange={setLines}
            itemOptions={itemOptions}
            onItemSearch={items.onSearch}
            showCost={newType === 'GRN'}
            showDescription
          />
        ) : linkedDraft ? (
          <>
            <Alert
              type="info"
              showIcon
              message={t('goods.linkedDraftHint')}
              style={{ marginBottom: 12 }}
            />
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={linkedDraft.lines}
              columns={[
                { title: '#', dataIndex: 'lineNo', width: 50 },
                {
                  title: t('items.title'),
                  render: (_: unknown, l: GoodsNoteLineWithItemDto) => codeAndName(l.item),
                },
                {
                  title: t('stock.qty'),
                  width: 140,
                  align: 'right' as const,
                  render: (_: unknown, l: GoodsNoteLineWithItemDto, index: number) => (
                    <InputNumber<string>
                      aria-label={cellLabel(t, t('stock.qty'), index)}
                      stringMode
                      min="0.000001"
                      placeholder={t('stock.qty')}
                      value={editQty[l.id]}
                      onChange={(v) => setEditQty((q) => ({ ...q, [l.id]: v }))}
                      style={{ width: '100%' }}
                      controls={false}
                    />
                  ),
                },
                // ADR-026 §5: an order-linked GRN takes its cost from the order; nothing to enter.
                ...(linkedDraft.purchaseOrderId
                  ? []
                  : [
                      {
                        title: t('stock.unitCost'),
                        dataIndex: 'unitCost',
                        width: 110,
                        align: 'right' as const,
                        render: unitCostCell,
                      },
                    ]),
              ]}
            />
          </>
        ) : (
          <Table
            rowKey="id"
            size="small"
            loading={detailLoading}
            pagination={false}
            dataSource={entry?.lines ?? []}
            columns={[
              { title: '#', dataIndex: 'lineNo', width: 50 },
              {
                title: t('items.title'),
                render: (_: unknown, l: GoodsNoteLineWithItemDto) =>
                  l.item ? codeAndName(l.item) : '—',
              },
              {
                title: t('stock.qty'),
                dataIndex: 'qty',
                width: 110,
                align: 'right' as const,
                render: qtyCell,
              },
              {
                title: t('stock.unitCost'),
                dataIndex: 'unitCost',
                width: 110,
                align: 'right' as const,
                render: unitCostCell,
              },
            ]}
          />
        )}
      </DocLayout>
    </div>
  );
}
