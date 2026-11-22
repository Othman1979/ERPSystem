import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import { formatDate, formatDateTime } from './date';

describe('date formatting', () => {
  it('formats dates as DD/MM/YYYY and date-times with 24-hour time', () => {
    const value = '2031-01-01T10:05:00';

    expect(formatDate(value)).toBe('01/01/2031');
    expect(formatDateTime(value)).toBe('01/01/2031 10:05');
    expect(formatDate('2027-02-28')).toBe('28/02/2027');
  });

  it('keeps date-only and UTC-midnight values on their encoded calendar date', () => {
    expect(formatDate('2027-01-01')).toBe('01/01/2027');
    expect(formatDate('2027-01-01T00:00:00.000Z')).toBe('01/01/2027');
    expect(formatDate('2027-01-01T00:00:00+00:00')).toBe('01/01/2027');
  });

  it('formats non-midnight timestamps in the local timezone', () => {
    const value = '2027-01-01T03:00:00.000Z';
    expect(formatDate(value)).toBe(dayjs(value).format('DD/MM/YYYY'));
  });
});
