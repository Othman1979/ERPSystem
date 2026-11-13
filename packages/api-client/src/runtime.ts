/**
 * Hand-written runtime used by the orval-generated client (see orval.config.ts).
 * NOT generated — safe to edit. Generated files live in ./generated/.
 *
 * Contract (orval fetch client): resolves to `{ data, status, headers }`.
 * Adds: Bearer token injection, httpOnly-cookie credentials, a single
 * refresh-token retry on 401, a timeout on every request (WEB-05), and one
 * ApiError for every failure, including the ones that never reached the API
 * (WEB-06).
 */

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * orval mutator contract: the generated client calls `apiFetch<T>` where T is
 * the full response envelope type (`{ data, status, headers }`). We therefore
 * type the return as T while constructing that envelope at runtime. Callers
 * that want the raw body should use `apiFetchData`.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Codes the client gives failures that carry no API error envelope (WEB-06).
 * They are translated like the API's own codes (`errors.<CODE>` in the web).
 */
export const CLIENT_ERROR = {
  /** The request never got an answer: offline, DNS, connection refused or reset. Status 0. */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** No answer within the request's time limit. Status 0. */
  NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  /** A 502/503/504 without the API's envelope: the proxy answered because the API is down. */
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
  /** Any other answer the API would never send: HTML, plain text, JSON without the envelope. */
  INVALID_RESPONSE: 'INVALID_RESPONSE',
} as const;

/**
 * True only when the API itself could not be reached: no answer, no answer in
 * time, or the proxy's 502/503/504. An answer from something that did respond
 * (the API's own 5xx, an HTML 403 from a firewall) is not a connection error.
 */
export function isConnectionError(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    (err.code === CLIENT_ERROR.NETWORK_ERROR ||
      err.code === CLIENT_ERROR.NETWORK_TIMEOUT ||
      err.code === CLIENT_ERROR.SERVER_UNAVAILABLE)
  );
}

/**
 * Time limit of an ordinary API call, body included (WEB-05). Above the
 * server's 30 s posting transaction (POSTING_TX_OPTIONS) plus its lock waits,
 * so a slow post that succeeds is never reported as a timeout.
 */
export const REQUEST_TIMEOUT_MS = 60_000;
/** Time limit of a file download (PDF, XLSX, data export): the server builds the file first. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * `RequestInit` plus an optional time limit. `signal` (TanStack Query's, for
 * example) still cancels the request; the timeout applies on top of it.
 */
export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
}

/** A successful write (any method but GET/HEAD), as seen by `onApiWrite` listeners. */
export interface ApiWrite {
  method: string;
  /** Path under /api/v1, without the query string, e.g. `/accounts/123`. */
  path: string;
  status: number;
}

const API_PREFIX = '/api/v1';
const AUTH_PATHS = /\/auth\/(login|register|refresh|logout)/;
/** Name of the Web Lock that makes token refresh single-flight across tabs (WEB-14). */
const REFRESH_LOCK = 'erp-auth-refresh';

let accessToken: string | null = null;
// Branch picked in the top bar; sent as X-Branch-Id (checked by BranchGuard, ADR-003).
let branchId: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
const writeListeners = new Set<(write: ApiWrite) => void>();
const sessionListeners = new Set<() => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/** `sub:tid` of an access token (read only to compare sessions; the server verifies it). */
export function tokenSession(token: string | null): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/')) as string;
    const claims = JSON.parse(json) as { sub?: unknown; tid?: unknown };
    return `${String(claims.sub ?? '')}:${String(claims.tid ?? '')}`;
  } catch {
    return null;
  }
}

/**
 * Calls `listener` when a token refresh returns a different user or tenant
 * than the token it replaced: another tab switched tenant or signed in as
 * someone else, and the shared refresh cookie followed it. This tab's cached
 * data belongs to the old session. Returns the unsubscribe function.
 */
