/**
 * Phase 10.3 — error monitoring (ADR-010 §10.3):
 *  - a server fault answers a generic 500 and is recorded once per kind,
 *    counted, with its tenant, user and path, secrets redacted;
 *  - the platform console lists and shows errors (platform admins only),
 *    resolves them, and a new occurrence reopens one;
 *  - the web app reports errors of signed-in users (validated, redacted);
 *  - a failed Cron command is recorded as a JOB error;
 *  - error-digest posts what is new to the webhook once, keeps it pending
 *    when the webhook fails, and never prints the webhook address.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3216;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

type ErrorRow = {
  id: bigint;
  source: string;
  message: string;
  stack: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  tenant_id: bigint | null;
  user_id: bigint | null;
  count: number;
  resolved_at: Date | null;
  notified_at: Date | null;
};

async function errorRow(where: string, params: unknown[]): Promise<ErrorRow | undefined> {
  const rows = (await db.query(`SELECT * FROM error_events WHERE ${where} ORDER BY last_seen_at DESC LIMIT 1`, params)) as ErrorRow[];
  return rows[0];
}

/**
 * Makes the boom error pending for the digest again. A repeat request would
 * do it too, but the recorder writes one kind at most 5 times per 10 s, and
 * on a fast runner a sixth boom inside that window is only counted.
 */
