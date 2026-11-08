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
  DatePicker,
  Dropdown,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
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
import i18n from '../i18n';
import { idemHeaders } from '../idempotency';
import {
  enterTo,
  focusFirstGridCell,
  focusNamedField,
  GridSelect,
} from '../components/GridSelect';

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
  return <GoodsNotesSection />;
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

  // ---- new-voucher form state ----
  const [newType, setNewType] = useState<NoteType>('GRN');
  const [newDate, setNewDate] = useState<Dayjs>(dayjs());
  const [newWarehouseId, setNewWarehouseId] = useState<string | undefined>();
  const [newDescription, setNewDescription] = useState('');
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1), emptyItemLine(2)]);
  const [gridFocus, setGridFocus] = useState(0);

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
        .map((i) => ({ value: i.id, label: `${i.code} — ${i.nameAr}` })),
    [items],
  );
  const warehouseOptions = (warehouses ?? []).map((w) => ({
    value: w.id,
    label: `${w.code} — ${w.nameAr}`,
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
    setGridFocus((g) => g + 1);
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
        await goodsNotesControllerPost(id, idemHeaders());
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
    mutationFn: (id: string) => goodsNotesControllerPost(id, idemHeaders()),
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

  const saveNew = (andPost: boolean) => {
    if (!canSave) {
      apiMessage.error(t('errors.VALIDATION'));
      return;
    }
    create.mutate(andPost);
  };

  // ============================ LIST VIEW ============================
  if (screen === 'list') {
    return (
      <div>
        {contextHolder}
        <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
          <Select
            allowClear
            placeholder={t('goods.noteType')}
            style={{ width: 180 }}
            value={typeFilter}
            onChange={setTypeFilter}
            options={NOTE_TYPES.map((vt) => ({ value: vt, label: t(TYPE_LABEL[vt]) }))}
          />
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
        </Space>
        <Table
          rowKey="id"
          loading={isLoading}
          dataSource={notes ?? []}
          size="small"
          pagination={{ pageSize: 20 }}
          onRow={(r) => ({ onClick: () => openEntry(r.id), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: t('goods.docNo'),
              dataIndex: 'docNo',
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
                r.warehouse ? `${r.warehouse.code} — ${r.warehouse.nameAr}` : '—',
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

  return (
    <div>
      {contextHolder}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <Button
          icon={i18n.language === 'ar' ? <ArrowRightOutlined /> : <ArrowLeftOutlined />}
          onClick={backToList}
        >
          {t('nav.goodsNotes')}
        </Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          {isNew
            ? t(TYPE_LABEL[newType])
            : `${entry?.docNo ?? '…'} — ${entry ? t(TYPE_LABEL[entry.noteType]) : ''}`}
        </Typography.Title>
        {entry && (
          <Space size={4}>
            <TypeTag type={entry.noteType} />
            {entry.status === 'POSTED' ? (
              <Tag color="green">{t('common.posted')}</Tag>
            ) : (
              <Tag>{t('common.draft')}</Tag>
            )}
          </Space>
        )}
        <div style={{ flex: 1 }} />
        <Space>
          {isNew ? (
            <>
              <Button
                disabled={!canSave}
                loading={create.isPending}
                onClick={() => saveNew(false)}
              >
                {t('journal.saveDraft')}
              </Button>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                disabled={!canSave}
                loading={create.isPending}
                onClick={() => saveNew(true)}
              >
                {t('goods.createAndPost')}
              </Button>
            </>
          ) : (
            entry?.status === 'DRAFT' && (
              <>
                <Popconfirm
                  title={t('journal.confirmPost')}
                  onConfirm={() => post.mutate(entry.id)}
                >
                  <Button type="primary" loading={post.isPending}>
                    {t('common.post')}
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
            )
          )}
        </Space>
      </div>

      {/* Header fields */}
      <div
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          marginBottom: 16,
          alignItems: 'flex-end',
        }}
      >
        {isNew ? (
          <>
            <div data-field="noteType" onKeyDown={enterTo(() => focusNamedField('date'))}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('goods.noteType')}
              </Typography.Text>
              <GridSelect
                enterOpens
                value={newType}
                onChange={setNewType}
                options={NOTE_TYPES.map((vt) => ({
                  value: vt,
                  label: t(TYPE_LABEL[vt]),
                }))}
                style={{ width: 180 }}
              />
            </div>
            <div data-field="date" onKeyDown={enterTo(() => focusNamedField('warehouse'))}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('goods.date')}
              </Typography.Text>
              <DatePicker value={newDate} onChange={(d) => d && setNewDate(d)} />
            </div>
            <div data-field="warehouse" onKeyDown={enterTo(() => focusNamedField('description'))}>
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('stock.warehouse')} *
              </Typography.Text>
              <GridSelect
                enterOpens
                options={warehouseOptions}
                value={newWarehouseId}
                onChange={setNewWarehouseId}
                style={{ width: 220 }}
              />
            </div>
            <div
              data-field="description"
              style={{ flex: 1, minWidth: 220 }}
              onKeyDown={enterTo(focusFirstGridCell)}
            >
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                {t('common.description')}
              </Typography.Text>
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                maxLength={500}
              />
            </div>
          </>
        ) : (
          entry && (
            <Space size={24} wrap>
              <span>
                <Typography.Text type="secondary">{t('goods.date')}: </Typography.Text>
                {dayjs(entry.noteDate).format('YYYY-MM-DD')}
              </span>
              <span>
                <Typography.Text type="secondary">{t('stock.warehouse')}: </Typography.Text>
                {entry.warehouse ? `${entry.warehouse.code} — ${entry.warehouse.nameAr}` : '—'}
              </span>
              <span>
                <Typography.Text type="secondary">{t('common.description')}: </Typography.Text>
                {entry.description ?? '—'}
              </span>
            </Space>
          )
        )}
      </div>

      {/* Lines */}
      <div
        style={{
          background: '#fff',
          border: '1px solid #f0f0f0',
          borderRadius: 8,
          padding: '12px 16px',
        }}
      >
        <Typography.Title level={5} style={{ marginTop: 0 }}>
          {t('journal.linesTitle')}
        </Typography.Title>
        {isNew ? (
          <ItemLinesGrid
            lines={lines}
            onChange={setLines}
            itemOptions={itemOptions}
            showCost={newType === 'GRN'}
            showDescription
            focusSignal={gridFocus}
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
                  l.item ? `${l.item.code} — ${l.item.nameAr}` : '—',
              },
              {
                title: t('stock.qty'),
                dataIndex: 'qty',
                width: 110,
                align: 'right' as const,
                render: (v: string) => Number(v).toFixed(3),
              },
              {
                title: t('stock.unitCost'),
                dataIndex: 'unitCost',
                width: 110,
                align: 'right' as const,
                render: (v?: string | null) => (v != null ? Number(v).toFixed(2) : '—'),
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}
