import {
  ApiError,
  apiFetch,
  apiFetchBlob,
  CLIENT_ERROR,
  DOWNLOAD_TIMEOUT_MS,
  isConnectionError,
  onApiWrite,
  REQUEST_TIMEOUT_MS,
  setAccessToken,
  type ApiWrite,
} from '@erp/api-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Tests for the hand-written api-client runtime (packages/api-client/src/runtime.ts):
// error classification (WEB-06), timeouts and cancellation (WEB-05), the
// refresh retry, and write notifications (WEB-13).

type Handler = (url: string, init: RequestInit) => Promise<Response> | Response;
let handler: Handler;
const calls: { url: string; init: RequestInit }[] = [];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const html = (status: number) =>
  new Response('<html><body>502 Bad Gateway</body></html>', { status, headers: { 'Content-Type': 'text/html' } });

/** A fetch that never answers, but rejects like the browser's when its signal aborts. */
function hang(_url: string, init: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init.signal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')));
  });
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to fail');
}

beforeEach(async () => {
  // Let the previous test's refresh cycle reset (the runtime clears it on the next tick).
  await new Promise((r) => setTimeout(r, 0));
  calls.length = 0;
  setAccessToken(null);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('api-client runtime: error classification (WEB-06)', () => {
  it('keeps the code of the API error envelope', async () => {
    handler = () => json(409, { error: { code: 'PERIOD_CLOSED', message: 'closed', requestId: 'r1' } });
    const err = await caught(apiFetch('/journal-entries/1/post', { method: 'POST' }));
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: 'PERIOD_CLOSED', requestId: 'r1' });
    expect(isConnectionError(err)).toBe(false);
  });

  it('turns a rejected fetch (offline) into NETWORK_ERROR with status 0', async () => {
    handler = () => {
      throw new TypeError('Failed to fetch');
    };
    const err = await caught(apiFetch('/parties'));
    expect(err).toMatchObject({ status: 0, code: CLIENT_ERROR.NETWORK_ERROR });
    expect(isConnectionError(err)).toBe(true);
  });

  it.each([502, 503, 504, 500])('turns an HTML %i from a proxy into SERVER_UNAVAILABLE', async (status) => {
    handler = () => html(status);
    const err = await caught(apiFetch('/parties'));
    expect(err).toMatchObject({ status, code: CLIENT_ERROR.SERVER_UNAVAILABLE });
    expect(isConnectionError(err)).toBe(true);
  });

  it('turns a 200 that is not JSON into INVALID_RESPONSE', async () => {
    handler = () => html(200);
    expect(await caught(apiFetch('/parties'))).toMatchObject({ status: 200, code: CLIENT_ERROR.INVALID_RESPONSE });
  });

  it('turns a 4xx without the envelope into INVALID_RESPONSE', async () => {
    handler = () => new Response('Request Entity Too Large', { status: 413 });
    expect(await caught(apiFetch('/sales-invoices', { method: 'POST', body: '{}' }))).toMatchObject({
      status: 413,
      code: CLIENT_ERROR.INVALID_RESPONSE,
    });
  });

  it('turns a non-JSON error on a file download into the same codes', async () => {
    handler = () => html(502);
    expect(await caught(apiFetchBlob('/reports/trial-balance?format=pdf'))).toMatchObject({
      code: CLIENT_ERROR.SERVER_UNAVAILABLE,
    });
  });

  it('still resolves 204 and empty bodies', async () => {
    handler = () => new Response(null, { status: 204 });
    await expect(apiFetch('/branches/1', { method: 'DELETE' })).resolves.toMatchObject({ status: 204 });
    handler = () => new Response('', { status: 200 });
    await expect(apiFetch('/x')).resolves.toMatchObject({ status: 200, data: undefined });
  });
});

