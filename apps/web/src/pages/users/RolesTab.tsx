import { DeleteOutlined, EditOutlined, PlusOutlined, SafetyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  type CustomRolePermission,
  type SaveTenantRoleDto,
  type TenantRoleDto,
  tenantRolesControllerCatalog,
  tenantRolesControllerCreate,
  tenantRolesControllerList,
  tenantRolesControllerRemove,
  tenantRolesControllerUpdate,
} from '@erp/api-client';
import { FormDialog, FormSection } from '../../components/FormDialog';
import { tableLocale } from '../../components/QueryState';

/** The module a permission belongs to, by its code prefix, for the editor's groups. */
const GROUP_BY_PREFIX: Record<string, string> = {
  account: 'accounting',
  cost_center: 'accounting',
  journal: 'accounting',
  fiscal: 'accounting',
  item: 'inventory',
  warehouse: 'inventory',
  stock: 'inventory',
  parties: 'sales',
  sales: 'sales',
  einvoice: 'sales',
  purchase: 'purchasing',
  purchase_request: 'purchasing',
  treasury: 'treasury',
};
const GROUP_ORDER = ['general', 'accounting', 'inventory', 'sales', 'purchasing', 'treasury'];
const ALWAYS = 'tenant.read';

export const permissionKey = (code: string) => `users.perm.${code.replace(/\./g, '_')}`;

export function groupPermissions(codes: readonly string[]): { group: string; codes: string[] }[] {
  const groups = new Map<string, string[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const code of codes) {
    const group = GROUP_BY_PREFIX[code.split('.')[0]!] ?? 'general';
    groups.get(group)!.push(code);
  }
  return GROUP_ORDER.map((group) => ({ group, codes: groups.get(group)! })).filter(
    (g) => g.codes.length > 0,
  );
}

/** A company's own roles (ADR-038): a list, and a dialog with the permissions grouped by module. */
export function RolesTab() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [apiMessage, contextHolder] = message.useMessage();
  const [form] = Form.useForm<SaveTenantRoleDto>();
  // undefined: closed; null: a new role; a role: editing it.
  const [editing, setEditing] = useState<TenantRoleDto | null | undefined>(undefined);

  const rolesQuery = useQuery({
    queryKey: ['tenant-roles'],
    queryFn: ({ signal }) => tenantRolesControllerList({ signal }).then((r) => r.data),
  });
  const { data: roles, isLoading } = rolesQuery;
  const { data: catalog } = useQuery({
    queryKey: ['tenant-roles', 'catalog'],
    queryFn: ({ signal }) => tenantRolesControllerCatalog({ signal }).then((r) => r.data),
  });

  const onError = (err: unknown) =>
    apiMessage.error(
      err instanceof ApiError
        ? t(`errors.${err.code}`, { defaultValue: err.message })
        : t('errors.INTERNAL'),
    );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tenant-roles'] });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const save = useMutation({
    mutationFn: async (values: SaveTenantRoleDto) => {
      await (editing
        ? tenantRolesControllerUpdate(editing.id, values)
        : tenantRolesControllerCreate(values));
    },
    onSuccess: () => {
      apiMessage.success(t('users.roleSaved'));
      setEditing(undefined);
      refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => tenantRolesControllerRemove(id),
    onSuccess: () => {
      apiMessage.success(t('users.roleDeleted'));
      refresh();
    },
    onError,
  });

  const open = (role: TenantRoleDto | null) => {
    form.setFieldsValue(
      role
        ? {
            code: role.code,
            nameAr: role.nameAr,
            nameEn: role.nameEn ?? undefined,
            description: role.description ?? undefined,
            permissions: role.permissions,
          }
        : {
            code: '',
            nameAr: '',
            nameEn: undefined,
            description: undefined,
            permissions: [ALWAYS as CustomRolePermission],
          },
    );
    setEditing(role);
  };

  const submit = () =>
    form.validateFields().then((v) =>
      save.mutate({
        ...v,
        nameEn: v.nameEn || undefined,
        description: v.description || undefined,
        permissions: v.permissions ?? [],
      }),
    );

  const name = (r: TenantRoleDto) => (i18n.language === 'ar' ? r.nameAr : (r.nameEn ?? r.nameAr));

  return (
    <div>
      {contextHolder}
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => open(null)}>
          {t('users.newRole')}
        </Button>
      </Space>
      <Table<TenantRoleDto>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={roles ?? []}
        pagination={false}
        locale={tableLocale(rolesQuery, t('users.rolesEmpty'))}
        columns={[
          { title: t('users.roleCode'), dataIndex: 'code', width: 160 },
          { title: t('users.name'), render: (_: unknown, r) => name(r) },
          {
            title: t('users.rolePermissions'),
            render: (_: unknown, r) =>
              t('users.rolePermissionCount', { count: r.permissions.length }),
          },
          { title: t('users.roleMembers'), dataIndex: 'memberCount', width: 100 },
          {
            title: t('users.actions'),
            width: 120,
            render: (_: unknown, r) => (
              <Space>
                <Tooltip title={t('users.editRole')}>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    aria-label={t('users.editRole')}
                    onClick={() => open(r)}
                  />
                </Tooltip>
                <Popconfirm
                  title={t('users.deleteRoleConfirm')}
                  onConfirm={() => remove.mutate(r.id)}
                >
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('users.deleteRole')}
                  />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <FormDialog
        open={editing !== undefined}
        title={editing ? t('users.editRole') : t('users.newRole')}
        onCancel={() => setEditing(undefined)}
        onSave={submit}
        saving={save.isPending}
        width={860}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <FormSection title={t('users.details')} icon={<SafetyOutlined />}>
            <Form.Item
              name="code"
              label={t('users.roleCode')}
              extra={t('users.roleCodeHint')}
              normalize={(v: string) => v?.toUpperCase()}
              rules={[{ required: true, pattern: /^[A-Z0-9_-]{2,50}$/ }]}
            >
              <Input maxLength={50} />
            </Form.Item>
            <Form.Item name="nameAr" label={t('users.roleNameAr')} rules={[{ required: true }]}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="nameEn" label={t('users.roleNameEn')}>
              <Input maxLength={191} />
            </Form.Item>
            <Form.Item name="description" label={t('users.roleDescription')} className="span-all">
              <Input maxLength={1000} />
            </Form.Item>
          </FormSection>
          <FormSection title={t('users.rolePermissions')} icon={<SafetyOutlined />} cols={2}>
            <Form.Item name="permissions" className="span-all">
              <Checkbox.Group style={{ display: 'block' }}>
                {groupPermissions(catalog?.assignable ?? []).map(({ group, codes }) => (
                  <div key={group} style={{ marginBottom: 8 }}>
                    <Typography.Text strong>{t(`users.permGroup.${group}`)}</Typography.Text>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                        gap: 4,
                      }}
                    >
                      {codes.map((code) => (
                        <Checkbox key={code} value={code} disabled={code === ALWAYS}>
                          {t(permissionKey(code))}
                        </Checkbox>
                      ))}
                    </div>
                  </div>
                ))}
              </Checkbox.Group>
            </Form.Item>
          </FormSection>
        </Form>
      </FormDialog>
    </div>
  );
}
