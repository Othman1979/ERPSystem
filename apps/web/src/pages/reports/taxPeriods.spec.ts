import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { bimonthEnd, bimonthPresets, bimonthStart } from './taxPeriods';

const day = (d: dayjs.Dayjs) => d.format('YYYY-MM-DD');

describe('two-month tax return periods', () => {
  it.each([
    ['2026-01-01', '2026-01-01', '2026-02-28'],
    ['2026-02-28', '2026-01-01', '2026-02-28'],
    ['2028-02-15', '2028-01-01', '2028-02-29'],
    ['2026-04-30', '2026-03-01', '2026-04-30'],
    ['2026-11-10', '2026-11-01', '2026-12-31'],
    ['2026-12-31', '2026-11-01', '2026-12-31'],
  ])('%s falls in %s – %s', (date, from, to) => {
    const start = bimonthStart(dayjs(date));
    expect(day(start)).toBe(from);
    expect(day(bimonthEnd(start))).toBe(to);
  });

  it('lists the current period and the eleven before it, newest first', () => {
    const presets = bimonthPresets(dayjs('2026-03-15'), 'en');
    expect(presets).toHaveLength(12);
    expect(presets[0]).toMatchObject({ value: '2026-03', label: 'March – April 2026' });
    expect(presets[1]).toMatchObject({ value: '2026-01', label: 'January – February 2026' });
    expect(presets[2].label).toBe('November – December 2025');
    expect(day(presets[11].from)).toBe('2024-05-01');
  });
});
