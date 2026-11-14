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
  type BranchDto,
} from '@erp/api-client';
import { ShopOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';
import { displayName } from '../i18n/displayName';
import { branchCreateBody, branchUpdateBody, type BranchFormValues } from './branches/branchPayload';

type Branch = BranchDto;

export function BranchesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const branchesQuery = useQuery({
    queryKey: ['branches'],
    queryFn: ({ signal }) => branchesControllerList({ signal }).then((r) => r.data),
  });
  const { data, isLoading } = branchesQuery;

  const save = useMutation({
    mutationFn: async (values: BranchFormValues) => {
      if (editing) {
        return branchesControllerUpdate(editing.id, branchUpdateBody(values));
      }
      return branchesControllerCreate(branchCreateBody(values));
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

  const shown = (data ?? []).filter((b) => matchesSearch(search, b.code, displayName(b)));

  return (
    <div>
      <PageHeader title={t('branches.title')} />
      <Card>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('branches.add')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(branchesQuery)}
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