describe('api-client runtime: timeout and cancellation (WEB-05)', () => {
  it('gives up after REQUEST_TIMEOUT_MS with NETWORK_TIMEOUT', async () => {
    vi.useFakeTimers();
    handler = hang;
    const result = caught(apiFetch('/parties'));
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(calls[0].init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ status: 0, code: CLIENT_ERROR.NETWORK_TIMEOUT });
  });

  it('honours a shorter timeoutMs', async () => {
    vi.useFakeTimers();
    handler = hang;
    const result = caught(apiFetch('/parties', { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: CLIENT_ERROR.NETWORK_TIMEOUT });
  });

  it('gives file downloads the longer DOWNLOAD_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    handler = hang;
    let settled = false;
    const result = caught(apiFetchBlob('/reports/trial-balance?format=xlsx')).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
    expect(await result).toMatchObject({ code: CLIENT_ERROR.NETWORK_TIMEOUT });
  });

  it("passes the caller's signal through and leaves its cancellation an AbortError", async () => {
    handler = hang;
    const controller = new AbortController();
    const result = caught(apiFetch('/parties', { signal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const err = await result;
    expect(err).not.toBeInstanceOf(ApiError);
    expect((err as DOMException).name).toBe('AbortError');
    expect(calls[0].init.signal?.aborted).toBe(true);
  });

  it('clears its timer once the response is in', async () => {
    vi.useFakeTimers();
    handler = () => json(200, { ok: true });
    await apiFetch('/parties');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('api-client runtime: token refresh on 401', () => {
  it('refreshes once and retries the request with the new token', async () => {
    setAccessToken('old');
    handler = (url, init) => {
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'new' });
      const auth = new Headers(init.headers).get('Authorization');
      return auth === 'Bearer new' ? json(200, [{ id: '1' }]) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    };
    await expect(apiFetch('/parties')).resolves.toMatchObject({ status: 200, data: [{ id: '1' }] });
    expect(calls.map((c) => c.url)).toEqual(['/api/v1/parties', '/api/v1/auth/refresh', '/api/v1/parties']);
  });

  it('shares one refresh between requests that fail together', async () => {
    setAccessToken('old');
    handler = (url, init) => {
      if (url.endsWith('/auth/refresh')) return json(200, { accessToken: 'new' });
      const auth = new Headers(init.headers).get('Authorization');
      return auth === 'Bearer new' ? json(200, []) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    };
    await Promise.all([apiFetch('/parties'), apiFetch('/items'), apiFetch('/accounts')]);
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(1);
  });

  it('reports a server that cannot be reached during the refresh as a connection error, not a 401', async () => {
    setAccessToken('old');
    handler = (url) => (url.endsWith('/auth/refresh') ? html(502) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } }));
    expect(await caught(apiFetch('/parties'))).toMatchObject({ code: CLIENT_ERROR.SERVER_UNAVAILABLE });
  });

  it('stops waiting for a stalled refresh at its own deadline', async () => {
    vi.useFakeTimers();
    setAccessToken('old');
    handler = (url, init) =>
      url.endsWith('/auth/refresh') ? hang(url, init) : json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    const result = caught(apiFetch('/parties', { timeoutMs: 1000 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: CLIENT_ERROR.NETWORK_TIMEOUT });
    // Let the shared refresh time out too, so the next test starts clean.
    await vi.advanceTimersByTimeAsync(2 * REQUEST_TIMEOUT_MS + 1000);
  });

  it('returns the 401 when the API refuses the refresh', async () => {
    vi.useFakeTimers();
    setAccessToken('old');
    handler = () => json(401, { error: { code: 'UNAUTHORIZED', message: 'x' } });
    const result = caught(apiFetch('/parties'));
    // The refresh is retried once after 500 ms (another tab may have just rotated the cookie).
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(calls.filter((c) => c.url.endsWith('/auth/refresh'))).toHaveLength(2);
  });
});

describe('api-client runtime: write notifications (WEB-13)', () => {
  it('reports successful writes with the path under /api/v1, and nothing for reads or failures', async () => {
    const writes: ApiWrite[] = [];
    const off = onApiWrite((w) => writes.push(w));
    try {
      handler = () => json(201, { id: '9' });
      await apiFetch('/cash-boxes?x=1', { method: 'POST', body: '{}' });
      handler = () => json(200, []);
      await apiFetch('/accounts');
      handler = () => json(409, { error: { code: 'CONFLICT', message: 'x' } });
      await caught(apiFetch('/accounts', { method: 'POST', body: '{}' }));
      handler = () => new Response(null, { status: 204 });
      await apiFetch('/api/v1/branches/3', { method: 'DELETE' });
    } finally {
      off();
    }
    expect(writes).toEqual([
      { method: 'POST', path: '/cash-boxes', status: 201 },
      { method: 'DELETE', path: '/branches/3', status: 204 },
    ]);
  });
});