export function onSessionChange(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setBranchId(id: string | null): void {
  branchId = id;
}

export function getBranchId(): string | null {
  return branchId;
}

/**
 * Calls `listener` after every successful write through `apiFetch`, whichever
 * screen made it. The web uses it to expire cached reference data (WEB-13).
 * Returns the unsubscribe function.
 */
export function onApiWrite(listener: (write: ApiWrite) => void): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

function notifyWrite(method: string, url: string, status: number): void {
  const bare = url.split('?')[0];
  const path = bare.startsWith(API_PREFIX) ? bare.slice(API_PREFIX.length) || '/' : bare;
  for (const listener of writeListeners) {
    try {
      listener({ method, path, status });
    } catch {
      // A listener's bug must not fail a request that succeeded.
    }
  }
}

/** An AbortSignal that fires on the caller's signal or after `timeoutMs`, whichever comes first. */
interface Deadline {
  signal: AbortSignal;
  timedOut: () => boolean;
  /** Stops the timer and detaches from the caller's signal. */
  done: () => void;
}

function deadline(timeoutMs: number, outer?: AbortSignal | null): Deadline {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('The request timed out', 'TimeoutError'));
  }, timeoutMs);
  const onAbort = () => controller.abort(outer?.reason);
  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * The error a failed fetch or body read becomes. A cancellation by the caller
 * stays an AbortError (TanStack Query expects it); everything else that is not
 * already an ApiError is a network failure.
 */
function transportError(err: unknown, dl: Deadline, outer?: AbortSignal | null): unknown {
  if (err instanceof ApiError) return err;
  if (dl.timedOut()) return new ApiError(0, CLIENT_ERROR.NETWORK_TIMEOUT, 'The request timed out');
  if (outer?.aborted) return err;
  return new ApiError(0, CLIENT_ERROR.NETWORK_ERROR, err instanceof Error ? err.message : 'Network error');
}

function isEnvelope(data: unknown): data is ApiErrorBody {
  const error = (data as { error?: unknown } | null | undefined)?.error;
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

/** `text` as JSON, or `undefined` for an empty body; `{ ok: false }` when it is not JSON. */
function parseJson(text: string): { ok: true; data: unknown } | { ok: false } {
  if (!text) return { ok: true, data: undefined };
  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * An error response as an ApiError: the API's envelope when there is one;
 * otherwise the answer came from something in front of the API (WEB-06).
 */
interface StatusLine {
  status: number;
  statusText: string;
}

function apiError(response: StatusLine, data: unknown): ApiError {
  if (isEnvelope(data)) {
    return new ApiError(
      response.status,
      data.error.code,
      data.error.message ?? response.statusText,
      data.error.details,
      data.error.requestId,
    );
  }
  const gateway = response.status >= 502 && response.status <= 504;
  const code = gateway ? CLIENT_ERROR.SERVER_UNAVAILABLE : CLIENT_ERROR.INVALID_RESPONSE;
  return new ApiError(response.status, code, response.statusText || `HTTP ${response.status}`);
}

/** One POST /auth/refresh: true with a new access token, false when the session is over. */
async function postRefresh(): Promise<boolean> {
  const post = async (): Promise<StatusLine & { ok: boolean; text: string }> => {
    const dl = deadline(REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        signal: dl.signal,
      });
      // The body is read under the same deadline; it is small.
      return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text() };
    } catch (err) {
      throw transportError(err, dl);
    } finally {
      dl.done();
    }
  };
  let res = await post();
  // Another tab (or a browser without Web Locks) may have rotated the same
  // cookie a moment earlier: the server answers 401 without ending the session,
  // and the cookie jar now holds the winner's token, so one retry succeeds
  // (ADR-012). The pause lets the winner's Set-Cookie land first.
  if (res.status === 401) {
    await new Promise((r) => setTimeout(r, 500));
    res = await post();
  }
  const parsed = parseJson(res.text);
  if (!res.ok) {
    // The server answered no: the session is over. Only an API that could not
    // be reached (network, timeout, proxy 502–504) says nothing about the
    // session, and is thrown as it is.
    const err = apiError(res, parsed.ok ? parsed.data : undefined);
    if (isConnectionError(err)) throw err;
    return false;
  }
  const body = (parsed.ok ? parsed.data : undefined) as { accessToken?: string } | undefined;
  if (body?.accessToken) {
    const before = tokenSession(accessToken);
    accessToken = body.accessToken;
    const after = tokenSession(accessToken);
    if (before !== null && after !== before) {
      for (const listener of sessionListeners) {
        try {
          listener();
        } catch {
          // A listener's bug must not fail the refresh.
        }
      }
    }
    return true;
  }
  return false;
}

