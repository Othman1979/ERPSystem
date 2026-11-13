import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const report = vi.fn<(body: unknown) => Promise<unknown>>(() => Promise.resolve({}));
let token: string | null = 'access-token';

vi.mock('@erp/api-client', () => {
  class ApiError extends Error {}
  return {
    ApiError,
    clientErrorsControllerReport: (body: unknown) => report(body),
    getAccessToken: () => token,
  };
});

const { ApiError } = (await import('@erp/api-client')) as unknown as { ApiError: new (m: string) => Error };
const { MAX_REPORTS, reportError, resetErrorReporting } = await import('./errorReporting');

describe('reportError (ADR-010 §10.3)', () => {
  beforeEach(() => {
    report.mockClear();
    resetErrorReporting();
    token = 'access-token';
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends an error of a signed-in user with its page, not the query string', () => {
    window.history.pushState({}, '', '/reports?tab=gl&token=x');
    reportError(new TypeError('cannot read lines'));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ name: 'TypeError', message: 'cannot read lines', page: '/reports' });
  });

  it('sends each kind once, and at most MAX_REPORTS per page load', () => {
    reportError(new Error('same'));
    reportError(new Error('same'));
    expect(report).toHaveBeenCalledTimes(1);
    for (let i = 0; i < MAX_REPORTS + 3; i++) reportError(new Error(`other ${i}`));
    expect(report).toHaveBeenCalledTimes(MAX_REPORTS);
  });

  it('stays quiet when signed out, for API errors and for browser noise', () => {
    token = null;
    reportError(new Error('before sign-in'));
    token = 'access-token';
    reportError(new ApiError('the server said no'));
    reportError(new Error('ResizeObserver loop completed with undelivered notifications.'));
    reportError('Script error.');
    expect(report).not.toHaveBeenCalled();
  });

  it('never throws, even when sending fails', async () => {
    report.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    expect(() => reportError(new Error('while offline'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
