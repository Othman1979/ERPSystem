import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  catalogControllerCreateGroup,
  catalogControllerCreateItem,
  catalogControllerListGroups,
  catalogControllerListItems,
  catalogControllerUpdateGroup,
  catalogControllerUpdateItem,
  settingsControllerListUnits,
} from '@erp/api-client';

interface Unit {
  id: string;
  code: string;
  nameAr: string;
}
interface Group {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: string | null;
  isActive: boolean;
}
interface Item {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  itemKind: 'STOCK' | 'SERVICE';
  baseUnit?: { code: string; nameAr: string } | null;
  itemGroup?: { id: string; code: string; nameAr: string } | null;
  salePrice: string | null;
  purchasePrice: string | null;
  isActive: boolean;
}

function useApiError() {
  const { t } = useTranslation();
  const [apiMessage, contextHolder] = message.useMessage();
  const show = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  return { apiMessage, contextHolder, show };
}

function ItemsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show } = useApiError();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<string | undefined>();
  const [form] = Form.useForm();

  const { data: items, isLoading } = useQuery({
    queryKey: ['items', search, kindFilter],
    queryFn: () =>
      catalogControllerListItems({
        search: search,
        itemKind: kindFilter ?? '',
        isActive: '',
      }).then((r) => r.data as unknown as Item[]),
  });
  const { data: units } = useQuery({
    queryKey: ['units'],
    queryFn: () => settingsControllerListUnits().then((r) => r.data as unknown as Unit[]),
  });
  const { data: groups } = useQuery({
    queryKey: ['item-groups'],
    queryFn: () => catalogControllerListGroups().then((r) => r.data as unknown as Group[]),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['items'] });

  const save = useMutation({
    mutationFn: async (v: Record<string, unknown>): Promise<unknown> => {
      const payload = {
        ...v,
        salePrice: v.salePrice != null ? String(v.salePrice) : undefined,
        purchasePrice: v.purchasePrice != null ? String(v.purchasePrice) : undefined,
        minStock: v.minStock != null ? String(v.minStock) : undefined,
        itemGroupId: v.itemGroupId || undefined,
        nameEn: v.nameEn || undefined,
      };
      return editing
        ? catalogControllerUpdateItem(editing.id, payload as never)
        : catalogControllerCreateItem(payload as never);
    },
    onSuccess: () => {
      invalidate();
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: show,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => catalogControllerUpdateItem(id, { isActive: false } as never),
    onSuccess: invalidate,
    onError: show,
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };
  const openEdit = (row: Item) => {
    setEditing(row);
    form.setFieldsValue({
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      itemKind: row.itemKind,
      baseUnitId: undefined,
      itemGroupId: row.itemGroup?.id ?? undefined,
      salePrice: row.salePrice ? Number(row.salePrice) : undefined,
      purchasePrice: row.purchasePrice ? Number(row.purchasePrice) : undefined,
    });
    setModalOpen(true);
  };

  return (
    <Card
      size="small"
      title={t('items.title')}
      extra={
        <Space>
          <Input.Search
            allowClear
            placeholder={t('items.search')}
            style={{ width: 220 }}
            onSearch={setSearch}
          />
          <Select
            allowClear
            placeholder={t('items.kind')}
            style={{ width: 140 }}
            onChange={setKindFilter}
            options={[
              { value: 'STOCK', label: t('items.stock') },
              { value: 'SERVICE', label: t('items.service') },
            ]}
          />
          <Button type="primary" onClick={openCreate}>
            {t('items.add')}
          </Button>
        </Space>
      }
    >
      {contextHolder}
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={items ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('items.nameAr'), dataIndex: 'nameAr' },
          {
            title: t('items.kind'),
            dataIndex: 'itemKind',
            width: 100,
            render: (v: string) =>
              v === 'STOCK' ? (
                <Tag color="blue">{t('items.stock')}</Tag>
              ) : (
                <Tag>{t('items.service')}</Tag>
              ),
          },
          {
            title: t('items.unit'),
            width: 90,
            render: (_: unknown, r: Item) => r.baseUnit?.code ?? '—',
          },
          {
            title: t('items.salePrice'),
            dataIndex: 'salePrice',
            width: 100,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('items.purchasePrice'),
            dataIndex: 'purchasePrice',
            width: 110,
            render: (v: string | null) => v ?? '—',
          },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>,
          },
          {
            title: t('common.actions'),
            width: 140,
            render: (_: unknown, row: Item) => (
              <Space>
                <Button size="small" onClick={() => openEdit(row)}>
                  {t('common.edit')}
                </Button>
                {row.isActive && (
                  <Button size="small" danger onClick={() => deactivate.mutate(row.id)}>
                    {t('common.deactivate')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? t('items.edit') : t('items.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        width={560}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          <Space style={{ display: 'flex' }}>
            <Form.Item
              name="code"
              label={t('items.code')}
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <Input maxLength={50} disabled={!!editing} />
            </Form.Item>
            <Form.Item name="itemKind" label={t('items.kind')} initialValue="STOCK" style={{ width: 140 }}>
              <Select
                disabled={!!editing}
                options={[
                  { value: 'STOCK', label: t('items.stock') },
                  { value: 'SERVICE', label: t('items.service') },
                ]}
              />
            </Form.Item>
          </Space>
          <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('items.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          <Space style={{ display: 'flex' }}>
            <Form.Item
              name="baseUnitId"
              label={t('items.baseUnit')}
              rules={[{ required: true }]}
              style={{ flex: 1 }}
            >
              <Select
                showSearch
                optionFilterProp="label"
                disabled={!!editing}
                options={(units ?? [])
                  .filter((u) => u.id)
                  .map((u) => ({ value: u.id, label: `${u.code} — ${u.nameAr}` }))}
              />
            </Form.Item>
            <Form.Item name="itemGroupId" label={t('items.group')} style={{ flex: 1 }}>
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                options={(groups ?? [])
                  .filter((g) => g.isActive)
                  .map((g) => ({ value: g.id, label: `${g.code} — ${g.nameAr}` }))}
              />
            </Form.Item>
          </Space>
          <Space style={{ display: 'flex' }}>
            <Form.Item name="salePrice" label={t('items.salePrice')} style={{ flex: 1 }}>
              <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="purchasePrice" label={t('items.purchasePrice')} style={{ flex: 1 }}>
              <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="minStock" label={t('items.minStock')} style={{ flex: 1 }}>
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}

function GroupsTab() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { contextHolder, show } = useApiError();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Group | null>(null);
  const [form] = Form.useForm();

  const { data: groups, isLoading } = useQuery({
    queryKey: ['item-groups'],
    queryFn: () => catalogControllerListGroups().then((r) => r.data as unknown as Group[]),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['item-groups'] });

  const save = useMutation({
    mutationFn: async (v: {
      code?: string;
      nameAr: string;
      nameEn?: string;
      parentId?: string;
    }): Promise<unknown> =>
      editing
        ? catalogControllerUpdateGroup(editing.id, {
            nameAr: v.nameAr,
            nameEn: v.nameEn || null,
          } as never)
        : catalogControllerCreateGroup({
            code: v.code!,
            nameAr: v.nameAr,
            nameEn: v.nameEn || undefined,
            parentId: v.parentId || undefined,
          } as never),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['items'] });
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: show,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => catalogControllerUpdateGroup(id, { isActive: false } as never),
    onSuccess: invalidate,
    onError: show,
  });

  const parentName = (id: string | null) =>
    id ? (groups ?? []).find((g) => g.id === id)?.nameAr ?? id : '—';

  return (
    <Card
      size="small"
      title={t('items.groups')}
      extra={
        <Button
          type="primary"
          size="small"
          onClick={() => {
            setEditing(null);
            form.resetFields();
            setModalOpen(true);
          }}
        >
          {t('items.addGroup')}
        </Button>
      }
    >
      {contextHolder}
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={groups ?? []}
        pagination={false}
        columns={[
          { title: t('items.code'), dataIndex: 'code', width: 110 },
          { title: t('items.nameAr'), dataIndex: 'nameAr' },
          { title: t('items.nameEn'), dataIndex: 'nameEn', render: (v: string | null) => v ?? '—' },
          {
            title: t('items.parent'),
            dataIndex: 'parentId',
            width: 160,
            render: (v: string | null) => parentName(v),
          },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            width: 90,
            render: (v: boolean) =>
              v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>,
          },
          {
            title: t('common.actions'),
            width: 140,
            render: (_: unknown, row: Group) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    form.setFieldsValue({
                      nameAr: row.nameAr,
                      nameEn: row.nameEn,
                      parentId: row.parentId ?? undefined,
                    });
                    setModalOpen(true);
                  }}
                >
                  {t('common.edit')}
                </Button>
                {row.isActive && (
                  <Button size="small" danger onClick={() => deactivate.mutate(row.id)}>
                    {t('common.deactivate')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? t('items.editGroup') : t('items.addGroup')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          {!editing && (
            <Form.Item name="code" label={t('items.code')} rules={[{ required: true }]}>
              <Input maxLength={50} />
            </Form.Item>
          )}
          <Form.Item name="nameAr" label={t('items.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('items.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          {!editing && (
            <Form.Item name="parentId" label={t('items.parent')}>
              <Select
                allowClear
                options={(groups ?? [])
                  .filter((g) => g.isActive)
                  .map((g) => ({ value: g.id, label: `${g.code} — ${g.nameAr}` }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </Card>
  );
}

export function ItemsPage() {
  const { t } = useTranslation();
  return (
    <Card title={t('items.title')}>
      <Tabs
        items={[
          { key: 'items', label: t('items.items'), children: <ItemsTab /> },
          { key: 'groups', label: t('items.groups'), children: <GroupsTab /> },
        ]}
      />
    </Card>
  );
}
