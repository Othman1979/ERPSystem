import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Form, Input, Select, Space, Table, Tag, message } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  branchesControllerList,
  warehousesControllerCreate,
  warehousesControllerList,
  warehousesControllerUpdate,
} from '@erp/api-client';
import { ContainerOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { codeAndName, displayName } from '../i18n/displayName';

interface Warehouse {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  address: string | null;
  isActive: boolean;
  branch?: { id: string; code: string; nameAr: string } | null;
}
interface Branch {
  id: string;
  code: string;
  nameAr: string;
}

export function WarehousesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm();

  const { data: warehouses, isLoading } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => warehousesControllerList().then((r) => r.data as unknown as Warehouse[]),
  });
  const { data: branches } = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesControllerList().then((r) => r.data as unknown as Branch[]),
  });

  const showError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['warehouses'] });

  const save = useMutation({
    mutationFn: async (v: {
      code?: string;
      nameAr: string;
      nameEn?: string;
      branchId?: string;
      address?: string;
    }): Promise<unknown> => {
      const payload = {
        nameAr: v.nameAr,
        nameEn: v.nameEn || null,
        branchId: v.branchId || null,
        address: v.address || null,
      };
      return editing
        ? warehousesControllerUpdate(editing.id, payload as never)
        : warehousesControllerCreate({ code: v.code!, ...payload } as never);
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      invalidate();
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
    },
    onError: showError,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => warehousesControllerUpdate(id, { isActive: false } as never),
    onSuccess: invalidate,
    onError: showError,
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };
  const openEdit = (row: Warehouse) => {
    setEditing(row);
    form.setFieldsValue({
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      branchId: row.branch?.id,
      address: row.address,
    });
    setModalOpen(true);
  };

  const shown = (warehouses ?? []).filter((w) => matchesSearch(search, w.code, displayName(w)));

  return (
    <div>
      <PageHeader title={t('warehouses.title')} />
      <Card>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('warehouses.add')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={shown}
        pagination={false}
        columns={[
          { title: t('warehouses.code'), dataIndex: 'code', width: 110 },
          { title: t('common.name'), key: 'name', render: (_: unknown, r: Warehouse) => displayName(r) },
          { title: t('warehouses.nameEn'), dataIndex: 'nameEn', render: (v: string | null) => v ?? '—' },
          {
            title: t('warehouses.branch'),
            width: 150,
            render: (_: unknown, r: Warehouse) => displayName(r.branch) ?? '—',
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
            render: (_: unknown, row: Warehouse) => (
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
      <FormDialog
        title={editing ? t('warehouses.edit') : t('warehouses.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('warehouses.details')} icon={<ContainerOutlined />}>
            {!editing && (
              <Form.Item name="code" label={t('warehouses.code')} rules={[{ required: true }]}>
                <Input maxLength={50} />
              </Form.Item>
            )}
            <Form.Item name="nameAr" label={t('warehouses.nameAr')} rules={[{ required: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('warehouses.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="branchId" label={t('warehouses.branch')}>
              <Select
                allowClear
                options={(branches ?? []).map((b) => ({ value: b.id, label: codeAndName(b) }))}
              />
            </Form.Item>
            <Form.Item name="address" label={t('warehouses.address')} className="span-all">
              <Input.TextArea maxLength={512} rows={2} />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
      </Card>
    </div>
  );
}
