// @vitest-environment jsdom
import { ApiError } from '@erp/api-client';
import { describe, expect, it } from 'vitest';
import { KEYSET_STALE_MS, keysetRetry } from './useKeysetQuery';

describe('keysetRetry (W6: a refused cursor is not retried)', () => {
  it('does not retry a 4xx refusal, such as CURSOR_INVALID or a forbidden branch', () => {
    expect(keysetRetry(0, new ApiError(400, 'CURSOR_INVALID', 'stale cursor'))).toBe(false);
    expect(keysetRetry(0, new ApiError(403, 'FORBIDDEN', 'refused'))).toBe(false);
  });

  it('retries any other failure once', () => {
    expect(keysetRetry(0, new ApiError(500, 'INTERNAL', 'boom'))).toBe(true);
    expect(keysetRetry(0, new Error('network down'))).toBe(true);
    expect(keysetRetry(1, new Error('network down'))).toBe(false);
  });

  it('keeps the pages fresh for minutes, not on every focus of the window', () => {
    expect(KEYSET_STALE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
