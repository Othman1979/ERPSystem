import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@erp/api-client';
import i18n from '../i18n';
import { createErrorDeduper, QueryEmpty, queryErrorMessage } from './QueryState';

const ok = { isError: false, isFetching: false, error: null, refetch: () => undefined };

describe('QueryEmpty (WEB-03)', () => {
  it('shows the empty state for a successful, empty result', () => {
    const html = renderToStaticMarkup(<QueryEmpty query={ok} empty={<span>nothing here</span>} />);
    expect(html).toContain('nothing here');
    expect(html).not.toContain(i18n.t('common.retry'));
  });

  it('shows the failure and a retry button instead of "no data" when the query failed', () => {
    const failed = { ...ok, isError: true, error: new TypeError('Failed to fetch') };
    const html = renderToStaticMarkup(<QueryEmpty query={failed} empty={<span>nothing here</span>} />);
    expect(html).not.toContain('nothing here');
    expect(html).toContain(i18n.t('common.loadFailed'));
    expect(html).toContain(i18n.t('common.networkError'));
    expect(html).toContain(i18n.t('common.retry'));
  });
});

describe('queryErrorMessage', () => {
  it('translates a known API error code', () => {
    const err = new ApiError(403, 'INTERNAL', 'raw');
    expect(queryErrorMessage(err, i18n.t)).toBe(i18n.t('errors.INTERNAL'));
  });

  it('reports a proxy 502 as an unreachable server', () => {
    const err = new ApiError(502, 'INTERNAL', 'Bad Gateway');
    expect(queryErrorMessage(err, i18n.t)).toBe(i18n.t('common.networkError'));
  });

  it('falls back to the server message for an unknown code', () => {
    const err = new ApiError(400, 'SOME_NEW_CODE', 'server says no');
    expect(queryErrorMessage(err, i18n.t)).toBe('server says no');
  });
});

describe('createErrorDeduper', () => {
  it('shows the same message once per window', () => {
    const shouldShow = createErrorDeduper(5000);
    expect(shouldShow('down', 0)).toBe(true);
    expect(shouldShow('down', 100)).toBe(false);
    expect(shouldShow('other', 100)).toBe(true);
    expect(shouldShow('down', 5001)).toBe(true);
  });
});
