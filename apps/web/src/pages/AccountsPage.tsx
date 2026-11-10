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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ApiError,
  accountingControllerCreateAccount,
  accountingControllerListAccounts,
  accountingControllerUpdateAccount,
  journalControllerTrialBalance,
} from '@erp/api-client';
import { BookOutlined, FlagOutlined } from '@ant-design/icons';
import { FormDialog, FormSection } from '../components/FormDialog';
import {
  OpeningNote,
  OpeningSideFields,
  openingApi,
  sameSides,
  sideValue,
  toSides,
  type AccountOpening,
} from '../components/OpeningBalance';
import { PageHeader } from '../components/PageHeader';
import { ListToolbar, matchesSearch } from '../components/ListToolbar';
import { bothNames, codeAndName } from '../i18n/displayName';
import { palette } from '../theme';
import { Num } from '../components/Num';
import type Decimal from 'decimal.js';
import { amountCell } from '../format/cells';
import { dec, formatAmount } from '../format/number';

export interface Account {
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

export interface TreeNode extends Account {
  children?: TreeNode[];
  /** Rolled-up totals over POSTED journal lines (own + descendants). */
  balDebit: Decimal;
  balCredit: Decimal;
  balBalance: Decimal;
}

interface TrialRow {
  accountId: string;
  totalDebit: string;
  totalCredit: string;
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

export function AccountsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [search, setSearch] = useState('');
  const [form] = Form.useForm();
  const [apiMessage, contextHolder] = message.useMessage();

  const { data, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => accountingControllerListAccounts().then((r) => r.data as unknown as Account[]),
  });

  const { data: trial, isError: trialError } = useQuery({
    queryKey: ['trial-balance'],
    queryFn: () =>
      journalControllerTrialBalance().then(
        (r) => r.data as unknown as { rows: TrialRow[] },
      ),
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

  // Opening balances (ADR-007): the chart's summary strip and the form section.
  const { data: opening } = useQuery({ queryKey: ['opening-balances'], queryFn: openingApi.summary });
  const { data: accountOpening } = useQuery({
    queryKey: ['opening-account', editing?.id],
    queryFn: () => openingApi.account(editing!.id),
    enabled: modalOpen && !!editing,
  });
  // Fill the opening fields once per opened account — never over what the user typed
  // (after a create, the new account's empty answer must not wipe the entry).
  const openingFilledFor = useRef<string | null>(null);
  useEffect(() => {
    if (modalOpen && accountOpening && accountOpening.accountId === editing?.id && openingFilledFor.current !== editing.id) {
      openingFilledFor.current = editing.id;
      form.setFieldsValue({
        opening: { debit: sideValue(accountOpening.debit), credit: sideValue(accountOpening.credit) },
      });
    }
  }, [modalOpen, accountOpening, editing, form]);
  const equityAccount = (data ?? []).find((a) => a.id === opening?.equityAccountId);
  const openingDate = opening?.date?.slice(0, 10) ?? '';

  const watchedParentId = Form.useWatch('parentId', form) as string | undefined;
  const watchedType = Form.useWatch('accountType', form) as Account['accountType'] | undefined;
  const watchedPostable = Form.useWatch('isPostable', form) as boolean | undefined;
  // Edit: the server says why; create: the account rules from the form's own fields,
  // then the general lock (fiscal year, closed period, permission).
  const openingLoaded = editing ? accountOpening?.accountId === editing.id : !!opening;
  const openingLock: AccountOpening['lockedReason'] = editing
    ? openingLoaded
      ? accountOpening!.lockedReason
      : null
    : watchedType === 'REVENUE' || watchedType === 'EXPENSE'
      ? 'INCOME_ACCOUNT'
      : watchedPostable === false
        ? 'GROUP_ACCOUNT'
        : (opening?.lockedReason ?? null);
  const openingEditable = openingLoaded && !openingLock;
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
      opening?: { debit?: string; credit?: string };
    }) => {
      let accountId = editing?.id;
      if (editing) {
        await accountingControllerUpdateAccount(editing.id, {
          nameAr: values.nameAr,
          nameEn: values.nameEn || null,
          isPostable: values.isPostable,
        });
      } else {
        const res = await accountingControllerCreateAccount({
          code: values.parentId ? undefined : values.code!,
          nameAr: values.nameAr,
          nameEn: values.nameEn || undefined,
          parentId: values.parentId || undefined,
          accountType: values.accountType,
          isPostable: values.isPostable ?? true,
        });
        const created = (res as unknown as { data: Account }).data;
        accountId = created.id;
        // If the opening balance fails below, a retry edits this account instead of adding
        // another — keeping what was typed (its empty answer must not refill the fields).
        openingFilledFor.current = created.id;
        setEditing(created);
      }
      const target = toSides(values.opening);
      const before = editing && accountOpening ? accountOpening : { debit: '0', credit: '0' };
      if (openingEditable && accountId && !sameSides(target, before)) {
        await openingApi.setAccount(accountId, target);
      }
    },
    onSuccess: () => {
      apiMessage.success(t('common.saved'));
      setModalOpen(false);
      setEditing(null);
      form.resetFields();
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['opening-balances'] });
      void queryClient.invalidateQueries({ queryKey: ['opening-account'] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance'] });
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
    openingFilledFor.current = null;
    form.resetFields();
    setModalOpen(true);
  };

  const openEdit = (a: Account) => {
    setEditing(a);
    openingFilledFor.current = null;
    form.setFieldsValue({ nameAr: a.nameAr, nameEn: a.nameEn, isPostable: a.isPostable, opening: undefined });
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
      {opening?.date && (opening.accounts.length > 0 || opening.editable) && (
        <div className="opening-strip">
          <span>{t('opening.strip', { date: openingDate })}</span>
          <span>
            {t('journal.debit')} <Num>{formatAmount(opening.totals.debit)}</Num>
          </span>
          <span>
            {t('journal.credit')} <Num>{formatAmount(opening.totals.credit)}</Num>
          </span>
          {dec(opening.difference.debit).isZero() && dec(opening.difference.credit).isZero() ? (
            <Tag color="green">{t('opening.balanced')}</Tag>
          ) : (
            <Tag color="gold">
              {t('opening.differenceIn', { account: equityAccount ? codeAndName(equityAccount) : '' })}{' '}
              <Num>
                {formatAmount(
                  dec(opening.difference.debit).isZero() ? opening.difference.credit : opening.difference.debit,
                )}
              </Num>{' '}
              {dec(opening.difference.debit).isZero() ? t('journal.credit') : t('journal.debit')}
            </Tag>
          )}
        </div>
      )}
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
            render: (v: Account['accountType']) => t(`accounts.types.${v}`),
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
            width: 150,
            render: (_: unknown, a: Account) => (
              <Space>
                <Button size="small" onClick={() => openEdit(a)}>
                  {t('common.edit')}
                </Button>
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
          <FormSection title={t('opening.section')} icon={<FlagOutlined />}>
            <OpeningSideFields name={['opening']} disabled={!openingEditable} />
            <OpeningNote>
              {openingLock
                ? t(`opening.locked.${openingLock}`)
                : t('opening.postedOn', {
                    date: openingDate,
                    account: equityAccount ? codeAndName(equityAccount) : '',
                  })}
            </OpeningNote>
          </FormSection>
        </Form>
      </FormDialog>
      </Card>
    </div>
  );
}
