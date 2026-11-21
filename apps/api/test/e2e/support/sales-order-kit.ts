/**
 * Shared plumbing of the phase 14 part B specs (golden-sales-orders and
 * phase14-invoicing): boots the built API on a port against the test database,
 * and the small request helpers every scenario uses. Real MariaDB (E2E_DB_NAME).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './test-db.js';

export const PASS = 'test-password-123';
export const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);

export interface Booted {
  server: ChildProcess;
  db: Connection;
  base: string;
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await request(base).get('/api/v1/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Starts dist/main.js on `port` and opens a direct database connection for assertions. */
export async function bootApi(port: number, auditFile?: string): Promise<Booted> {
  const databaseUrl = testDatabaseUrl();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(port),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
      ...(auditFile ? { OPENAPI_RESPONSE_AUDIT: auditFile } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const url = new URL(databaseUrl);
  const db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: TEST_DB_NAME,
  });
  await waitForHealth(base);
  return { server, db, base };
}

export async function stopApi(b: Booted | undefined): Promise<void> {
  if (!b) return;
  b.server.kill('SIGTERM');
  await once(b.server, 'exit').catch(() => undefined);
  await b.db.end();
}

/** Request helpers bound to one API base and one run tag. */
export function kit(base: string, run: string) {
  const api = () => request(base);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const idem = (key = `p14b-${run}-${Math.random().toString(36).slice(2)}`) => ({ 'Idempotency-Key': key });
  const act = (token: string, p: string, body: object = {}, key?: string) =>
    api().post(`/api/v1/${p}`).set(auth(token)).set(idem(key)).send(body);
  const acquireLock = async (
    token: string,
    docType: 'JOURNAL_ENTRY' | 'RECEIPT' | 'PAYMENT' | 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    id: string,
    holderToken = randomUUID(),
  ) => {
    const response = await api()
      .post(`/api/v1/document-locks/${docType}/${id}/acquire`)
      .set(auth(token))
      .set('X-Edit-Lock', holderToken);
    return { holderToken, response };
  };
  const actLocked = async (
    token: string,
    docType: 'JOURNAL_ENTRY' | 'RECEIPT' | 'PAYMENT' | 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    id: string,
    p: string,
    body: object = {},
    key?: string,
  ) => {
    const { holderToken, response: acquired } = await acquireLock(token, docType, id);
    if (acquired.status !== 201) {
      throw new Error(`acquire ${docType} ${id} → ${acquired.status} ${JSON.stringify(acquired.body)}`);
    }
    const response = await api()
      .post(`/api/v1/${p}`)
      .set(auth(token))
      .set('X-Edit-Lock', holderToken)
      .set(idem(key))
      .send(body);
    if (response.status < 200 || response.status >= 300) {
      await api()
        .delete(`/api/v1/document-locks/${docType}/${id}`)
        .set(auth(token))
        .set('X-Edit-Lock', holderToken);
    }
    return response;
  };
  const updateLocked = async (
    token: string,
    docType: 'SALES_INVOICE' | 'PURCHASE_INVOICE',
    id: string,
    body: object,
  ) => {
    const { holderToken, response: acquired } = await acquireLock(token, docType, id);
    if (acquired.status !== 201) {
      throw new Error(`acquire ${docType} ${id} → ${acquired.status} ${JSON.stringify(acquired.body)}`);
    }
    const path = docType === 'SALES_INVOICE' ? 'sales-invoices' : 'purchase-invoices';
    const response = await api()
      .put(`/api/v1/${path}/${id}`)
      .set(auth(token))
      .set('X-Edit-Lock', holderToken)
      .send(body);
    if (response.status < 200 || response.status >= 300) {
      await api()
        .delete(`/api/v1/document-locks/${docType}/${id}`)
        .set(auth(token))
        .set('X-Edit-Lock', holderToken);
    }
    return response;
  };
  const get = (token: string, p: string) => api().get(`/api/v1/${p}`).set(auth(token));
  const patchCompany = (token: string, body: object) => api().patch('/api/v1/company').set(auth(token)).send(body);
  const err = (res: request.Response): [number, string | undefined] => [res.status, res.body?.error?.code];
  /** Expects a status and returns the body, showing the response on failure. */
  const ok = (res: request.Response, status: number, what: string) => {
    if (res.status !== status) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  return { api, auth, idem, act, acquireLock, actLocked, updateLocked, get, patchCompany, err, ok };
}