async function markBoomPending(): Promise<void> {
  await db.query("UPDATE error_events SET notified_at = NULL WHERE source = 'API' AND message LIKE 'boom %'");
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Runs a CLI job against erp_test; a non-zero exit is returned, not thrown. */
async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', ['dist/jobs/cli.js', ...args], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The recorder does not hold up the answer: give it a moment. */
const settle = () => new Promise((r) => setTimeout(r, 400));

beforeAll(async () => {
  databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: 'erp_test',
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await db?.end();
});

describe('Phase 10.3 — error monitoring', () => {
  let token = '';
  let tenantId = '';
  let admin = '';

  it('setup: a company owner, and a platform admin', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `ERR ${RUN}`, ownerName: 'Owner', email: `err-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    tenantId = String((await api().get('/api/v1/me').set(auth(token))).body.currentTenant.tenantId);

    const adminEmail = `err-admin-${RUN}@test.dev`;
    const second = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `ERR admin ${RUN}`, ownerName: 'Admin', email: adminEmail, password: PASS });
    admin = second.body.accessToken;
    expect((await cli(['grant-platform-admin', adminEmail])).code).toBe(0);
  }, 60_000);

  it('a server fault answers a generic 500 and is recorded once per kind, redacted', async () => {
    const before = await errorRow("source = 'API' AND message LIKE 'boom %'", []);
    const res = await api().get('/api/v1/__test/boom').set(auth(token));
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'INTERNAL', message: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    await settle();

    const row = (await errorRow("source = 'API' AND message LIKE 'boom %'", []))!;
    expect(row).toMatchObject({
      message: 'boom password=[redacted] for invoice 42',
      method: 'GET',
      path: '/api/v1/__test/boom',
      status: 500,
      resolved_at: null,
    });
    expect(String(row.tenant_id)).toBe(tenantId);
    expect(row.user_id).not.toBeNull();
    expect(row.stack).toContain('TypeError');
    expect(row.stack).not.toContain('hunter2');
    expect(row.count).toBe((before?.count ?? 0) + 1);

    // The same fault again: the same row, counted.
    await api().get('/api/v1/__test/boom').set(auth(token));
    await settle();
    const again = (await errorRow('id = ?', [row.id]))!;
    expect(again.count).toBe(row.count + 1);
  });

  it('the console lists and shows errors to platform admins only; resolving, then a recurrence reopens', async () => {
    const row = (await errorRow("source = 'API' AND message LIKE 'boom %'", []))!;
    const id = String(row.id);
    expect((await api().get('/api/v1/admin/errors').set(auth(token))).status).toBe(403);
    expect((await api().get(`/api/v1/admin/errors/${id}`).set(auth(token))).status).toBe(403);

    const list = await api().get('/api/v1/admin/errors').set(auth(admin));
    expect(list.status).toBe(200);
    const listed = (list.body as { id: string; stack?: string; count: number }[]).find((e) => e.id === id)!;
    expect(listed).toBeDefined();
    expect(listed.stack).toBeUndefined(); // the list stays light; the detail has it
    const detail = await api().get(`/api/v1/admin/errors/${id}`).set(auth(admin));
    expect(detail.body.stack).toContain('TypeError');
    expect(detail.body.tenantId).toBe(tenantId);

    const resolved = await api().post(`/api/v1/admin/errors/${id}/resolve`).set(auth(admin));
    expect(resolved.status).toBe(201);
    expect(resolved.body.resolvedAt).not.toBeNull();
    const open = (await api().get('/api/v1/admin/errors?status=open').set(auth(admin))).body as { id: string }[];
    expect(open.some((e) => e.id === id)).toBe(false);
    expect((await api().get('/api/v1/admin/errors?status=bogus').set(auth(admin))).status).toBe(400);

    await api().get('/api/v1/__test/boom').set(auth(token));
    await settle();
    const reopened = (await errorRow('id = ?', [row.id]))!;
    expect([reopened.resolved_at, reopened.count]).toEqual([null, row.count + 1]);
  });

  it('the web app reports errors of signed-in users, validated and redacted', async () => {
    const message = `web boom ${RUN} token=abc123`;
    const res = await api()
      .post('/api/v1/client-errors')
      .set(auth(token))
      .send({ name: 'TypeError', message, stack: `TypeError: ${message}\n    at render (app.js:1:2)`, page: '/reports?tab=gl&token=x' });
    expect(res.status).toBe(204);
    await settle();
    const row = (await errorRow("source = 'WEB' AND message LIKE ?", [`web boom ${RUN}%`]))!;
    expect(row).toMatchObject({ message: `web boom ${RUN} token=[redacted]`, path: '/reports', method: null, status: null });
    expect(String(row.tenant_id)).toBe(tenantId);

    expect((await api().post('/api/v1/client-errors').send({ message: 'x' })).status).toBe(401);
    expect((await api().post('/api/v1/client-errors').set(auth(token)).send({ message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await api().post('/api/v1/client-errors').set(auth(token)).send({ message: 'x', tenantId: '1' })).status).toBe(400);
  });

  it('a failed Cron command is recorded as a JOB error', async () => {
    const run = await cli(['backup'], { MYSQLDUMP_PATH: path.join(API_DIR, `no-such-mysqldump-${RUN}`), BACKUP_DIR: path.join(os.tmpdir(), `erp-err-${RUN}`) });
    expect(run.code).toBe(1);
    const row = (await errorRow("source = 'JOB' AND path = 'backup' AND message LIKE ?", [`%no-such-mysqldump-${RUN}%`]))!;
    expect(row).toBeDefined();
    expect(row.message).toMatch(/^Cannot run/);
  }, 60_000);

  describe('error-digest', () => {
    let hook: Server;
    const received: { text?: string; content?: string }[] = [];
    let answer = 204;
    let hookUrl = '';

    beforeAll(async () => {
      hook = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          received.push(JSON.parse(body));
          res.statusCode = answer;
          res.end();
        });
      });
      hook.listen(0, '127.0.0.1');
      await once(hook, 'listening');
      hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hooks/SECRET-${RUN}`;
    });
    afterAll(async () => {
      hook.close();
    });

    it('posts the new errors once, then nothing until one recurs', async () => {
      const first = await cli(['error-digest'], { ALERT_WEBHOOK_URL: hookUrl });
      expect(first.code).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({ sent: true });
      expect(received).toHaveLength(1);
      expect(received[0].text).toContain('error(s) new or seen again');
      expect(received[0].content).toBe(received[0].text);
      expect(first.stdout + first.stderr).not.toContain(`SECRET-${RUN}`);

      const second = await cli(['error-digest'], { ALERT_WEBHOOK_URL: hookUrl });
      expect(JSON.parse(second.stdout)).toMatchObject({ pending: 0, sent: false });
      expect(received).toHaveLength(1);

      // A recurrence after the alert makes it pending again.
      await api().get('/api/v1/__test/boom').set(auth(token));
      await settle();
      const third = await cli(['error-digest'], { ALERT_WEBHOOK_URL: hookUrl });
      expect(JSON.parse(third.stdout).pending).toBeGreaterThanOrEqual(1);
      expect(received).toHaveLength(2);
      // The kind and where, never the message (it may carry tenant data).
      expect(received[1].text).toContain('[API] TypeError');
      expect(received[1].text).toContain('/api/v1/__test/boom');
      expect(received[1].text).not.toContain('boom password');
      expect(received[1].text!.length).toBeLessThanOrEqual(1900);
    }, 90_000);

    it('a failing webhook keeps the errors pending and is itself recorded', async () => {
      await markBoomPending();
      answer = 500;
      const failed = await cli(['error-digest'], { ALERT_WEBHOOK_URL: hookUrl });
      expect(failed.code).toBe(1);
      expect(failed.stderr).toMatch(/Alert webhook answered 500/);
      expect(failed.stdout + failed.stderr).not.toContain(`SECRET-${RUN}`);
      const job = await errorRow("source = 'JOB' AND path = 'error-digest'", []);
      expect(job?.message).toBe('Alert webhook answered 500');

      answer = 204;
      const retry = await cli(['error-digest'], { ALERT_WEBHOOK_URL: hookUrl });
      expect(JSON.parse(retry.stdout)).toMatchObject({ sent: true });
      expect(JSON.parse(retry.stdout).pending).toBeGreaterThanOrEqual(1);
    }, 90_000);

    it('without a webhook nothing is sent and nothing is marked', async () => {
      await markBoomPending();
      const before = (await errorRow("source = 'API' AND message LIKE 'boom %'", []))!;
      const run = await cli(['error-digest'], { ALERT_WEBHOOK_URL: '' });
      expect(JSON.parse(run.stdout)).toMatchObject({ sent: false, reason: 'ALERT_WEBHOOK_URL is not set' });
      const after = (await errorRow('id = ?', [before.id]))!;
      expect(after.notified_at?.getTime() ?? null).toBe(before.notified_at?.getTime() ?? null);
    }, 60_000);
  });
});
