/**
 * Phase 10.1 — production setup (ADR-010):
 *  - the API serves the built web app on the same origin: pages fall back to
 *    index.html, hashed assets are immutable, /api stays JSON, a missing file
 *    is a 404, docs are off in production, security headers are set;
 *  - behind a proxy (TRUST_PROXY=1) rate limits count each client, not the proxy;
 *  - an unsafe production configuration refuses to start, naming the variables;
 *  - `preflight` passes on a ready server and fails on a broken web folder or
 *    storage inside the web folder;
 *  - `grant-platform-admin` grants, audits, is idempotent, and revokes.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3213;
const BAD_PORT = 3214;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const MARKER = `fixture-web-${RUN}`;

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';
let tmp = '';
let webDir = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** A production configuration that passes every rule (ADR-010 §10.1). */
const productionEnv = () => ({
  ...process.env,
  DATABASE_URL: databaseUrl,
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
  CORS_ORIGIN: 'https://erp.example.test',
  EINVOICE_ENC_KEY: randomBytes(32).toString('base64'),
  BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  EINVOICE_WORKER: 'off',
  API_DOCS: '',
});

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

/** Runs a CLI job; a non-zero exit is returned, not thrown. */
async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', ['dist/jobs/cli.js', ...args], {
      cwd: API_DIR,
      // Backups (preflight's probe) in the test folder, not in apps/api.
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', BACKUP_DIR: path.join(tmp, 'backups'), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(async () => {
  databaseUrl = testDatabaseUrl();
  tmp = await mkdtemp(path.join(os.tmpdir(), 'erp-p10-'));
  webDir = path.join(tmp, 'web');
  await mkdir(path.join(webDir, 'assets'), { recursive: true });
  await writeFile(path.join(webDir, 'index.html'), `<!doctype html><div id="root">${MARKER}</div>`);
  await writeFile(path.join(webDir, 'assets', 'app-3f9a1c.js'), 'console.log("app")');
  await writeFile(path.join(webDir, 'robots.txt'), 'User-agent: *');

  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...productionEnv(), API_PORT: String(API_PORT), WEB_DIST_DIR: webDir, TRUST_PROXY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  const url = new URL(databaseUrl);
  db = await mariadb.createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  // A server that already exited (failed to start) emits no further 'exit'.
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await db?.end();
  await rm(tmp, { recursive: true, force: true });
});

