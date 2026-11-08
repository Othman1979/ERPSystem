import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import {
  Button,
  DatePicker,
  Descriptions,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMemo, useState } from 'react';
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

interface GoodsNote {
  id: string;
  docNo: string | null;
  noteDate: string;
  noteType: 'GRN' | 'GIN';
  status: 'DRAFT' | 'POSTED';
  description?: string | null;
  warehouse?: { code: string; nameAr: string };
  lines?: {
    id: string;
    lineNo: number;
    qty: string;
    unitCost?: string | null;
    item?: { code: string; nameAr: string };
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

export function GoodsNotesPage() {
  return <GoodsNotesSection />;
}

export function GoodsNotesSection() {
  const { t } = useTranslation();
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [defaultType, setDefaultType] = useState<'GRN' | 'GIN'>('GRN');
  const [viewId, setViewId] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();
  const queryClient = useQueryClient();

  const { data: notes, isLoading } = useQuery({
    queryKey: ['goods-notes', typeFilter],
    queryFn: () =>
      goodsNotesControllerList({ status: '', noteType: typeFilter ?? '' }).then(
        (r) => r.data as unknown as GoodsNote[],
      ),
  });
  const { data: view } = useQuery({
    queryKey: ['goods-note', viewId],
    queryFn: () => goodsNotesControllerGet(viewId!).then((r) => r.data as unknown as GoodsNote),
    enabled: !!viewId,
  });

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
    },
    onError,
  });

  const columns = [
    {
      title: t('goods.docNo'),
      dataIndex: 'docNo',
      width: 150,
      render: (v: string | null, r: GoodsNote) => v ?? `#${r.id}`,
    },
    {
      title: t('goods.noteType'),
      dataIndex: 'noteType',
      width: 140,
      render: (v: string) => (
        <Tag color={v === 'GRN' ? 'blue' : 'orange'}>{t(`goods.${v}`)}</Tag>
      ),
    },
    {
      title: t('goods.date'),
      dataIndex: 'noteDate',
      width: 110,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD'),
    },
    {
      title: t('stock.warehouse'),
      dataIndex: 'warehouse',
      render: (_: unknown, r: GoodsNote) =>
        r.warehouse ? `${r.warehouse.code} — ${r.warehouse.nameAr}` : '—',
    },
    { title: t('common.description'), dataIndex: 'description', ellipsis: true },
    {
      title: t('common.status'),
      dataIndex: 'status',
      width: 100,
      render: (v: string) => (
        <Tag color={v === 'POSTED' ? 'green' : 'default'}>
          {v === 'POSTED' ? t('common.posted') : t('common.draft')}
        </Tag>
      ),
    },
    {
      title: '',
      width: 220,
      render: (_: unknown, r: GoodsNote) => (
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
          placeholder={t('goods.noteType')}
          style={{ width: 180 }}
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'GRN', label: t('goods.GRN') },
            { value: 'GIN', label: t('goods.GIN') },
          ]}
        />
        <Space>
          <Button onClick={() => { setDefaultType('GIN'); setModalOpen(true); }}>
            {t('goods.exitVoucher')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => { setDefaultType('GRN'); setModalOpen(true); }}>
            {t('goods.entryVoucher')}
          </Button>
        </Space>
      </Space>
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={notes ?? []}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
      />
      <NoteModal
        open={modalOpen}
        defaultType={defaultType}
        onClose={() => setModalOpen(false)}
        onCreated={(id) => {
          setModalOpen(false);
          invalidate();
          if (id) setViewId(id);
        }}
      />
      <Modal
        open={!!viewId}
        title={view?.docNo ?? `#${viewId}`}
        onCancel={() => setViewId(null)}
        footer={null}
        width={720}
      >
        {view && (
          <>
            <Descriptions size="small" column={3} style={{ marginBottom: 12 }}>
              <Descriptions.Item label={t('goods.noteType')}>
                <Tag color={view.noteType === 'GRN' ? 'blue' : 'orange'}>
                  {t(`goods.${view.noteType}`)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('goods.date')}>
                {dayjs(view.noteDate).format('YYYY-MM-DD')}
              </Descriptions.Item>
              <Descriptions.Item label={t('stock.warehouse')}>
                {view.warehouse ? `${view.warehouse.code} — ${view.warehouse.nameAr}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                {view.status === 'POSTED' ? t('common.posted') : t('common.draft')}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.description')}>
                {view.description ?? '—'}
              </Descriptions.Item>
            </Descriptions>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={view.lines ?? []}
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
                  align: 'end' as const,
                  render: (v: string) => Number(v).toFixed(3),
                },
                {
                  title: t('stock.unitCost'),
                  dataIndex: 'unitCost',
                  width: 110,
                  align: 'end' as const,
                  render: (v?: string | null) => (v != null ? Number(v).toFixed(2) : '—'),
                },
              ]}
            />
          </>
        )}
      </Modal>
    </div>
  );
}

function NoteModal({
  open,
  defaultType,
  onClose,
  onCreated,
}: {
  open: boolean;
  defaultType: 'GRN' | 'GIN';
  onClose: () => void;
  onCreated: (id?: string) => void;
}) {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const [noteType, setNoteType] = useState<'GRN' | 'GIN'>(defaultType);
  const [noteDate, setNoteDate] = useState<Dayjs>(dayjs());
  const [warehouseId, setWarehouseId] = useState<string | undefined>();
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<ItemLineDraft[]>([emptyItemLine(1), emptyItemLine(2)]);

  const { data: items } = useQuery({
    queryKey: ['items'],
    queryFn: () => catalogControllerListItems({ search: '', itemKind: '', isActive: '' }).then((r) => r.data as unknown as Item[]),
    enabled: open,
  });
  const { data: warehouses } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
    enabled: open,
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

  const create = useMutation({
    mutationFn: async (andPost: boolean) => {
      const res = await goodsNotesControllerCreate({
        noteDate: noteDate.format('YYYY-MM-DD'),
        warehouseId,
        noteType,
        description: description || undefined,
        lines: lines
          .filter((l) => l.itemId && l.qty)
          .map((l) => ({
            itemId: l.itemId,
            qty: String(l.qty),
            unitCost: noteType === 'GRN' && l.unitCost != null ? String(l.unitCost) : undefined,
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
      onCreated(id);
    },
    onError: (err) =>
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      ),
  });

  const canSave = !!warehouseId && lines.some((l) => l.itemId && l.qty) &&
    (noteType === 'GIN' || lines.every((l) => !l.itemId || (l.qty && l.unitCost != null)));

  return (
    <Modal
      open={open}
      title={noteType === 'GRN' ? t('goods.entryVoucher') : t('goods.exitVoucher')}
      onCancel={onClose}
      width={860}
      footer={[
        <Button key="cancel" onClick={onClose}>{t('common.cancel')}</Button>,
        <Button key="draft" disabled={!canSave} loading={create.isPending && !create.variables} onClick={() => create.mutate(false)}>
          {t('common.saveDraft')}
        </Button>,
        <Button key="post" type="primary" disabled={!canSave} loading={create.isPending && !!create.variables} onClick={() => create.mutate(true)}>
          {t('goods.createAndPost')}
        </Button>,
      ]}
      destroyOnHidden
    >
      {contextHolder}
      <Space wrap style={{ marginBottom: 12 }}>
        <div>
          <Typography.Text type="secondary">{t('goods.noteType')}</Typography.Text>
          <Select
            style={{ width: 160, display: 'block' }}
            value={noteType}
            onChange={setNoteType}
            options={[
              { value: 'GRN', label: t('goods.GRN') },
              { value: 'GIN', label: t('goods.GIN') },
            ]}
          />
        </div>
        <div>
          <Typography.Text type="secondary">{t('goods.date')}</Typography.Text>
          <DatePicker style={{ display: 'block' }} value={noteDate} onChange={(d) => d && setNoteDate(d)} />
        </div>
        <div>
          <Typography.Text type="secondary">{t('stock.warehouse')} *</Typography.Text>
          <Select
            style={{ width: 220, display: 'block' }}
            options={warehouseOptions}
            value={warehouseId}
            onChange={setWarehouseId}
          />
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <Typography.Text type="secondary">{t('common.description')}</Typography.Text>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
      </Space>
      <ItemLinesGrid
        lines={lines}
        onChange={setLines}
        itemOptions={itemOptions}
        showCost={noteType === 'GRN'}
      />
    </Modal>
  );
}
