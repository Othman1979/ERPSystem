import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from './date';

describe('date formatting', () => {
  it('formats dates as DD/MM/YYYY and date-times with 24-hour time', () => {
    const value = '2031-01-01T10:05:00';

    expect(formatDate(value)).toBe('01/01/2031');
    expect(formatDateTime(value)).toBe('01/01/2031 10:05');
  });
});
