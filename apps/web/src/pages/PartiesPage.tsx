import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  partiesControllerCreate,
  partiesControllerDeactivate,
  partiesControllerList,
  partiesControllerUpdate,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';
import { displayName, type Named } from '../i18n/displayName';
import { amountCell } from '../format/cells';

interface Party {
  id: string;
  code: string;
  nameAr: string;
  nameEn?: string | null;
  partyType: 'CUSTOMER' | 'SUPPLIER' | 'BOTH';
  taxNumber?: string | null;
  phone?: string | null;
  creditLimit?: string | null;
  paymentTermsDays?: number | null;
  isCashCustomer?: boolean;
  isActive: boolean;
}

const TYPE_COLORS: Record<string, string> = {
  CUSTOMER: 'blue',
  SUPPLIER: 'orange',
  BOTH: 'green',
};

export function PartiesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Party | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const { data: parties, isLoading } = useQuery({
    queryKey: ['parties', typeFilter],
    queryFn: () =>
      partiesControllerList({ partyType: typeFilter ?? '', isActive: '' }).then(
        (r) => r.data as unknown as Party[],
      ),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['parties'] });
  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ partyType: 'CUSTOMER', isCashCustomer: false, isActive: true });
    setModalOpen(true);
  };

  const openEdit = (p: Party) => {
    setEditing(p);
    form.setFieldsValue({
      nameAr: p.nameAr,
      nameEn: p.nameEn ?? undefined,
      partyType: p.partyType,
      taxNumber: p.taxNumber ?? undefined,
      phone: p.phone ?? undefined,
      creditLimit: p.creditLimit ?? undefined,
      paymentTermsDays: p.paymentTermsDays ?? undefined,
      isCashCustomer: p.isCashCustomer,
      isActive: p.isActive,
    });
    setModalOpen(true);
  };

  const save = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const payload = {
        nameAr: values.nameAr,
        nameEn: values.nameEn,
        partyType: values.partyType,
        taxNumber: values.taxNumber,
        phone: values.phone,
        creditLimit: values.creditLimit ?? undefined,
        paymentTermsDays: values.paymentTermsDays,
        isCashCustomer: values.isCashCustomer,
        isActive: values.isActive,
      };
      const res = editing
        ? await partiesControllerUpdate(editing.id, payload as never)
        : await partiesControllerCreate({ code: values.code, ...payload } as never);
      return res as never;
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      invalidate();
    },
    onError,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => partiesControllerDeactivate(id),
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      invalidate();
    },
    onError,
  });

  const columns = [
    { title: t('parties.code'), dataIndex: 'code', width: 110 },
    { title: t('common.name'), key: 'name', render: (_: unknown, r: Named) => displayName(r) },
    {
      title: t('parties.type'),
      dataIndex: 'partyType',
      width: 120,
      render: (v: string) => <Tag color={TYPE_COLORS[v]}>{t(`parties.type_${v}`)}</Tag>,
    },
    { title: t('parties.taxNumber'), dataIndex: 'taxNumber', width: 140, render: (v?: string | null) => v ?? '—' },
    { title: t('parties.phone'), dataIndex: 'phone', width: 130, render: (v?: string | null) => v ?? '—' },
    {
      title: t('parties.creditLimit'),
      dataIndex: 'creditLimit',
      width: 120,
      align: 'right' as const,
      render: amountCell,
    },
    {
      title: t('common.status'),
      dataIndex: 'isActive',
      width: 100,
      render: (v: boolean) => <Tag color={v ? 'green' : 'default'}>{v ? t('common.active') : t('common.inactive')}</Tag>,
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, p: Party) => (
        <Space>
          <Button size="small" onClick={() => openEdit(p)}>{t('common.edit')}</Button>
          {p.isActive && (
            <Popconfirm
              title={t('parties.deactivateConfirm')}
              onConfirm={() => deactivate.mutate(p.id)}
            >
              <Button size="small" danger>{t('common.deactivate')}</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      {contextHolder}
      <PageHeader title={t('nav.parties')} />
      <Space style={{ marginBottom: 12, justifyContent: 'space-between', width: '100%' }}>
        <Select
          allowClear
          placeholder={t('parties.type')}
          style={{ width: 180 }}
          value={typeFilter}
          onChange={setTypeFilter}
          options={[
            { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
            { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
            { value: 'BOTH', label: t('parties.type_BOTH') },
          ]}
        />
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          {t('parties.new')}
        </Button>
      </Space>

      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={parties ?? []}
        columns={columns}
        size="small"
        pagination={{ pageSize: 20 }}
      />

      <Modal
        open={modalOpen}
        title={editing ? t('parties.edit') : t('parties.new')}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          {!editing && (
            <Form.Item name="code" label={t('parties.code')} rules={[{ required: true }]}>
              <Input maxLength={50} />
            </Form.Item>
          )}
          <Form.Item name="nameAr" label={t('parties.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('parties.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="partyType" label={t('parties.type')} rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'CUSTOMER', label: t('parties.type_CUSTOMER') },
                { value: 'SUPPLIER', label: t('parties.type_SUPPLIER') },
                { value: 'BOTH', label: t('parties.type_BOTH') },
              ]}
            />
          </Form.Item>
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="taxNumber" label={t('parties.taxNumber')} style={{ flex: 1 }}>
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="phone" label={t('parties.phone')} style={{ flex: 1 }}>
              <Input maxLength={50} />
            </Form.Item>
          </Space>
          <Space size="middle" style={{ display: 'flex' }}>
            <Form.Item name="creditLimit" label={t('parties.creditLimit')} style={{ flex: 1 }}>
              <InputNumber<string> stringMode min="0" style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="paymentTermsDays" label={t('parties.paymentTerms')} style={{ flex: 1 }}>
              <InputNumber min={0} max={3650} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space size="large">
            <Form.Item name="isCashCustomer" label={t('parties.isCashCustomer')} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item name="isActive" label={t('common.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
