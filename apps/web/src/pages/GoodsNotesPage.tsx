import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DeleteOutlined, PlusOutlined, PrinterOutlined, SaveOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  DatePicker,
  Dropdown,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
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
  warehousesControllerList,
} from '@erp/api-client';
import { idemHeaders } from '../idempotency';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { DocField, DocFields, DocLayout, DocValue, useDocShortcuts } from '../components/DocLayout';
import { codeAndName } from '../i18n/displayName';
import { qtyCell, unitCostCell } from '../format/cells';

interface GoodsNote {
  id: string;
  docNo: string | null;
  noteDate: string;
  noteType: 'GRN' | 'GIN';
  status: 'DRAFT' | 'POSTED';
  description?: string | null;
  warehouse?: { code: string; nameAr: string } | null;
  lines?: {
    id: string;
    lineNo: number;
    qty: string;
    unitCost?: string | null;
    item?: { code: string; nameAr: string } | null;
  }[];
  journalEntry?: { entryNo: string | null } | null;
}

interface Item {
  id: string;
  code: string;
  nameAr: string;
  itemKind: string;
}
interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
}

const NOTE_TYPES = ['GRN', 'GIN'] as const;
type NoteType = (typeof NOTE_TYPES)[number];

const TYPE_LABEL: Record<NoteType, string> = {
  GRN: 'goods.entryVoucher',
  GIN: 'goods.exitVoucher',
};
const TYPE_TAG_COLOR: Record<NoteType, string> = { GRN: 'blue', GIN: 'orange' };

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
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState('');

  // ---- new-voucher form state ----
  const [newType, setNewType] = useState<NoteType>('GRN');
  const [newDate, setNewDate] = useState<Dayjs>(dayjs());
  const [newWarehouseId, setNewWarehouseId] = useState<string | undefined>();
  const [newDescription, setNewDescription] = useState('');
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1), emptyItemLine(2)]);
  // New notes start at the warehouse (required, no default); bumped by openNew.
  const [headerFocus, setHeaderFocus] = useState(0);
  useEffect(() => {
    if (!headerFocus) return;
    const id = requestAnimationFrame(() => focusNamedField('warehouse'));
    return () => cancelAnimationFrame(id);
  }, [headerFocus]);

  const { data: notes, isLoading } = useQuery({
    queryKey: ['goods-notes', typeFilter],
    queryFn: () =>
      goodsNotesControllerList({ status: '', noteType: typeFilter ?? '' }).then(
        (r) => r.data as unknown as GoodsNote[],
      ),
    enabled: screen === 'list',
  });
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['goods-note', entryId],
    queryFn: () => goodsNotesControllerGet(entryId!).then((r) => r.data as unknown as GoodsNote),
    enabled: screen === 'entry' && !!entryId,
  });

  const { data: items } = useQuery({
    queryKey: ['items'],
    queryFn: () =>
      catalogControllerListItems({ search: '', itemKind: '', isActive: '' }).then(
        (r) => r.data as unknown as Item[],
      ),
    enabled: screen === 'entry' && !entryId,
  });
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
    enabled: screen === 'entry' && !entryId,
  });

  const itemOptions = useMemo(
    () =>
      (items ?? [])
        .filter((i) => i.itemKind === 'STOCK')
        .map((i) => ({ value: i.id, label: codeAndName(i) })),
    [items],
  );
  const warehouseOptions = (warehouses ?? []).map((w) => ({
    value: w.id,
    label: codeAndName(w),
  }));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['goods-notes'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };
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
    mutationFn: async (andPost: boolean) => {
      const res = await goodsNotesControllerCreate({
        noteDate: newDate.format('YYYY-MM-DD'),
        warehouseId: newWarehouseId,
        noteType: newType,
        description: newDescription || undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitCost:
              newType === 'GRN' && l.unitCost != null ? String(l.unitCost) : undefined,
          })),
      } as never);
      const id = (res as { data?: { id: string } }).data?.id;
      if (andPost && id) {
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

  const canSave =
    !!newWarehouseId &&
    lines.some((l) => l.itemId && l.qty) &&
    (newType === 'GIN' ||
      lines.every((l) => !l.itemId || (l.qty && l.unitCost != null)));

  // Save stays enabled: a save attempt with gaps marks the missing fields instead.
  const [tried, setTried] = useState(false);
  const saveNew = (andPost: boolean) => {
    if (create.isPending) return;
    if (!canSave) {
      setTried(true);
      if (!newWarehouseId) focusNamedField('warehouse');
      else apiMessage.error(t('errors.VALIDATION'));
      return;
    }
    create.mutate(andPost);
  };

  // Shortcuts on an open note: Ctrl+S saves a new draft; Ctrl+Enter posts
  // (a new note is created and posted), behind a confirmation.
  const { modal } = App.useApp();
  const openDraft = screen === 'entry' && detail?.status === 'DRAFT' ? detail : null;
  const isNewEntry = screen === 'entry' && !entryId;
  useDocShortcuts({
    onSave: isNewEntry ? () => saveNew(false) : undefined,
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
    const shown = (notes ?? []).filter((r) =>
      matchesSearch(search, r.docNo, r.warehouse ? codeAndName(r.warehouse) : null, r.description),
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
              placeholder={t('goods.noteType')}
              value={typeFilter}
              onChange={setTypeFilter}
              options={NOTE_TYPES.map((vt) => ({ value: vt, label: t(TYPE_LABEL[vt]) }))}
            />
          }
          count={shown.length}
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
          dataSource={shown}
          size="small"
          pagination={{ pageSize: 20 }}
          onRow={(r) => ({ onClick: () => openEntry(r.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('goods.docNo'),
              dataIndex: 'docNo',
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
              title: '',
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
                enterOpens
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
                enterOpens
                status={warehouseError ? 'error' : undefined}
                options={warehouseOptions}
                value={newWarehouseId}
                onChange={setNewWarehouseId}
              />
            </DocField>
            <DocField
              field="description"
              label={t('common.description')}
              onKeyDown={enterTo(focusFirstGridCell)}
            >
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
              />
            </DocField>
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
              <DocField label={t('common.description')}>
                <DocValue>{entry.description ?? '—'}</DocValue>
              </DocField>
            </DocFields>
          )
        )}

        {isNew ? (
          <ItemLinesGrid
            lines={lines}
            onChange={setLines}
            itemOptions={itemOptions}
            showCost={newType === 'GRN'}
            showDescription
          />
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
                render: (_: unknown, l: NonNullable<GoodsNote['lines']>[number]) =>
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