/**
 * Called on 401: rotates the refresh cookie once. Deduplicated within the tab
 * by `refreshPromise`, and across tabs by a Web Lock where the browser has
 * them, so two tabs never present the same cookie at once (WEB-14).
 * Rejects with a connection ApiError when the server could not be reached.
 */
function tryRefresh(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      return locks ? await locks.request(REFRESH_LOCK, postRefresh) : await postRefresh();
    } finally {
      // Allow a later retry cycle after this one settles.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();
  return refreshPromise;
}

/** `promise`, or a rejection with the signal's reason as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Sends one API request with auth and branch headers; on 401 refreshes once and retries. */
async function send(url: string, init: RequestInit): Promise<Response> {
  const doFetch = (): Promise<Response> => {
    const headers = new Headers(init.headers);
    // FormData (file uploads) sets its own multipart type with the boundary.
    if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    if (accessToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${accessToken}`);
    }
    if (branchId && !headers.has('X-Branch-Id')) {
      headers.set('X-Branch-Id', branchId);
    }
    return fetch(url, { ...init, headers, credentials: 'include' });
  };

  let response = await doFetch();

  if (response.status === 401 && !AUTH_PATHS.test(url)) {
    // The refresh is shared with other requests, so it is not cancelled; this
    // request just stops waiting for it at its own deadline or cancellation.
    if (await untilAborted(tryRefresh(), init.signal)) {
      response = await doFetch();
    }
  }
  return response;
}

function apiUrl(path: string): string {
  return path.startsWith('/api/') ? path : `${API_PREFIX}${path}`;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal: outer, ...rest } = init;
  const url = apiUrl(path);
  const method = (rest.method ?? 'GET').toUpperCase();
  const dl = deadline(timeoutMs, outer);
  try {
    const response = await send(url, { ...rest, signal: dl.signal });

    if (response.status === 204) {
      if (method !== 'GET' && method !== 'HEAD') notifyWrite(method, url, 204);
      return { data: undefined, status: 204, headers: response.headers } as T;
    }

    const parsed = parseJson(await response.text());

    if (!response.ok) {
      throw apiError(response, parsed.ok ? parsed.data : undefined);
    }
    if (!parsed.ok) {
      // A 200 that is not JSON: a captive portal, or a host page in front of the API.
      throw new ApiError(response.status, CLIENT_ERROR.INVALID_RESPONSE, 'The server response is not JSON');
    }

    if (method !== 'GET' && method !== 'HEAD') notifyWrite(method, url, response.status);
    return { data: parsed.data, status: response.status, headers: response.headers } as T;
  } catch (err) {
    throw transportError(err, dl, outer);
  } finally {
    dl.done();
  }
}

export interface ApiFile {
  blob: Blob;
  /** From Content-Disposition; null when the server sent none (or it isn't readable). */
  filename: string | null;
}

/** File name from a Content-Disposition header (`filename*=UTF-8''…` preferred over `filename=`). */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      // Malformed escape: fall back to the plain filename parameter.
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(header);
  const name = plain ? (plain[2] ?? plain[1]).trim() : '';
  return name || null;
}

/**
 * Binary download (PDF / XLSX exports, printed documents) with the same auth,
 * branch and refresh handling as `apiFetch`, and a longer time limit
 * (DOWNLOAD_TIMEOUT_MS). Error responses still carry the JSON envelope and
 * throw the same ApiError.
 */
export async function apiFetchBlob(path: string, init: ApiRequestInit = {}): Promise<ApiFile> {
  const { timeoutMs = DOWNLOAD_TIMEOUT_MS, signal: outer, ...rest } = init;
  const dl = deadline(timeoutMs, outer);
  try {
    const response = await send(apiUrl(path), { ...rest, signal: dl.signal });
    if (!response.ok) {
      const parsed = parseJson(await response.text());
      throw apiError(response, parsed.ok ? parsed.data : undefined);
    }
    return {
      blob: await response.blob(),
      filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
    };
  } catch (err) {
    throw transportError(err, dl, outer);
  } finally {
    dl.done();
  }
}

/** Convenience for hand-written callers: resolves to the response body only. */
export async function apiFetchData<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const res = (await apiFetch(path, init)) as unknown as ApiResponse<T>;
  return res.data;
}
