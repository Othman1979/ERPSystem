import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
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
  usersControllerInvite,
  usersControllerList,
  usersControllerRoles,
  usersControllerSuspend,
  usersControllerUpdate,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';

interface Membership {
  membershipId: string;
  status: string;
  user: { id: string; email: string; fullName: string; isActive: boolean };
  role: { code: string; nameAr: string; nameEn: string | null };
  defaultBranch: { id: string; code: string; nameAr: string } | null;
  branches: { id: string; code: string; nameAr: string }[];
  temporaryPassword?: string;
}

interface Role {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'green',
  INVITED: 'orange',
  SUSPENDED: 'red',
};

export function UsersPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm] = Form.useForm();
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [apiMessage, contextHolder] = message.useMessage();

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersControllerList().then((r) => r.data as unknown as Membership[]),
  });

  const { data: roles } = useQuery({
    queryKey: ['roles'],
    queryFn: () => usersControllerRoles().then((r) => r.data as unknown as Role[]),
  });

  const onError = (err: unknown) => {
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  };

  const invite = useMutation({
    mutationFn: (values: { email: string; fullName?: string; roleCode: string; password?: string }) =>
      usersControllerInvite({
        email: values.email,
        fullName: values.fullName || undefined,
        roleCode: values.roleCode,
        password: values.password || undefined,
      }),
    onSuccess: (res) => {
      const body = res.data as unknown as Membership;
      if (body.temporaryPassword) {
        setTempPassword(body.temporaryPassword);
      } else {
        apiMessage.success(t('users.invited'));
        setInviteOpen(false);
        inviteForm.resetFields();
      }
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
    onError,
  });

  const changeRole = useMutation({
    mutationFn: ({ id, roleCode }: { id: string; roleCode: string }) =>
      usersControllerUpdate(id, { roleCode }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError,
  });

  const suspend = useMutation({
    mutationFn: (id: string) => usersControllerSuspend(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['users'] }),
    onError,
  });

  const roleName = (_code: string, ar: string, en: string | null) =>
    i18n.language === 'ar' ? ar : (en ?? ar);

  return (
    <div>
      <PageHeader
        title={t('users.title')}
        actions={
          <Button type="primary" onClick={() => setInviteOpen(true)}>
            {t('users.invite')}
          </Button>
        }
      />
      <Card>
      {contextHolder}
      <Table
        rowKey="membershipId"
        loading={isLoading}
        dataSource={data ?? []}
        pagination={false}
        columns={[
          { title: t('users.name'), render: (_: unknown, m: Membership) => m.user.fullName },
          { title: t('users.email'), render: (_: unknown, m: Membership) => m.user.email },
          {
            title: t('users.role'),
            render: (_: unknown, m: Membership) =>
              roleName(m.role.code, m.role.nameAr, m.role.nameEn),
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (s: string) => <Tag color={STATUS_COLORS[s]}>{t(`users.status.${s}`)}</Tag>,
          },
          {
            title: t('users.actions'),
            render: (_: unknown, m: Membership) => (
              <Space>
                <Select
                  size="small"
                  style={{ width: 140 }}
                  value={m.role.code}
                  onChange={(roleCode) => changeRole.mutate({ id: m.membershipId, roleCode })}
                  options={(roles ?? []).map((r) => ({
                    value: r.code,
                    label: roleName(r.code, r.nameAr, r.nameEn),
                  }))}
                />
                {m.status === 'ACTIVE' && (
                  <Button
                    size="small"
                    danger
                    onClick={() => suspend.mutate(m.membershipId)}
                  >
                    {t('users.suspend')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title={t('users.invite')}
        open={inviteOpen && !tempPassword}
        onCancel={() => setInviteOpen(false)}
        onOk={() => inviteForm.submit()}
        confirmLoading={invite.isPending}
      >
        <Form
          form={inviteForm}
          layout="vertical"
          onFinish={(v) => invite.mutate(v)}
          requiredMark={false}
        >
          <Form.Item name="email" label={t('users.email')} rules={[{ required: true, type: 'email' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="fullName" label={t('users.name')}>
            <Input />
          </Form.Item>
          <Form.Item name="roleCode" label={t('users.role')} rules={[{ required: true }]}>
            <Select
              options={(roles ?? []).map((r) => ({
                value: r.code,
                label: roleName(r.code, r.nameAr, r.nameEn),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('users.passwordOptional')}
            extra={t('users.passwordHint')}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={t('users.tempPasswordTitle')}
        open={tempPassword !== null}
        footer={[
          <Button
            key="ok"
            type="primary"
            onClick={() => {
              setTempPassword(null);
              setInviteOpen(false);
              inviteForm.resetFields();
            }}
          >
            {t('common.ok')}
          </Button>,
        ]}
      >
        <p>{t('users.tempPasswordBody')}</p>
        <Typography.Text code copyable>
          {tempPassword}
        </Typography.Text>
      </Modal>
      </Card>
    </div>
  );
}
