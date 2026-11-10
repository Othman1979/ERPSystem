import type { Dayjs } from 'dayjs';

/*
 * Jordan's general sales-tax returns cover two calendar months:
 * Jan–Feb, Mar–Apr, May–Jun, Jul–Aug, Sep–Oct, Nov–Dec.
 */

/** First day of the two-month return period containing `d`. */
export function bimonthStart(d: Dayjs): Dayjs {
  const month = d.startOf('month');
  return month.subtract(month.month() % 2, 'month');
}

/** Last day of the return period that starts on `start`. */
export const bimonthEnd = (start: Dayjs): Dayjs => start.add(1, 'month').endOf('month');

export interface TaxPeriodPreset {
  /** yyyy-mm of the first month. */
  value: string;
  /** "January – February 2026" in the UI language. */
  label: string;
  from: Dayjs;
  to: Dayjs;
}

/** The current return period and the eleven before it (two years), newest first. */
export function bimonthPresets(today: Dayjs, lang: string): TaxPeriodPreset[] {
  const locale = lang === 'en' ? 'en' : 'ar';
  const presets: TaxPeriodPreset[] = [];
  for (let start = bimonthStart(today), i = 0; i < 12; i++, start = start.subtract(2, 'month')) {
    const end = bimonthEnd(start);
    presets.push({
      value: start.format('YYYY-MM'),
      label: `${start.locale(locale).format('MMMM')} – ${end.locale(locale).format('MMMM')} ${start.format('YYYY')}`,
      from: start,
      to: end,
    });
  }
  return presets;
}
