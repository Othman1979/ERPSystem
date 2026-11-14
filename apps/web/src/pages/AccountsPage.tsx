import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  accountingControllerCreateAccount,
  accountingControllerUpdateAccount,
  journalControllerTrialBalance,
  type AccountType,
} from '@erp/api-client';
import { BookOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';
import { bothNames, codeAndName } from '../i18n/displayName';
import { palette } from '../theme';
import { Num } from '../components/Num';
import type Decimal from 'decimal.js';
import { amountCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import { ACCOUNTS_QUERY_KEY, useAccounts, type AccountRow } from '../hooks/useAccounts';
import { useAuth } from '../auth/AuthContext';

export type Account = AccountRow;

export interface TreeNode extends Account {
  children?: TreeNode[];
  /** Rolled-up totals over POSTED journal lines (own + descendants). */
  balDebit: Decimal;
  balCredit: Decimal;
  balBalance: Decimal;
}

export function buildTree(accounts: Account[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const a of accounts)
    byId.set(a.id, { ...a, balDebit: dec(0), balCredit: dec(0), balBalance: dec(0) });
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

const ZERO = { debit: dec(0), credit: dec(0) };

/** Attach rolled-up posted totals to every node (own + descendants). */
export function applyBalances(
  nodes: TreeNode[],
  balMap: Map<string, { debit: Decimal; credit: Decimal }>,
) {
  let debit = dec(0);
  let credit = dec(0);
  for (const n of nodes) {
    const own = balMap.get(n.id) ?? ZERO;
    const child = n.children?.length ? applyBalances(n.children, balMap) : ZERO;
    n.balDebit = own.debit.plus(child.debit);
    n.balCredit = own.credit.plus(child.credit);
    n.balBalance =
      n.normalBalance === 'DEBIT' ? n.balDebit.minus(n.balCredit) : n.balCredit.minus(n.balDebit);
    debit = debit.plus(n.balDebit);
    credit = credit.plus(n.balCredit);
  }
  return { debit, credit };
}

/**
 * The trial balance for the balances column: no filters, and the query's
 * signal as the request option, so leaving the page cancels it. (It used to
 * pass `{ signal }` as the query params, which sent nothing cancellable.)
 */
export function fetchTrialBalance(signal: AbortSignal) {
  return journalControllerTrialBalance({}, { signal }).then((r) => r.data);
}

export function AccountsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The account statement is company-wide (ADR-003 §13): shown only to members with every branch.
  const { allBranches } = useAuth();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const accountsQuery = useAccounts();
  const { data, isLoading } = accountsQuery;

  const { data: trial, isError: trialError } = useQuery({
    queryKey: ['trial-balance'],
    queryFn: ({ signal }) => fetchTrialBalance(signal),
    retry: false,
  });

  const tree = useMemo(() => {
    const nodes = buildTree(data ?? []);
    if (trial?.rows) {
      const balMap = new Map(
        trial.rows.map((r) => [
          r.accountId,
          { debit: dec(r.totalDebit), credit: dec(r.totalCredit) },
        ]),
      );
      applyBalances(nodes, balMap);
    }
    return nodes;
  }, [data, trial]);

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
      accountType: AccountType;
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
      void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY }),
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
    .map((a) => ({ value: a.id, label: codeAndName(a) }));

  // Keep matching accounts plus their ancestors so the tree stays intact;
  // balances were rolled up on the full tree above, so they are unaffected.
  const shownTree = useMemo(() => {
    const prune = (nodes: TreeNode[]): TreeNode[] =>
      nodes.flatMap((n) => {
        const kids = n.children ? prune(n.children) : [];
        if (matchesSearch(search, n.code, n.nameAr, n.nameEn) || kids.length) {
          return [{ ...n, children: kids.length ? kids : undefined }];
        }
        return [];
      });
    return search.trim() ? prune(tree) : tree;
  }, [tree, search]);
  const shownCount = (data ?? []).filter((a) =>
    matchesSearch(search, a.code, a.nameAr, a.nameEn),
  ).length;

  return (
    <div>
      <PageHeader title={t('accounts.title')} />
      <Card>
      {contextHolder}
      <ListToolbar
        search={search}
        onSearch={setSearch}
        count={shownCount}
        actions={
          <Button type="primary" onClick={openCreate}>
            {t('accounts.add')}
          </Button>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shownTree}
        locale={tableLocale(accountsQuery)}
        pagination={false}
        expandable={{ defaultExpandAllRows: true }}
        columns={[
          { title: t('accounts.code'), dataIndex: 'code', width: 110 },
          {
            title: t('common.name'),
            key: 'name',
            render: (_: unknown, a: Account) => bothNames(a),
          },
          {
            title: t('accounts.type'),
            dataIndex: 'accountType',
            width: 110,
            render: (v: AccountType) => t(`accounts.types.${v}`),
          },
          {
            title: t('accounts.postable'),
            dataIndex: 'isPostable',
            width: 100,
            render: (v: boolean) => (v ? t('common.active') : '—'),
          },
          {
            title: t('accounts.debit'),
            width: 110,
            align: 'right',
            render: (_: unknown, a: Account) =>
              trialError ? '—' : amountCell((a as TreeNode).balDebit),
          },
          {
            title: t('accounts.credit'),
            width: 110,
            align: 'right',
            render: (_: unknown, a: Account) =>
              trialError ? '—' : amountCell((a as TreeNode).balCredit),
          },
          {
            title: t('accounts.balance'),
            width: 120,
            align: 'right',
            render: (_: unknown, a: Account) => {
              if (trialError) return '—';
              const bal = (a as TreeNode).balBalance;
              return (
                <Num style={{ color: bal.isNegative() ? palette.danger : undefined }}>
                  {formatAmount(bal)}
                </Num>
              );
            },
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
            width: 230,
            render: (_: unknown, a: Account) => (
              <Space>
                <Button size="small" onClick={() => openEdit(a)}>
                  {t('common.edit')}
                </Button>
                {a.isPostable && allBranches && (
                  <Button size="small" onClick={() => navigate(`/reports?tab=gl&accountId=${a.id}`)}>
                    {t('reports.accountStatement')}
                  </Button>
                )}
                {a.isActive && !a.isControl && (
                  <Popconfirm title={t('common.confirmDeactivate')} onConfirm={() => deactivate.mutate(a.id)}>
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
        title={editing ? t('accounts.edit') : t('accounts.add')}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onSave={() => form.submit()}
        saving={save.isPending}
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          {!editing && isCreate && selectedParent && autoCode && (
            <Alert
              type="warning"
              showIcon
              style={{ margin: 12, marginBottom: 0 }}
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
          <FormSection title={t('accounts.details')} icon={<BookOutlined />}>
          {!editing && (
            <>
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
          <Form.Item name="nameAr" label={t('accounts.nameAr')} rules={[{ required: true }]} className="span-2">
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
          </FormSection>
        </Form>
      </FormDialog>
      </Card>
    </div>
  );
}
