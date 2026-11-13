import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tooltip,
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
  usersControllerResetPassword,
  usersControllerRoles,
  usersControllerSuspend,
  usersControllerUpdate,
} from '@erp/api-client';
import { KeyOutlined, UserOutlined } from '@ant-design/icons';
import { useAuth } from '../auth/AuthContext';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';

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
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteForm] = Form.useForm();
  // One modal shows whichever temporary password was just issued (invite or reset).
  const [tempPassword, setTempPassword] = useState<{
    value: string;
    purpose: 'invite' | 'reset';
  } | null>(null);
  const [search, setSearch] = useState('');
  const [apiMessage, contextHolder] = message.useMessage();

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: () => usersControllerList().then((r) => r.data as unknown as Membership[]),
  });
  const { data, isLoading } = usersQuery;

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
        setTempPassword({ value: body.temporaryPassword, purpose: 'invite' });
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

  const resetPassword = useMutation({
    mutationFn: (membershipId: string) => usersControllerResetPassword(membershipId),
    onSuccess: (res) => {
      const body = res.data as unknown as { temporaryPassword: string };
      setTempPassword({ value: body.temporaryPassword, purpose: 'reset' });
    },
    onError,
  });

  const roleName = (_code: string, ar: string, en: string | null) =>
    i18n.language === 'ar' ? ar : (en ?? ar);

  // Mirrors the server refusals in UsersService.resetPassword: no self-reset,
  // no suspended members, and only an owner may reset an owner.
  const canResetPassword = (m: Membership) =>
    m.user.id !== me?.user.id &&
    m.status !== 'SUSPENDED' &&
    !(m.role.code === 'OWNER' && me?.currentMembership?.roleCode !== 'OWNER');

  // Mirrors the server refusals in UsersService.update/invite (PLAT-01): no one
  // changes their own role or status, and only an owner grants OWNER or
  // changes an owner's membership.
  const isOwner = me?.currentMembership?.roleCode === 'OWNER';
  const canManage = (m: Membership) =>
    m.user.id !== me?.user.id && (isOwner || m.role.code !== 'OWNER');
  const roleOptions = (roles ?? [])
    .filter((r) => isOwner || r.code !== 'OWNER')
    .map((r) => ({ value: r.code, label: roleName(r.code, r.nameAr, r.nameEn) }));

  const shown = (data ?? []).filter((m) => matchesSearch(search, m.user.fullName, m.user.email));

  return (
    <div>
      <PageHeader title={t('users.title')} />
      <Card>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shown.length}
        actions={
          <Button type="primary" onClick={() => setInviteOpen(true)}>
            {t('users.invite')}
          </Button>
        }
      />
      <Table
        rowKey="membershipId"
        loading={isLoading}
        dataSource={shown}
        locale={tableLocale(usersQuery)}
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
                {canManage(m) && (
                  <Select
                    size="small"
                    style={{ width: 140 }}
                    value={m.role.code}
                    onChange={(roleCode) => changeRole.mutate({ id: m.membershipId, roleCode })}
                    options={roleOptions}
                  />
                )}
                {canResetPassword(m) && (
                  <Popconfirm
                    title={t('users.resetPasswordConfirm')}
                    okText={t('common.ok')}
                    cancelText={t('common.cancel')}
                    onConfirm={() => resetPassword.mutate(m.membershipId)}
                  >
                    {/* Icon only: the actions column stays narrow next to role and suspend. */}
                    <Tooltip title={t('users.resetPassword')}>
                      <Button
                        size="small"
                        icon={<KeyOutlined />}
                        aria-label={t('users.resetPassword')}
                        loading={resetPassword.isPending && resetPassword.variables === m.membershipId}
                      />
                    </Tooltip>
                  </Popconfirm>
                )}
                {m.status === 'ACTIVE' && canManage(m) && (
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

      <FormDialog
        title={t('users.invite')}
        open={inviteOpen && tempPassword === null}
        onCancel={() => setInviteOpen(false)}
        onSave={() => inviteForm.submit()}
        saving={invite.isPending}
      >
        <Form
          form={inviteForm}
          layout="vertical"
          onFinish={(v) => invite.mutate(v)}
        >
          <FormSection title={t('users.details')} icon={<UserOutlined />}>
            <Form.Item name="email" label={t('users.email')} rules={[{ required: true, type: 'email' }]}>
              <Input />
            </Form.Item>
            <Form.Item name="fullName" label={t('users.name')}>
              <Input />
            </Form.Item>
            <Form.Item name="roleCode" label={t('users.role')} rules={[{ required: true }]}>
              <Select options={roleOptions} />
            </Form.Item>
            <Form.Item
              name="password"
              label={t('users.passwordOptional')}
              extra={t('users.passwordHint')}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>

      <Modal
        title={
          tempPassword?.purpose === 'reset'
            ? t('users.resetPasswordTitle')
            : t('users.tempPasswordTitle')
        }
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
        <p>
          {tempPassword?.purpose === 'reset'
            ? t('users.resetPasswordBody')
            : t('users.tempPasswordBody')}
        </p>
        <Typography.Text code copyable>
          {tempPassword?.value}
        </Typography.Text>
      </Modal>
      </Card>
    </div>
  );
}
