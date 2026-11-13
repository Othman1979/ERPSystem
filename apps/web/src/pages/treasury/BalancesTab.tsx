import { useQuery } from '@tanstack/react-query';
import { Button, Table, Tag, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { treasuryControllerCashBalances } from '@erp/api-client';
import { Num } from '../../components/Num';
import { tableLocale } from '../../components/QueryState';
import { amountCell } from '../../format/cells';
import { formatAmount } from '../../format/number';
import { codeAndName } from '../../i18n/displayName';

interface BalanceRow {
  /** ACCOUNT = a cash/bank ledger account no cash box or bank record points at. */
  kind: 'CASH_BOX' | 'BANK_ACCOUNT' | 'ACCOUNT';
  id: string;
  name: string;
  isActive: boolean;
  account: { id: string; code: string; nameAr: string; nameEn: string | null };
  balance: string;
}

/**
 * Phase 6: balance of each cash box and bank account — computed from the same
 * posted journal lines as the trial balance, so the two always agree.
 */
export function BalancesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const listQuery = useQuery({
    queryKey: ['treasury-balances'],
    queryFn: () =>
      treasuryControllerCashBalances().then((r) => r.data as unknown as { rows: BalanceRow[]; total: string }),
  });
  const { data, isLoading } = listQuery;

  return (
    <Table
      rowKey={(r) => `${r.kind}:${r.id}`}
      size="small"
      loading={isLoading}
      dataSource={data?.rows ?? []}
      locale={tableLocale(listQuery)}
      pagination={false}
      columns={[
        {
          title: '',
          dataIndex: 'kind',
          width: 90,
          render: (k: BalanceRow['kind']) => (
            <Tag color={k === 'CASH_BOX' ? 'green' : k === 'BANK_ACCOUNT' ? 'blue' : 'default'}>{t(`treasury.kind_${k}`)}</Tag>
          ),
        },
        { title: t('treasury.name'), dataIndex: 'name' },
        { title: t('treasury.linkedAccount'), render: (_: unknown, r: BalanceRow) => codeAndName(r.account) },
        { title: t('treasury.balance'), dataIndex: 'balance', width: 150, align: 'right' as const, render: amountCell },
        {
          title: '',
          width: 110,
          render: (_: unknown, r: BalanceRow) => (
            <Button size="small" onClick={() => navigate(`/reports?tab=gl&accountId=${r.account.id}`)}>
              {t('reports.accountStatement')}
            </Button>
          ),
        },
      ]}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0} colSpan={3}>
            <Typography.Text strong>{t('treasury.total')}</Typography.Text>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right">
            <Typography.Text strong>
              <Num>{formatAmount(data?.total)}</Num>
            </Typography.Text>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={2} />
        </Table.Summary.Row>
      )}
    />
  );
}
