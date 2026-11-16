import { Alert, Skeleton, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import type { StockCountVarianceDto } from '@erp/api-client';
import { ExportButtons } from '../../components/ExportButtons';
import { formatAmount, formatQty } from '../../format/number';
import { palette } from '../../theme';

/**
 * The difference report of a submitted or posted count (ADR-030 §12, §13):
 * shortage, surplus and net value, the lines with no prior cost, the lines
 * not counted, and the PDF and Excel exports. Values are priced at the
 * weighted average cost the ledger will use.
 */
export function CountVariancePanel({
  id,
  variance,
  loading,
  failed,
}: {
  id: string;
  variance: StockCountVarianceDto | undefined;
  loading: boolean;
  failed: boolean;
}) {
  const { t } = useTranslation();

  return (
    <section className="count-variance" aria-labelledby={`count-variance-${id}`}>
      <div className="count-variance-head">
        <h3 id={`count-variance-${id}`} className="count-variance-title">
          {t('stockCount.variance.title')}
        </h3>
        <ExportButtons path={`/stock-counts/${id}/variance`} />
      </div>

      {failed && <Alert type="error" showIcon message={t('stockCount.variance.failed')} />}
      {loading && !variance && <Skeleton active paragraph={{ rows: 2 }} />}

      {variance && (
        <>
          <div className="count-variance-grid">
            <Tile
              tone="shortage"
              label={t('stockCount.variance.shortage')}
              value={formatAmount(variance.totals.shortageValue)}
              hint={t('stockCount.variance.qty', { qty: formatQty(variance.totals.shortageQty) })}
            />
            <Tile
              tone="surplus"
              label={t('stockCount.variance.surplus')}
              value={formatAmount(variance.totals.surplusValue)}
              hint={t('stockCount.variance.qty', { qty: formatQty(variance.totals.surplusQty) })}
            />
            <Tile
              tone="net"
              label={t('stockCount.variance.net')}
              value={formatAmount(variance.totals.netValue)}
              hint={t('stockCount.variance.counts', {
                counted: variance.totals.countedLines,
                uncounted: variance.totals.uncountedLines,
              })}
            />
          </div>

          {variance.lines.some((l) => l.zeroCostGain) && (
            <Alert
              type="warning"
              showIcon
              className="count-variance-alert"
              message={t('stockCount.variance.zeroCost')}
              description={
                <Typography.Paragraph className="count-uncounted-list" style={{ marginBottom: 0 }}>
                  {variance.lines
                    .filter((l) => l.zeroCostGain)
                    .map((l) => (
                      <span key={l.itemId} className="count-code">
                        {l.code} {l.nameAr}
                      </span>
                    ))}
                </Typography.Paragraph>
              }
            />
          )}

          {variance.uncounted.length > 0 && (
            <Alert
              type="info"
              showIcon
              className="count-variance-alert"
              message={t('stockCount.variance.uncountedList', { count: variance.uncounted.length })}
              description={
                <Typography.Paragraph className="count-uncounted-list" style={{ marginBottom: 0 }}>
                  {variance.uncounted.map((u) => (
                    <span key={u.itemId} className="count-code">
                      {u.code} {u.nameAr}
                    </span>
                  ))}
                </Typography.Paragraph>
              }
            />
          )}
        </>
      )}
    </section>
  );
}

function Tile({
  tone,
  label,
  value,
  hint,
}: {
  tone: 'shortage' | 'surplus' | 'net';
  label: string;
  value: string;
  hint: string;
}) {
  const colour = tone === 'shortage' ? palette.danger : tone === 'surplus' ? palette.success : palette.ink600;
  return (
    <div className={`count-tile count-tile-${tone}`}>
      <div className="count-tile-label">{label}</div>
      <div className="count-tile-value" style={{ color: colour }}>
        <span dir="ltr">{value}</span>
      </div>
      <div className="count-tile-hint">{hint}</div>
    </div>
  );
}
