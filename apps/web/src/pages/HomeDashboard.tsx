import { useQuery } from '@tanstack/react-query';
import { Statistic } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  ApiError,
  reportsControllerDashboardSummary,
  type DashboardSummaryDto,
  type DashboardSalesBlockDto,
} from '@erp/api-client';
import { PERMISSIONS } from '../auth/permissions';
import { useAuth } from '../auth/AuthContext';
import { apiErrorText, queryString } from '../components/ExportButtons';
import { Num } from '../components/Num';
import { dec, formatAmount, formatMoney, formatQty } from '../format/number';
import { codeAndName } from '../i18n/displayName';
import { palette } from '../theme';
import { isReportTabAvailable } from './reports/reportAccess';

/** Items listed on the card; the rest are counted. */
const SHOWN_ITEMS = 3;

type MonthlyPoint = DashboardSummaryDto['monthly'][number];
type CashBankAccount = NonNullable<DashboardSummaryDto['cashBank']>[number];

export function MonthlyBars({ monthly }: { monthly: MonthlyPoint[] }) {
  const { t, i18n } = useTranslation();
  const max = monthly.reduce((largest, row) => {
    const sales = dec(row.sales).abs();
    const expenses = dec(row.expenses).abs();
    return sales.gt(largest) ? (expenses.gt(sales) ? expenses : sales) : expenses.gt(largest) ? expenses : largest;
  }, dec(0));
  const height = (amount: string) =>
    max.gt(0) ? Math.max(2, Math.min(100, dec(amount).abs().div(max).times(100).toNumber())) : 2;
  const monthLabel = (month: string) => {
    const [year, monthNumber] = month.split('-').map(Number);
    return new Intl.DateTimeFormat(i18n.language, { month: 'short', year: '2-digit' }).format(
      new Date(year, monthNumber - 1, 1),
    );
  };

  return (
    <div>
      <div className="home-monthly-legend">
        <span className="home-legend-item">
          <span className="home-legend-dot home-legend-sales" />
          {t('dashboard.monthlySales')}
        </span>
        <span className="home-legend-item">
          <span className="home-legend-dot home-legend-expenses" />
          {t('dashboard.monthlyExpenses')}
        </span>
      </div>
      <div className="home-monthly-bars">
        {monthly.map((row) => (
          <div className="home-monthly-month" key={row.month}>
            <div className="home-monthly-pair">
              <span
                className="home-monthly-bar home-monthly-bar-sales"
                style={{ height: `${height(row.sales)}%` }}
                title={`${t('dashboard.monthlySales')}: ${formatAmount(row.sales)}`}
              />
              <span
                className="home-monthly-bar home-monthly-bar-expenses"
                style={{ height: `${height(row.expenses)}%` }}
                title={`${t('dashboard.monthlyExpenses')}: ${formatAmount(row.expenses)}`}
              />
            </div>
            <span>{monthLabel(row.month)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DashboardPanel({ title, to, children }: { title: string; to?: string; children: ReactNode }) {
  return (
    <section className="home-panel">
      <h3 className="home-panel-title">{to ? <Link to={to}>{title}</Link> : title}</h3>
      {children}
    </section>
  );
}

function CashBankPanel({
  accounts,
  total,
  canOpenStatement,
}: {
  accounts: CashBankAccount[];
  total: string;
  canOpenStatement: boolean;
}) {
  const { t } = useTranslation();
  return (
    <DashboardPanel title={t('dashboard.cashBank')}>
      <div className="home-cash-rows">
        {accounts.map((account) => {
          const content = (
            <>
              <span>{codeAndName(account)}</span>
              <Num>{formatAmount(account.balance)}</Num>
            </>
          );
          return canOpenStatement ? (
            <Link
              key={account.accountId}
              className="home-cash-row"
              to={`/reports?tab=gl&accountId=${encodeURIComponent(account.accountId)}`}
            >
              {content}
            </Link>
          ) : (
            <div key={account.accountId} className="home-cash-row">
              {content}
            </div>
          );
        })}
      </div>
      <div className="home-cash-total">
        <span>{t('dashboard.cashBankTotal')}</span>
        <Num>{formatAmount(total)}</Num>
      </div>
    </DashboardPanel>
  );
}

function StatCard({
  to,
  tone,
  title,
  value,
  loading,
  children,
}: {
  to: string;
  tone: string;
  title: string;
  value: ReactNode;
  loading: boolean;
  children?: ReactNode;
}) {
  return (
    <Link to={to} className="home-stat">
      <div className="home-stat-head">
        <span className="home-group-dot" style={{ background: tone }} />
        {title}
      </div>
      <div className="home-stat-body">
        <Statistic loading={loading} value={0} formatter={() => value} />
        {!loading && children}
      </div>
    </Link>
  );
}

/** Short dashboard on the home screen (Phase 8): today's and the month's sales, receivables, low stock. */
export function HomeDashboard() {
  const { t } = useTranslation();
  const { can, allBranches } = useAuth();
  const canReadModules = can(PERMISSIONS.TENANT_READ);
  const canOpenCashBankStatement = isReportTabAvailable('gl', allBranches);
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard-summary'],
    queryFn: ({ signal }) => reportsControllerDashboardSummary({}, { signal }).then((r) => r.data),
  });

  // Without the reports permission the home screen simply has no figures.
  if (error instanceof ApiError && error.status === 403) return null;
  if (error) return <div className="home-stats-error">{apiErrorText(t, error)}</div>;

  const salesLink = (s: DashboardSalesBlockDto | undefined, groupBy: string) =>
    `/reports${queryString({ tab: 'sales', from: s?.from, to: s?.to, groupBy })}`;
  const salesDetail = (s: DashboardSalesBlockDto) => (
    <div className="home-stat-sub">
      <div>{t('dashboard.docCounts', { invoices: s.count, returns: s.returnCount })}</div>
      <div>
        {t('dashboard.inclTax')}: <Num>{formatMoney(s.grand, t)}</Num>
      </div>
    </div>
  );
  const below = data?.belowMinimum;
  const overdue = dec(data?.receivables.overdue);
  const chequesDue = data?.chequesDue;

  return (
    <div className="home-stats">
      <StatCard
        to={salesLink(data?.salesToday, 'customer')}
        tone={palette.tone.trade}
        title={t('dashboard.salesToday')}
        loading={isLoading}
        value={<Num>{formatMoney(data?.salesToday.net, t)}</Num>}
      >
        {data && salesDetail(data.salesToday)}
      </StatCard>
      <StatCard
        to={salesLink(data?.salesMonth, 'day')}
        tone={palette.tone.trade}
        title={t('dashboard.salesMonth')}
        loading={isLoading}
        value={<Num>{formatMoney(data?.salesMonth.net, t)}</Num>}
      >
        {data && salesDetail(data.salesMonth)}
      </StatCard>
      <StatCard
        to="/reports?tab=aging"
        tone={palette.tone.finance}
        title={t('dashboard.receivables')}
        loading={isLoading}
        value={<Num>{formatMoney(data?.receivables.total, t)}</Num>}
      >
        <div className="home-stat-sub">
          {t('dashboard.overdue')}:{' '}
          <Num style={overdue.gt(0) ? { color: palette.danger, fontWeight: 600 } : undefined}>
            {formatMoney(data?.receivables.overdue, t)}
          </Num>
        </div>
      </StatCard>
      <StatCard
        to="/stock?lowStock=1"
        tone={palette.tone.inventory}
        title={t('dashboard.belowMinimum')}
        loading={isLoading}
        value={<Num style={below && below.count > 0 ? { color: palette.danger } : undefined}>{below?.count ?? 0}</Num>}
      >
        {below && below.count === 0 && <div className="home-stat-sub">{t('dashboard.noItemsBelowMinimum')}</div>}
        {below && below.items.length > 0 && (
          <ul className="home-stat-list">
            {below.items.slice(0, SHOWN_ITEMS).map((i) => (
              <li key={i.itemId}>
                <span className="home-stat-list-name">{codeAndName(i)}</span>
                <Num>
                  {formatQty(i.qtyOnHand)} / {formatQty(i.minStock)} {i.unit}
                </Num>
              </li>
            ))}
            {below.count > SHOWN_ITEMS && (
              <li className="home-stat-more">{t('dashboard.moreItems', { n: below.count - SHOWN_ITEMS })}</li>
            )}
          </ul>
        )}
      </StatCard>
      {data && (
        <div className="home-panels">
          <DashboardPanel title={t('dashboard.monthlySalesVsExpenses')}>
            <MonthlyBars monthly={data.monthly} />
          </DashboardPanel>
          {canReadModules && data.cashBank && data.cashBankTotal !== null && (
            <CashBankPanel
              accounts={data.cashBank}
              total={data.cashBankTotal}
              canOpenStatement={canOpenCashBankStatement}
            />
          )}
          {canReadModules && data.receivablesAging && (
            <DashboardPanel title={t('dashboard.receivablesAging')} to="/reports?tab=aging">
              <div className="home-aging-rows">
                {(
                  [
                    ['dashboard.agingCurrent', data.receivablesAging.current],
                    ['dashboard.aging1to30', data.receivablesAging.d1_30],
                    ['dashboard.aging31to60', data.receivablesAging.d31_60],
                    ['dashboard.aging61to90', data.receivablesAging.d61_90],
                    ['dashboard.aging90plus', data.receivablesAging.d90plus],
                  ] as const
                ).map(([label, amount]) => (
                  <div className="home-aging-row" key={label}>
                    <span>{t(label)}</span>
                    <Num>{formatAmount(amount)}</Num>
                  </div>
                ))}
              </div>
            </DashboardPanel>
          )}
          {canReadModules && chequesDue && (
            <DashboardPanel title={t('dashboard.chequesDue')} to="/treasury?tab=cheques">
              <div className="home-cheque-rows">
                {(['incoming', 'outgoing'] as const).map((direction) => (
                  <div className="home-cheque-row" key={direction}>
                    <span>{t(`dashboard.${direction}`)}</span>
                    <span>
                      {t('dashboard.countAmount', {
                        count: chequesDue[direction].count,
                        amount: formatAmount(chequesDue[direction].amount),
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </DashboardPanel>
          )}
          {canReadModules && data.drafts && (
            <DashboardPanel title={t('dashboard.pendingDrafts')}>
              <div className="home-draft-rows">
                {(
                  [
                    ['dashboard.journalDrafts', data.drafts.journalEntries, '/journal?status=DRAFT'],
                    ['dashboard.salesInvoiceDrafts', data.drafts.salesInvoices, '/sales?status=DRAFT'],
                    ['dashboard.purchaseInvoiceDrafts', data.drafts.purchaseInvoices, '/purchases?status=DRAFT'],
                    ['dashboard.receiptDrafts', data.drafts.receipts, '/treasury?tab=receipts'],
                    ['dashboard.paymentDrafts', data.drafts.payments, '/treasury?tab=payments'],
                  ] as const
                ).map(([label, count, to]) => (
                  <Link className="home-draft-row" key={label} to={to}>
                    <span>{t(label)}</span>
                    <span>{count}</span>
                  </Link>
                ))}
              </div>
            </DashboardPanel>
          )}
        </div>
      )}
    </div>
  );
}
