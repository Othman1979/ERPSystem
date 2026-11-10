import { PrinterOutlined } from '@ant-design/icons';
import { Button, DatePicker } from 'antd';
import type { Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';
import { Num } from '../../components/Num';

/** yyyy-mm-dd of a picked date (undefined when cleared). */
export const isoDay = (d: Dayjs | null | undefined) => d?.format('YYYY-MM-DD');

/**
 * From / to pickers for the Phase 8 reports. Left empty, the API fills the
 * period in from the fiscal year; `resolved` (the period it used) shows as
 * the placeholder so the user sees which dates the report covers.
 */
export function PeriodPickers({
  from,
  to,
  onFrom,
  onTo,
  resolved,
  allowClear = true,
}: {
  from: Dayjs | null;
  to: Dayjs | null;
  onFrom: (d: Dayjs | null) => void;
  onTo: (d: Dayjs | null) => void;
  resolved?: { from: string; to: string };
  allowClear?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <DatePicker
        value={from}
        onChange={onFrom}
        allowClear={allowClear}
        prefix={t('reports.from')}
        placeholder={resolved?.from ?? ''}
        aria-label={t('reports.from')}
      />
      <DatePicker
        value={to}
        onChange={onTo}
        allowClear={allowClear}
        prefix={t('reports.to')}
        placeholder={resolved?.to ?? ''}
        aria-label={t('reports.to')}
      />
    </>
  );
}

/** "Period: from – to", with the fiscal year the defaults came from, for `.report-meta`. */
export function PeriodMeta({
  from,
  to,
  fiscalYear,
}: {
  from: string;
  to: string;
  fiscalYear?: { code: string } | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      <span>
        {t('reports.period')}:{' '}
        <strong>
          <Num>{from}</Num> – <Num>{to}</Num>
        </strong>
      </span>
      {fiscalYear && (
        <span>
          {t('reports.fiscalYear')}: <strong>{fiscalYear.code}</strong>
        </span>
      )}
    </>
  );
}

/** On-screen print of the current report (the PDF export is the formal printout). */
export function ScreenPrintButton() {
  const { t } = useTranslation();
  return (
    <Button icon={<PrinterOutlined />} onClick={() => window.print()}>
      {t('common.print')}
    </Button>
  );
}
