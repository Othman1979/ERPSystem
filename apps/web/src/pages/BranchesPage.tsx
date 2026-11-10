import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  branchesControllerCreate,
  branchesControllerDeactivate,
  branchesControllerList,
  branchesControllerUpdate,
} from '@erp/api-client';
import { ShopOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { displayName } from '../i18n/displayName';

interface Branch {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  address: string | null;
  isActive: boolean;
  companyId: string;
}

export function BranchesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const { data, isLoading } = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesControllerList().then((r) => r.data as unknown as Branch[]),
  });

  const save = useMutation({
    mutationFn: async (values: { code?: string; nameAr: string; nameEn?: string; address?: string }) => {
      if (editing) {
        return branchesControllerUpdate(editing.id, {
          nameAr: values.nameAr,
          nameEn: values.nameEn || undefined,
          address: values.address || undefined,
        });
      }
      return branchesControllerCreate({
        code: values.code!,
        nameAr: values.nameAr,
        nameEn: values.nameEn || undefined,
        address: values.address || undefined,
      });
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['branches'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError ? t(`errors.${err.code}`, { defaultValue: err.message }) : t('errors.INTERNAL'),
      );
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => branchesControllerDeactivate(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['branches'] }),
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (b: Branch) => {
    setEditing(b);
    form.setFieldsValue({ nameAr: b.nameAr, nameEn: b.nameEn, address: b.address });
    setModalOpen(true);
  };

  return (
    <div>
      <PageHeader
        title={t('branches.title')}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('branches.add')}
          </Button>
        }
      />
      <Card>
      {contextHolder}
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          { title: t('branches.code'), dataIndex: 'code' },
          { title: t('common.name'), key: 'name', render: (_: unknown, r: Branch) => displayName(r) },
          { title: t('branches.nameEn'), dataIndex: 'nameEn' },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            render: (v: boolean) =>
              v ? <Tag color="green">{t('common.active')}</Tag> : <Tag>{t('common.inactive')}</Tag>,
          },
          {
            title: t('common.actions'),
            render: (_: unknown, b: Branch) => (
              <Space>
                <Button size="small" onClick={() => openEdit(b)}>
                  {t('common.edit')}
                </Button>
                {b.isActive && (
                  <Popconfirm title={t('common.confirmDeactivate')} onConfirm={() => deactivate.mutate(b.id)}>
<Button size="small" danger >
                    {t('common.deactivate')}
                  </Button>
</Popconfirm>
                )}
              </Space>
            ),
          },
        ]}
      />
      <FormDialog
        title={editing ? t('branches.edit') : t('branches.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <FormSection title={t('branches.details')} icon={<ShopOutlined />}>
            {!editing && (
              <Form.Item name="code" label={t('branches.code')} rules={[{ required: true }]}>
                <Input maxLength={50} />
              </Form.Item>
            )}
            <Form.Item name="nameAr" label={t('branches.nameAr')} rules={[{ required: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('branches.nameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="address" label={t('branches.address')} className="span-all">
              <Input maxLength={512} />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
      <Typography.Text type="secondary">{t('branches.planHint')}</Typography.Text>
      </Card>
    </div>
  );
}
