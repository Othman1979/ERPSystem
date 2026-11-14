/**
 * Sign-in, registration and session hardening (ADR-011, ADR-012, PLAT-09, PLAT-16,
 * PLAT-22, PLAT-23). Real MariaDB (erp_test), two tenants (A & B).
 *
 * Spawns the BUILT API (`node dist/main.js`) on its own port and exercises it over
 * HTTP with supertest. Run `pnpm build` before this suite. Each client gets a fresh
 * X-Forwarded-For address (TRUST_PROXY defaults to loopback), so per-address limits
 * of one test never reach another. Each user is distinct per run (RUN suffix).
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3643;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

let addressSeq = 0;
/** A client address nobody else in this suite uses. */
function fresh(): Record<string, string> {
  addressSeq += 1;
  return { 'X-Forwarded-For': `100.64.${Math.floor(addressSeq / 250)}.${(addressSeq % 250) + 1}` };
}

function api() {
  return request(BASE);
}

function bearer(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** The Set-Cookie line of the refresh cookie in a response. */
function refreshSetCookie(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.find((c) => c.startsWith('refresh_token='))!;
}

/** The raw refresh token from a response's Set-Cookie header. */
function refreshOf(res: request.Response): string {
  return refreshSetCookie(res).split(';')[0]!.split('=')[1]!;
}

function register(name: string, email: string, headers = fresh()) {
  return api()
    .post('/api/v1/auth/register')
    .set(headers)
    .send({ tenantName: `Hardening ${name} ${RUN}`, ownerName: name, email, password: PASS });
}

function login(email: string, password: string, headers = fresh(), extra: Record<string, unknown> = {}) {
  return api().post('/api/v1/auth/login').set(headers).send({ email, password, ...extra });
}

function refresh(rawToken: string, headers = fresh()) {
  return api().post('/api/v1/auth/refresh').set(headers).set('Cookie', [`refresh_token=${rawToken}`]);
}

async function tenantIdOf(accessToken: string): Promise<string> {
  const res = await api().get('/api/v1/me').set(bearer(accessToken));
  expect(res.status).toBe(200);
  return res.body.currentTenant.tenantId as string;
}

async function userIdOf(email: string): Promise<number> {
  const rows = await db.query<Array<{ id: number }>>('SELECT id FROM users WHERE email = ?', [email]);
  return Number(rows[0]!.id);
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

beforeAll(async () => {
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      REFRESH_TOKEN_TTL_DAYS: '7',
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
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Sign-in, registration and session hardening (erp_test)', () => {
  it('lets 5 registrations a minute from one address and refuses the 6th with RATE_LIMITED', async () => {
    const address = fresh();
    for (let i = 0; i < 5; i++) {
      expect((await register(`Reg ${i}`, `reg-${i}-${RUN}@test.dev`, address)).status).toBe(201);
    }
    const refused = await register('Reg 5', `reg-5-${RUN}@test.dev`, address);
    expect([refused.status, refused.body.error.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('answers 5 concurrent registrations of one email with one 201 and 409s, never 500', async () => {
    const email = `race-${RUN}@test.dev`;
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => register(`Race ${i}`, email)),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(4);
  });

  it('locks an email after 5 wrong passwords: LOGIN_LOCKED with Retry-After, colleagues unaffected', async () => {
    const email = `lock-${RUN}@test.dev`;
    const other = `lock-other-${RUN}@test.dev`;
    const address = fresh();
    expect((await register('Lock', email)).status).toBe(201);
    expect((await register('Other', other)).status).toBe(201);

    for (let i = 0; i < 5; i++) {
      const res = await login(email, 'wrong-password-1', address);
      expect([res.status, res.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
    }
    // The right password is refused too while the delay runs.
    const locked = await login(email, PASS, address);
    expect([locked.status, locked.body.error.code]).toEqual([429, 'LOGIN_LOCKED']);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // Another email from the same address still signs in.
    expect((await login(other, PASS, address)).status).toBe(200);
  });

  it('answers an unknown email with the same 401 as a wrong password', async () => {
    const email = `known-${RUN}@test.dev`;
    expect((await register('Known', email)).status).toBe(201);

    const wrong = await login(email, 'wrong-password-1');
    const unknown = await login(`nobody-${RUN}@test.dev`, 'wrong-password-1');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('refuses an inactive user at sign-in and at refresh with the old cookie', async () => {
    const email = `inactive-${RUN}@test.dev`;
    const reg = await register('Inactive', email);
    expect(reg.status).toBe(201);
    const cookie = refreshOf(reg);

    await db.query('UPDATE users SET is_active = 0 WHERE email = ?', [email]);

    const signIn = await login(email, PASS);
    expect([signIn.status, signIn.body.error.code]).toEqual([401, 'UNAUTHORIZED']);
    expect((await refresh(cookie)).status).toBe(401);
  });

  it('sets the refresh cookie to 7 days (Max-Age 604800)', async () => {
    const res = await register('Cookie', `cookie-${RUN}@test.dev`);
    expect(res.status).toBe(201);
    expect(refreshSetCookie(res)).toContain('Max-Age=604800');
  });

  it('logout-all ends every session of the user: 204, then both cookies fail to refresh', async () => {
    const email = `logout-all-${RUN}@test.dev`;
    const reg = await register('Logout All', email);
    expect(reg.status).toBe(201);
    const cookieOne = refreshOf(reg);
    const second = await login(email, PASS);
    expect(second.status).toBe(200);
    const cookieTwo = refreshOf(second);
    // Isolation: another tenant's user, signed in at the same time.
    const other = await register('Logout Other', `logout-other-${RUN}@test.dev`);
    expect(other.status).toBe(201);
    const otherCookie = refreshOf(other);

    const out = await api()
      .post('/api/v1/auth/logout-all')
      .set(bearer(reg.body.accessToken as string));
    expect(out.status).toBe(204);

    expect((await refresh(cookieOne)).status).toBe(401);
    expect((await refresh(cookieTwo)).status).toBe(401);
    expect((await refresh(otherCookie)).status).toBe(200);
  });

  it('switching company ends the session it leaves; the new cookie refreshes', async () => {
    const ownerA = `switch-a-${RUN}@test.dev`;
    const ownerB = `switch-b-${RUN}@test.dev`;
    const regA = await register('Switch A', ownerA);
    const regB = await register('Switch B', ownerB);
    expect([regA.status, regB.status]).toEqual([201, 201]);
    const tenantB = await tenantIdOf(regB.body.accessToken as string);

    // A's owner also works in B as a viewer (SQL, not an invitation flow).
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status, created_at, updated_at)
       VALUES (?, ?, (SELECT id FROM roles WHERE code = 'VIEWER'), 'ACTIVE', NOW(3), NOW(3))`,
      [tenantB, await userIdOf(ownerA)],
    );

    const switched = await api()
      .post('/api/v1/me/switch-tenant')
      .set(fresh())
      .set(bearer(regA.body.accessToken as string))
      .send({ tenantId: tenantB });
    expect(switched.status).toBe(200);

    expect((await refresh(refreshOf(regA))).status).toBe(401);
    expect((await refresh(refreshOf(switched))).status).toBe(200);
  });

  it('refuses a non-numeric tenantId on sign-in and on switch-tenant with 400 VALIDATION', async () => {
    const email = `numeric-${RUN}@test.dev`;
    const reg = await register('Numeric', email);
    expect(reg.status).toBe(201);

    const signIn = await login(email, PASS, fresh(), { tenantId: 'abc' });
    expect([signIn.status, signIn.body.error.code]).toEqual([400, 'VALIDATION']);

    const sw = await api()
      .post('/api/v1/me/switch-tenant')
      .set(fresh())
      .set(bearer(reg.body.accessToken as string))
      .send({ tenantId: 'abc' });
    expect([sw.status, sw.body.error.code]).toEqual([400, 'VALIDATION']);
  });

  it('a user of tenant B cannot switch into tenant A (403)', async () => {
    const regA = await register('Iso A', `iso-a-${RUN}@test.dev`);
    const regB = await register('Iso B', `iso-b-${RUN}@test.dev`);
    expect([regA.status, regB.status]).toEqual([201, 201]);
    const tenantA = await tenantIdOf(regA.body.accessToken as string);

    const sw = await api()
      .post('/api/v1/me/switch-tenant')
      .set(fresh())
      .set(bearer(regB.body.accessToken as string))
      .send({ tenantId: tenantA });
    expect([sw.status, sw.body.error.code]).toEqual([403, 'FORBIDDEN']);
  });

  it('signs in without a company when only invitations are waiting, and counts them', async () => {
    const email = `invited-${RUN}@test.dev`;
    const reg = await register('Invited', email);
    expect(reg.status).toBe(201);
    const tenantB = await tenantIdOf((await register('Host', `host-${RUN}@test.dev`)).body.accessToken as string);

    // Own membership becomes an invitation, and one more invitation arrives in B.
    const userId = await userIdOf(email);
    await db.query("UPDATE tenant_memberships SET status = 'INVITED' WHERE user_id = ?", [userId]);
    await db.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status, created_at, updated_at)
       VALUES (?, ?, (SELECT id FROM roles WHERE code = 'VIEWER'), 'INVITED', NOW(3), NOW(3))`,
      [tenantB, userId],
    );

    const signIn = await login(email, PASS);
    expect(signIn.status).toBe(200);
    expect(signIn.body.pendingInvitations).toBe(2);
    expect(signIn.body.tenants).toEqual([]);
    expect(signIn.body.accessToken).toEqual(expect.any(String));

    const meRes = await api().get('/api/v1/me').set(bearer(signIn.body.accessToken as string));
    expect(meRes.status).toBe(200);
    expect(meRes.body.pendingInvitations).toBe(2);
    expect(meRes.body.currentTenant).toBeNull();

    // An invitation cannot be used as a membership: a named tenant is still refused.
    const named = await login(email, PASS, fresh(), { tenantId: tenantB });
    expect([named.status, named.body.error.code]).toEqual([403, 'FORBIDDEN']);
  });
});
