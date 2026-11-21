import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Popconfirm,
  Segmented,
  Space,
  Table,
  Tag,
  message,
} from 'antd';
import { useMemo, useState } from 'react';
import type { Key } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import {
  ApiError,
  accountingControllerUpdateAccount,
  journalControllerTrialBalance,
  type AccountType,
} from '@erp/api-client';
import { AccountFormDialog } from '../components/AccountFormDialog';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { tableLocale } from '../components/QueryState';
import { bothNames } from '../i18n/displayName';
import { palette } from '../theme';
import { Num } from '../components/Num';
import type Decimal from 'decimal.js';
import { amountCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';
import { ACCOUNTS_QUERY_KEY, useAccounts, type AccountRow } from '../hooks/useAccounts';
import { useAuth } from '../auth/AuthContext';
import { useCostCenters } from '../hooks/useCostCenters';

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

export function expandedKeysForLevel(nodes: TreeNode[], level: 1 | 2 | 3 | 'all'): string[] {
  const keys: string[] = [];
  const visit = (rows: TreeNode[]) => {
    for (const node of rows) {
      if (node.children?.length && (level === 'all' || node.level < level)) keys.push(node.id);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes);
  return keys;
}

export function expandedKeysForSearch(nodes: TreeNode[]): string[] {
  return expandedKeysForLevel(nodes, 'all');
}

export function debitBalance(node: TreeNode) {
  return node.balDebit.minus(node.balCredit);
}

export function debitBalanceSide(node: TreeNode): 'DEBIT' | 'CREDIT' {
  return debitBalance(node).isNegative() ? 'CREDIT' : 'DEBIT';
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
  const { enabled: costCentersOn } = useCostCenters();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [search, setSearch] = useState('');
  const [expandLevel, setExpandLevel] = useState<1 | 2 | 3 | 'all'>('all');
  const [expandedKeys, setExpandedKeys] = useState<Key[] | null>(null);
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
    setModalOpen(true);
  };

  const openEdit = (a: Account) => {
    setEditing(a);
    setModalOpen(true);
  };

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
          <Space wrap>
            <Segmented<string | number>
              value={expandLevel}
              onChange={(value) => {
                setExpandLevel(value as 1 | 2 | 3 | 'all');
                setExpandedKeys(null);
              }}
              options={[
                { label: t('accounts.level1'), value: 1 },
                { label: t('accounts.level2'), value: 2 },
                { label: t('accounts.level3'), value: 3 },
                { label: t('accounts.allLevels'), value: 'all' },
              ]}
            />
            <Button type="primary" onClick={openCreate}>
              {t('accounts.add')}
            </Button>
          </Space>
        }
      />
      <Table
        rowKey="id"
        loading={isLoading}
        dataSource={shownTree}
        locale={tableLocale(accountsQuery)}
        pagination={false}
        expandable={{
          expandedRowKeys: search.trim()
            ? expandedKeysForSearch(shownTree)
            : expandedKeys ?? expandedKeysForLevel(shownTree, expandLevel),
          onExpandedRowsChange: (keys) => setExpandedKeys([...keys]),
        }}
        rowClassName={(account) => (account.isPostable ? '' : 'account-group-row')}
        columns={[
          {
            title: t('accounts.code'),
            dataIndex: 'code',
            width: 160,
            onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
          },
          {
            title: t('common.name'),
            key: 'name',
            render: (_: unknown, a: Account) => (
              <Space size={8}>
                {bothNames(a)}
                {costCentersOn && a.costCenterRequired && (
                  <Tag style={{ background: palette.ink100, color: palette.ink600, borderColor: palette.ink200 }}>
                    {t('costCenters.requiredTag')}
                  </Tag>
                )}
              </Space>
            ),
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
            render: (v: boolean) => (
              <Tag color={v ? 'blue' : 'default'}>
                {v ? t('accounts.postable') : t('accounts.group')}
              </Tag>
            ),
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
              const debitSide = debitBalance(a as TreeNode);
              return (
                <Space size={4}>
                  <Num>{formatAmount(debitSide.abs())}</Num>
                  <Tag color={debitBalanceSide(a as TreeNode) === 'CREDIT' ? 'orange' : 'blue'}>
                    {t(`accounts.${debitBalanceSide(a as TreeNode).toLowerCase()}Tag`)}
                  </Tag>
                </Space>
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
      <AccountFormDialog
        open={modalOpen}
        editing={editing}
        onCancel={() => setModalOpen(false)}
        onSaved={() => {
          setModalOpen(false);
          setEditing(null);
        }}
      />
      </Card>
    </div>
  );
}