describe('Phase 10.1 — the web app on the same origin', () => {
  it('serves index.html for pages, with the security headers', async () => {
    const home = await api().get('/');
    expect(home.status).toBe(200);
    expect(home.headers['content-type']).toMatch(/text\/html/);
    expect(home.text).toContain(MARKER);
    expect(home.headers['cache-control']).toBe('no-cache');
    const csp = home.headers['content-security-policy'] as string;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(csp).toContain("script-src 'self'");
    // Printed documents open as blob: PDFs that inherit this policy.
    expect(csp).toContain('object-src blob:');
    expect(csp).toContain('upgrade-insecure-requests');
    expect(home.headers['strict-transport-security']).toBeDefined();
    expect(home.headers['x-powered-by']).toBeUndefined();

    // A page of the web app's router, and HEAD.
    const page = await api().get('/reports?tab=tb');
    expect([page.status, page.text.includes(MARKER)]).toEqual([200, true]);
    expect((await api().head('/fiscal')).status).toBe(200);
  });

  it('hashed assets are cached for good, other files revalidate', async () => {
    const asset = await api().get('/assets/app-3f9a1c.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await api().get('/robots.txt')).headers['cache-control']).toBe('no-cache');
  });

  it('a missing file, another method or a path outside the folder is not the page', async () => {
    const missing = await api().get('/assets/app-missing.js');
    expect(missing.status).toBe(404);
    expect(missing.text).not.toContain(MARKER);
    expect((await api().post('/reports').send({})).status).toBe(404);
    const escape = await api().get('/%2e%2e/%2e%2e/package.json');
    expect(escape.status).not.toBe(200);
    expect(escape.text).not.toContain('"dependencies"');
  });

  it('/api stays the API: JSON errors, and no docs in production', async () => {
    const health = await api().get('/api/v1/health');
    expect([health.status, health.body.status]).toEqual([200, 'ok']);
    const unknown = await api().get('/api/v1/no-such-route');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBeDefined();
    for (const p of ['/api/docs', '/api', '/api/v2/anything']) {
      const res = await api().get(p);
      expect([p, res.status, res.text.includes(MARKER)]).toEqual([p, 404, false]);
    }
  });

  it('behind the proxy, each client has its own login limit', async () => {
    // A new email each time: the per-email delay (ADR-012) stays out of it, and the
    // per-address cap of sign-in (30 a minute, ADR-011) is what refuses the 31st.
    let n = 0;
    const login = (ip: string) =>
      api()
        .post('/api/v1/auth/login')
        .set('X-Forwarded-For', ip)
        .send({ email: `p10-nobody-${++n}-${RUN}@test.dev`, password: 'wrong-password' });
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await login('203.0.113.7')).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses[30]).toBe(429);
    // Another client through the same proxy is not blocked.
    expect((await login('203.0.113.8')).status).toBe(401);
  });

  it('an unsafe production configuration refuses to start, naming what is wrong', async () => {
    const bad = spawn('node', ['dist/main.js'], {
      cwd: API_DIR,
      env: { ...productionEnv(), API_PORT: String(BAD_PORT), CORS_ORIGIN: 'http://localhost:5173', EINVOICE_WORKER: 'on' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    bad.stderr?.on('data', (d) => (stderr += d));
    // Should it start after all, stop it rather than wait for Jest's timeout.
    const guard = setTimeout(() => bad.kill('SIGKILL'), 30_000);
    const [code, signal] = (await once(bad, 'exit')) as [number | null, string | null];
    clearTimeout(guard);
    expect(signal).toBeNull();
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/CORS_ORIGIN: must be exactly the site's https:\/\/ origin/);
    expect(stderr).toMatch(/EINVOICE_WORKER: must be off in production/);
  }, 60_000);
});

describe('Phase 10.1 — preflight and grant-platform-admin', () => {
  type Check = { name: string; ok: boolean; level: string; detail: string };
  const byName = (out: string) =>
    Object.fromEntries((JSON.parse(out) as { checks: Check[] }).checks.map((c) => [c.name, c]));

  it('preflight passes on a ready server and names what it checked', async () => {
    const run = await cli(['preflight'], { WEB_DIST_DIR: webDir, STORAGE_DIR: path.join(tmp, 'storage') });
    expect(run.code).toBe(0);
    const out = JSON.parse(run.stdout) as { ok: boolean; checks: Check[] };
    expect(out.ok).toBe(true);
    const checks = byName(run.stdout);
    expect(Object.keys(checks).sort()).toEqual(
      [
        'backup', 'backup-age', 'backup-key', 'database', 'database-write', 'disk', 'environment', 'isolation',
        'migrations', 'plans', 'platform-admin', 'proxy', 'restore-tool', 'storage', 'timezone', 'web',
      ].sort(),
    );
    expect(checks.environment.level).toBe('warn'); // NODE_ENV=test is not production
    expect(checks.migrations.detail).toMatch(/applied/);
    // The backup folder is writable and the dump tool runs (MYSQLDUMP_PATH).
    expect(checks.backup).toMatchObject({ ok: true, level: 'info', detail: expect.stringMatching(/writable: .*kept 14 days; .*(mysqldump|mariadb-dump)/i) });
    expect(checks.database.detail).toMatch(/MariaDB|^connected/);
  }, 60_000);

  it('preflight fails without the web build, or with storage inside the web folder', async () => {
    const empty = path.join(tmp, 'empty-web');
    await mkdir(empty, { recursive: true });
    const noWeb = await cli(['preflight'], { WEB_DIST_DIR: empty, STORAGE_DIR: path.join(tmp, 'storage') });
    expect(noWeb.code).toBe(1);
    expect(byName(noWeb.stdout).web).toMatchObject({ ok: false, level: 'error' });

    const exposed = await cli(['preflight'], { WEB_DIST_DIR: webDir, STORAGE_DIR: path.join(webDir, 'uploads') });
    expect(exposed.code).toBe(1);
    expect(byName(exposed.stdout).storage.detail).toMatch(/overlaps WEB_DIST_DIR/);
  }, 60_000);

  it('on a database with no migrations it reports every check instead of crashing', async () => {
    const name = `erp_p10_empty_${RUN}`;
    await db.query(`CREATE DATABASE ${name}`);
    try {
      const run = await cli(['preflight'], {
        DATABASE_URL: databaseUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`),
        WEB_DIST_DIR: webDir,
        STORAGE_DIR: path.join(tmp, 'storage'),
      });
      expect(run.code).toBe(1);
      const checks = byName(run.stdout);
      expect(checks.database.ok).toBe(true);
      expect(checks.migrations).toMatchObject({ ok: false, detail: expect.stringMatching(/none applied .*prisma migrate deploy/) });
      expect(checks.plans.ok).toBe(false);
      expect([checks.storage.ok, checks.web.ok]).toEqual([true, true]);
    } finally {
      await db.query(`DROP DATABASE IF EXISTS ${name}`);
    }
  }, 60_000);

  it('grants, audits, is idempotent and revokes the platform administrator', async () => {
    const email = `p10-admin-${RUN}@test.dev`;
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P10 ${RUN}`, ownerName: 'Owner', email, password: PASS });
    expect(reg.status).toBe(201);
    const token = reg.body.accessToken as string;
    expect((await api().get('/api/v1/admin/tenants').set(auth(token))).status).toBe(403);

    const granted = await cli(['grant-platform-admin', email]);
    expect(granted.code).toBe(0);
    expect(JSON.parse(granted.stdout)).toMatchObject({ email, isPlatformAdmin: true, changed: true });
    expect((await api().get('/api/v1/admin/tenants').set(auth(token))).status).toBe(200);

    const again = await cli(['grant-platform-admin', email]);
    expect(JSON.parse(again.stdout)).toMatchObject({ isPlatformAdmin: true, changed: false });
    const audit = (await db.query(
      "SELECT a.tenant_id, a.action FROM audit_logs a JOIN users u ON a.entity_id = CAST(u.id AS CHAR) WHERE u.email = ? AND a.action LIKE 'platform_admin.%'",
      [email],
    )) as { tenant_id: unknown; action: string }[];
    expect(audit.map((a) => [a.tenant_id, a.action])).toEqual([[null, 'platform_admin.grant']]);

    const revoked = await cli(['grant-platform-admin', email, '--revoke']);
    expect(JSON.parse(revoked.stdout)).toMatchObject({ isPlatformAdmin: false, changed: true });
    expect((await api().get('/api/v1/admin/tenants').set(auth(token))).status).toBe(403);

    const unknown = await cli(['grant-platform-admin', `p10-nobody-${RUN}@test.dev`]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/No user with email/);
  }, 90_000);
});
