import { useQuery } from '@tanstack/react-query';
import { Statistic } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  ApiError,
  reportsControllerDashboardSummary,
  type DashboardSalesBlockDto,
} from '@erp/api-client';
import { apiErrorText, queryString } from '../components/ExportButtons';
import { Num } from '../components/Num';
import { dec, formatAmount, formatQty } from '../format/number';
import { codeAndName } from '../i18n/displayName';
import { palette } from '../theme';

/** Items listed on the card; the rest are counted. */
const SHOWN_ITEMS = 3;

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
        {t('dashboard.inclTax')}: <Num>{formatAmount(s.grand)}</Num>
      </div>
    </div>
  );
  const below = data?.belowMinimum;
  const overdue = dec(data?.receivables.overdue);

  return (
    <div className="home-stats">
      <StatCard
        to={salesLink(data?.salesToday, 'customer')}
        tone={palette.tone.trade}
        title={t('dashboard.salesToday')}
        loading={isLoading}
        value={<Num>{formatAmount(data?.salesToday.net)}</Num>}
      >
        {data && salesDetail(data.salesToday)}
      </StatCard>
      <StatCard
        to={salesLink(data?.salesMonth, 'day')}
        tone={palette.tone.trade}
        title={t('dashboard.salesMonth')}
        loading={isLoading}
        value={<Num>{formatAmount(data?.salesMonth.net)}</Num>}
      >
        {data && salesDetail(data.salesMonth)}
      </StatCard>
      <StatCard
        to="/reports?tab=aging"
        tone={palette.tone.finance}
        title={t('dashboard.receivables')}
        loading={isLoading}
        value={<Num>{formatAmount(data?.receivables.total)}</Num>}
      >
        <div className="home-stat-sub">
          {t('dashboard.overdue')}:{' '}
          <Num style={overdue.gt(0) ? { color: palette.danger, fontWeight: 600 } : undefined}>
            {formatAmount(data?.receivables.overdue)}
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
    </div>
  );
}
