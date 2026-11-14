import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { codeExpiry } from './InvitationsPage';

describe('invitation code expiry cell', () => {
  const now = dayjs('2026-11-14T12:00:00Z');

  it('shows nothing (a dash) when no code is pending, instead of "Invalid Date"', () => {
    expect(codeExpiry(null, now)).toBeNull();
  });

  it('marks a past expiry as expired and a future one as valid', () => {
    expect(codeExpiry('2026-11-14T11:00:00.000Z', now)).toEqual({ at: '2026-11-14T11:00:00.000Z', expired: true });
    expect(codeExpiry('2026-11-15T11:00:00.000Z', now)).toEqual({ at: '2026-11-15T11:00:00.000Z', expired: false });
  });
});
