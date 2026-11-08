import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  accountingControllerCreateAccount,
  accountingControllerListAccounts,
  accountingControllerUpdateAccount,
} from '@erp/api-client';
import { PageHeader } from '../components/PageHeader';

interface Account {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: string | null;
  level: number;
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normalBalance: 'DEBIT' | 'CREDIT';
  isPostable: boolean;
  isControl: boolean;
  controlType: string | null;
  isActive: boolean;
}

interface TreeNode extends Account {
  children?: TreeNode[];
}

function buildTree(accounts: Account[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const a of accounts) byId.set(a.id, { ...a });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) {
      parent.children = [...(parent.children ?? []), node];
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.code.localeCompare(b.code));
    for (const n of nodes) if (n.children) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

export function AccountsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const { data, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as Account[]),
  });

  const tree = useMemo(() => buildTree(data ?? []), [data]);

  const watchedParentId = Form.useWatch('parentId', form) as string | undefined;
  const isCreate = !editing;
  const selectedParent = useMemo(
    () => (data ?? []).find((a) => a.id === watchedParentId) ?? null,
    [data, watchedParentId],
  );
  const autoCode = useMemo(() => {
    if (!selectedParent) return null;
    const prefix = `${selectedParent.code}-`;
    let max = 0;
    for (const a of data ?? []) {
      if (a.code.startsWith(prefix)) {
        const suffix = a.code.slice(prefix.length);
        if (/^\d+$/.test(suffix)) max = Math.max(max, Number(suffix));
      }
    }
    return `${prefix}${String(max + 1).padStart(2, '0')}`;
  }, [data, selectedParent]);

  const save = useMutation({
    mutationFn: async (values: {
      code?: string;
      nameAr: string;
      nameEn?: string;
      parentId?: string;
      accountType: Account['accountType'];
      isPostable?: boolean;
    }) => {
      if (editing) {
        return accountingControllerUpdateAccount(editing.id, {
          nameAr: values.nameAr,
          nameEn: values.nameEn || null,
          isPostable: values.isPostable,
        });
      }
      return accountingControllerCreateAccount({
        code: values.parentId ? undefined : values.code!,
        nameAr: values.nameAr,
        nameEn: values.nameEn || undefined,
        parentId: values.parentId || undefined,
        accountType: values.accountType,
        isPostable: values.isPostable ?? true,
      });
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) =>
      accountingControllerUpdateAccount(id, { isActive: false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['accounts'] }),
    onError: (err) => {
      apiMessage.error(
        err instanceof ApiError
          ? t(`errors.${err.code}`, { defaultValue: err.message })
          : t('errors.INTERNAL'),
      );
    },
  });

  const openCreate = () => {
    setEditing(null);
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (a: Account) => {
    setEditing(a);
    form.setFieldsValue({ nameAr: a.nameAr, nameEn: a.nameEn, isPostable: a.isPostable });
    setModalOpen(true);
  };

  const parentOptions = (data ?? [])
    .filter((a) => a.isActive && a.id !== editing?.id)
    .map((a) => ({ value: a.id, label: `${a.code} — ${a.nameAr}` }));

  return (
    <div>
      <PageHeader
        title={t('accounts.title')}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('accounts.add')}
          </Button>
        }
      />
      <Card>
      {contextHolder}
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={tree}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
        columns={[
          { title: t('accounts.code'), dataIndex: 'code', width: 110 },
          {
            title: t('accounts.nameAr'),
            dataIndex: 'nameAr',
            render: (v: string, a: Account) => (
              <span>
                {v}
                {a.nameEn ? ` (${a.nameEn})` : ''}
              </span>
            ),
          },
          {
            title: t('accounts.type'),
            dataIndex: 'accountType',
            width: 110,
            render: (v: Account['accountType']) => t(`accounts.types.${v}`),
          },
          {
            title: t('accounts.postable'),
            dataIndex: 'isPostable',
            width: 100,
            render: (v: boolean) => (v ? t('common.active') : '—'),
          },
          {
            title: t('common.status'),
            dataIndex: 'isActive',
            width: 90,
            render: (v: boolean) =>
              v ? (
                <Tag color="green">{t('common.active')}</Tag>
              ) : (
                <Tag>{t('common.inactive')}</Tag>
              ),
          },
          {
            title: t('common.actions'),
            width: 150,
            render: (_: unknown, a: Account) => (
              <Space>
                <Button size="small" onClick={() => openEdit(a)}>
                  {t('common.edit')}
                </Button>
                {a.isActive && !a.isControl && (
                  <Button size="small" danger onClick={() => deactivate.mutate(a.id)}>
                    {t('common.deactivate')}
                  </Button>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? t('accounts.edit') : t('accounts.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
          {!editing && (
            <>
              {isCreate && selectedParent && autoCode && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  message={t('accounts.childUnder', { code: selectedParent.code })}
                  description={
                    <>
                      {t('accounts.autoCodePreview', { code: autoCode })}
                      <br />
                      {t('accounts.parentNonPostableWarning')}
                    </>
                  }
                />
              )}
              {!(isCreate && watchedParentId) && (
                <Form.Item
                  name="code"
                  label={t('accounts.code')}
                  rules={[{ required: !(isCreate && watchedParentId) }]}
                >
                  <Input maxLength={50} />
                </Form.Item>
              )}
              <Form.Item name="parentId" label={t('accounts.parent')}>
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  options={parentOptions}
                />
              </Form.Item>
              <Form.Item
                name="accountType"
                label={t('accounts.type')}
                rules={[{ required: true }]}
              >
                <Select
                  options={(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'] as const).map(
                    (v) => ({ value: v, label: t(`accounts.types.${v}`) }),
                  )}
                />
              </Form.Item>
            </>
          )}
          <Form.Item name="nameAr" label={t('accounts.nameAr')} rules={[{ required: true }]}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="nameEn" label={t('accounts.nameEn')}>
            <Input maxLength={191} />
          </Form.Item>
          <Form.Item name="isPostable" label={t('accounts.postable')}>
            <Select
              allowClear
              options={[
                { value: true, label: t('common.active') },
                { value: false, label: '—' },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
      </Card>
    </div>
  );
}
