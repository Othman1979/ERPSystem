/**
 * Hand-written runtime used by the orval-generated client (see orval.config.ts).
 * NOT generated — safe to edit. Generated files live in ./generated/.
 *
 * Contract (orval fetch client): resolves to `{ data, status, headers }`.
 * Adds: Bearer token injection, httpOnly-cookie credentials, and a single
 * refresh-token retry on 401.
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

const API_PREFIX = '/api/v1';
const AUTH_PATHS = /\/auth\/(login|register|refresh|logout)/;

let accessToken: string | null = null;
// Branch picked in the top bar; sent as X-Branch-Id (checked by BranchGuard, ADR-003).
let branchId: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
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

/** Called by the app on 401: rotates the refresh cookie once (deduped). */
async function tryRefresh(): Promise<boolean> {
  refreshPromise ??= (async () => {
    try {
      const res = await fetch(`${API_PREFIX}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken?: string };
      if (body.accessToken) {
        accessToken = body.accessToken;
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      // Allow a later retry cycle after this one settles.
      setTimeout(() => {
        refreshPromise = null;
      }, 0);
    }
  })();
  return refreshPromise;
}

/** Sends one API request with auth and branch headers; on 401 refreshes once and retries. */
async function send(path: string, init: RequestInit): Promise<Response> {
  const url = path.startsWith('/api/') ? path : `${API_PREFIX}${path}`;
  const doFetch = (): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) {
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
    if (await tryRefresh()) {
      response = await doFetch();
    }
  }
  return response;
}

/** The API's error envelope (or the bare status when the body has none) as an ApiError. */
function apiError(response: Response, data: unknown): ApiError {
  const body = data as ApiErrorBody | undefined;
  return new ApiError(
    response.status,
    body?.error?.code ?? 'INTERNAL',
    body?.error?.message ?? response.statusText,
    body?.error?.details,
    body?.error?.requestId,
  );
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await send(path, init);

  if (response.status === 204) {
    return { data: undefined, status: 204, headers: response.headers } as T;
  }

  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;

  if (!response.ok) {
    throw apiError(response, data);
  }

  return { data, status: response.status, headers: response.headers } as T;
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
 * branch and refresh handling as `apiFetch`. Error responses still carry the
 * JSON envelope and throw the same ApiError.
 */
export async function apiFetchBlob(path: string, init: RequestInit = {}): Promise<ApiFile> {
  const response = await send(path, init);
  if (!response.ok) {
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    throw apiError(response, data);
  }
  return {
    blob: await response.blob(),
    filename: filenameFromDisposition(response.headers.get('Content-Disposition')),
  };
}

/** Convenience for hand-written callers: resolves to the response body only. */
export async function apiFetchData<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = (await apiFetch(path, init)) as unknown as ApiResponse<T>;
  return res.data;
}
