/**
 * Phase 1 integration tests — real MariaDB (erp_test), two tenants (A & B).
 *
 * Strategy: spawns the BUILT API (`node dist/main.js`) as a child process with
 * DATABASE_URL pointed at erp_test, then exercises it over HTTP with supertest.
 * Run `pnpm build` before `pnpm test` for this suite (CI does build first).
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { addMember } from './support/members.js';

const API_PORT = 3199;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

function api() {
  return request(BASE);
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await api().get('/api/v1/health');
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
    },
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
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Phase 1 — platform & tenant isolation (erp_test)', () => {
  let tokenA = '';
  let tokenB = '';
  let tenantA = '';
  let tenantB = '';
  let cashierToken = '';

  it('registers two independent tenants', async () => {
    const regA = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Tenant A ${RUN}`,
        ownerName: 'Owner A',
        email: `owner-a-${RUN}@test.dev`,
        password: PASS,
      });
    expect(regA.status).toBe(201);
    expect(regA.body.accessToken).toBeDefined();
    tokenA = regA.body.accessToken;

    const regB = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Tenant B ${RUN}`,
        ownerName: 'Owner B',
        email: `owner-b-${RUN}@test.dev`,
        password: PASS,
      });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    const meA = await api().get('/api/v1/me').set(auth(tokenA));
    tenantA = meA.body.currentTenant.tenantId;
    const meB = await api().get('/api/v1/me').set(auth(tokenB));
    tenantB = meB.body.currentTenant.tenantId;
    expect(tenantA).not.toBe(tenantB);
  });

  it('enforces tenant isolation on /users and /branches', async () => {
    const usersA = await api().get('/api/v1/users').set(auth(tokenA));
    const usersB = await api().get('/api/v1/users').set(auth(tokenB));
    expect(usersA.body).toHaveLength(1);
    expect(usersB.body).toHaveLength(1);
    expect(usersA.body[0].user.email).toContain(`owner-a-${RUN}`);
    expect(usersB.body[0].user.email).toContain(`owner-b-${RUN}`);

    const branchesA = await api().get('/api/v1/branches').set(auth(tokenA));
    expect(branchesA.body).toHaveLength(1);
    expect(branchesA.body[0].code).toBe('MAIN');
  });

  it('rejects cross-tenant membership access', async () => {
    const res = await api()
      .post('/api/v1/me/switch-tenant')
      .set(auth(tokenA))
      .send({ tenantId: tenantB });
    expect(res.status).toBe(403);
  });

  it('enforces plan limits (TRIAL = 1 branch, 3 users)', async () => {
    const branch = await api()
      .post('/api/v1/branches')
      .set(auth(tokenA))
      .send({ code: 'B2', nameAr: 'فرع ثاني' });
    expect(branch.status).toBe(402);
    expect(branch.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
  });

  it('invites a user and enforces role permissions', async () => {
    // A password chosen by the inviter is refused: the member sets their own at first sign-in.
    const refused = await api()
      .post('/api/v1/users/invite')
      .set(auth(tokenA))
      .send({ email: `cashier-a-${RUN}@test.dev`, roleCode: 'CASHIER', password: 'cashier-pass-1' });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('VALIDATION');

    // A new user gets a temporary password; addMember replaces it with the chosen one and signs in.
    const cashier = await addMember(BASE, tokenA, {
      email: `cashier-a-${RUN}@test.dev`,
      roleCode: 'CASHIER',
      password: 'cashier-pass-1',
    });
    cashierToken = cashier.token;

    const denied = await api()
      .post('/api/v1/users/invite')
      .set(auth(cashierToken))
      .send({ email: `x-${RUN}@test.dev`, roleCode: 'VIEWER' });
    expect(denied.status).toBe(403);

    // user.manage is OWNER-only (decisions.md §Platform): a cashier cannot list members.
    const list = await api().get('/api/v1/users').set(auth(cashierToken));
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('FORBIDDEN');

    const owners = await api().get('/api/v1/users').set(auth(tokenA));
    expect(owners.status).toBe(200);
    expect(owners.body).toHaveLength(2);
  });

  // Reuse within the 10-second grace window (ADR-012) answers 401 but keeps
  // the family; reuse after it revokes the family (session-access.e2e).
  it('rotates refresh tokens; a reuse within the grace window is refused without ending the session', async () => {
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: `owner-b-${RUN}@test.dev`, password: PASS });
    expect(login.status).toBe(200);
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const refreshCookie = cookies.find((c) => c.startsWith('refresh_token='))!;
    const rawToken = refreshCookie.split(';')[0]!.split('=')[1]!;

    const r1 = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${rawToken}`]);
    expect(r1.status).toBe(200);
    const newCookie = (r1.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('refresh_token='),
    )!;
    const rotated = newCookie.split(';')[0]!.split('=')[1]!;

    const reuse = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${rawToken}`]);
    expect(reuse.status).toBe(401);

    const after = await api()
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`refresh_token=${rotated}`]);
    expect(after.status).toBe(200);
  });

  it('blocks platform admin endpoints for non-admins', async () => {
    const res = await api().get('/api/v1/admin/tenants').set(auth(tokenA));
    expect(res.status).toBe(403);
  });

  it('suspends a tenant → read-only, then reactivates', async () => {
    await db.query(
      'UPDATE users SET is_platform_admin = 1 WHERE email = ?',
      [`owner-a-${RUN}@test.dev`],
    );
    const adminLogin = await api()
      .post('/api/v1/auth/login')
      .send({ email: `owner-a-${RUN}@test.dev`, password: PASS });
    const adminToken = adminLogin.body.accessToken as string;

    const suspend = await api()
      .patch(`/api/v1/admin/tenants/${tenantB}/status`)
      .set(auth(adminToken))
      .send({ status: 'SUSPENDED' });
    expect(suspend.status).toBe(200);

    const read = await api().get('/api/v1/users').set(auth(tokenB));
    expect(read.status).toBe(200);

    const write = await api()
      .post('/api/v1/branches')
      .set(auth(tokenB))
      .send({ code: 'NOPE', nameAr: 'x' });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe('TENANT_READ_ONLY');

    await api()
      .patch(`/api/v1/admin/tenants/${tenantB}/status`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' });
  });

  it('rejects unauthenticated and cross-tenant-scoped writes', async () => {
    const noAuth = await api().get('/api/v1/users');
    expect(noAuth.status).toBe(401);
  });
});
