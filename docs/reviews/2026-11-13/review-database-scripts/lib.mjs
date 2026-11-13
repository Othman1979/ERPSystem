// Shared HTTP client for the data-generation scripts (scratchpad only).
import { randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = 'http://localhost:3671/api/v1';
export const DIR = path.dirname(fileURLToPath(import.meta.url));
const CREDS = path.join(DIR, 'creds.json');
const PROGRESS = path.join(DIR, 'progress.log');
const ERRORS = path.join(DIR, 'errors.log');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function logLine(file, msg) {
  fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
}
export const progress = (msg) => logLine(PROGRESS, msg);
export const errorLog = (msg) => logLine(ERRORS, msg);

export function randomPassword() {
  // 24 chars, letters + digits + symbol; never printed.
  return randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, 'x') + '!Aa1';
}

export function loadCreds() {
  return JSON.parse(fs.readFileSync(CREDS, 'utf8'));
}
export function saveCreds(obj) {
  fs.writeFileSync(CREDS, JSON.stringify(obj, null, 2));
}

const state = { access: null, refresh: null };
export function setSession({ accessToken, refresh }) {
  if (accessToken) state.access = accessToken;
  if (refresh) state.refresh = refresh;
}

function readRefreshCookie(res) {
  const cookies = res.headers.getSetCookie?.() ?? [];
  for (const c of cookies) {
    const m = /^refresh_token=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  return null;
}

async function raw(method, url, { body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, text, json, res };
}

async function refreshSession() {
  if (!state.refresh) return false;
  const r = await raw('POST', `${BASE}/auth/refresh`, {
    headers: { Cookie: `refresh_token=${state.refresh}` },
  });
  if (r.status !== 200 || !r.json?.accessToken) return false;
  const rt = readRefreshCookie(r.res);
  setSession({ accessToken: r.json.accessToken, refresh: rt });
  return true;
}

/**
 * Call the API. Returns { status, json, text }.
 * - Adds Bearer token; on 401 tries one refresh and retries.
 * - On 429 waits 65 s and retries (up to 5 times).
 * - On 5xx / network errors retries up to 3 times with backoff.
 * - Never throws for HTTP errors; the caller decides.
 */
export async function api(method, p, { body, idem = false, branchId } = {}) {
  let refreshed = false;
  // One key per logical request, reused across retries.
  const idemKey = idem ? randomUUID() : null;
  for (let attempt = 0, net = 0, rl = 0; ; attempt++) {
    const headers = {};
    if (state.access) headers.Authorization = `Bearer ${state.access}`;
    if (idemKey) headers['Idempotency-Key'] = idemKey;
    if (branchId) headers['X-Branch-Id'] = String(branchId);
    let r;
    try {
      r = await raw(method, `${BASE}${p}`, { body, headers });
    } catch (e) {
      if (net++ < 3) {
        await sleep(500 * net);
        continue;
      }
      return { status: 0, json: null, text: `NETWORK ${e.message}` };
    }
    if (r.status === 401 && !refreshed && state.refresh) {
      refreshed = true;
      if (await refreshSession()) continue;
    }
    if (r.status === 429 && rl++ < 5) {
      progress(`429 on ${method} ${p}; waiting 65s`);
      await sleep(65_000);
      continue;
    }
    if (r.status >= 500 && net++ < 3) {
      await sleep(500 * net);
      continue;
    }
    return { status: r.status, json: r.json, text: r.text };
  }
}

export function short(text, n = 300) {
  return (text ?? '').replace(/\s+/g, ' ').slice(0, n);
}
