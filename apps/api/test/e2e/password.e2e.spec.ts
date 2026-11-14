/**
 * Password change and reset (ADR-012) — real MariaDB (erp_test), two tenants (A & B).
 *
 * Spawns the BUILT API (`node dist/main.js`) and the CLI job (`dist/jobs/cli.js`)
 * against erp_test, and exercises them over HTTP with supertest. Run `pnpm build`
 * before this suite. Each user is distinct per run (RUN suffix). The TRIAL plan
 * allows 3 users per tenant, so tenant A holds: owner, member M1, accountant X.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3218;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const SHARED_PASS = 'shared-password-456';
const NEW_PASS = 'member-new-789';
const NEWER_PASS = 'member-newer-012';
const SESSIONS_PASS = 'sessions-password-321';

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

function api() {
  return request(BASE);
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

/** The raw refresh token from a response's Set-Cookie header. */
function refreshOf(res: request.Response): string {
  const cookies = res.headers['set-cookie'] as unknown as string[];
  const cookie = cookies.find((c) => c.startsWith('refresh_token='))!;
  return cookie.split(';')[0]!.split('=')[1]!;
}

function login(email: string, password: string) {
  return api().post('/api/v1/auth/login').send({ email, password });
}

function refresh(rawToken: string) {
  return api().post('/api/v1/auth/refresh').set('Cookie', [`refresh_token=${rawToken}`]);
}

/**
 * JWT `iat` has 1-second resolution, and a token from the same second as a
 * password change still passes (ADR-012). Waiting past that second makes a token
 * issued before the change strictly older, so the test is deterministic.
 */
function waitPastIatSecond(): Promise<void> {
  return new Promise((r) => setTimeout(r, 1100));
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

/** Runs a CLI job; a non-zero exit is returned, not thrown. */
async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', ['dist/jobs/cli.js', ...args], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeAll(async () => {
  databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
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
    database: TEST_DB_NAME,
  });

  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Password change and reset (ADR-012, erp_test)', () => {
  const emailA = `owner-a-${RUN}@test.dev`;
  const emailB = `owner-b-${RUN}@test.dev`;
  const emailM1 = `member-${RUN}@test.dev`;
  const emailX = `shared-${RUN}@test.dev`;
  const emailS = `sessions-${RUN}@test.dev`;
  const emailCli = `cli-${RUN}@test.dev`;

  let ownerTokenA = '';
  let ownerTokenB = '';
  let ownerMembershipA = '';
  let m1MembershipId = '';
  let m1UserId = '';
  let m1TempPassword = '';
  let xMembershipIdInA = '';
  let temporaryAfterReset = '';
  // M1's session after the change in (a): its access token and refresh cookie.
  let m1Session = { token: '', cookie: '' };

  describe('a. first sign-in with a temporary password', () => {
    it('registers two tenants and invites M1 without a password (temporary password returned)', async () => {
      const regA = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Pwd A ${RUN}`, ownerName: 'Owner A', email: emailA, password: PASS });
      expect(regA.status).toBe(201);
      ownerTokenA = regA.body.accessToken;

      const regB = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Pwd B ${RUN}`, ownerName: 'Owner B', email: emailB, password: PASS });
      expect(regB.status).toBe(201);
      ownerTokenB = regB.body.accessToken;

      const list = await api().get('/api/v1/users').set(auth(ownerTokenA));
      ownerMembershipA = list.body.find((m: { role: { code: string } }) => m.role.code === 'OWNER').membershipId;

      const invite = await api()
        .post('/api/v1/users/invite')
        .set(auth(ownerTokenA))
        .send({ email: emailM1, roleCode: 'VIEWER' });
      expect(invite.status).toBe(201);
      expect(typeof invite.body.temporaryPassword).toBe('string');
      m1MembershipId = invite.body.membershipId;
      m1UserId = invite.body.user.id;
      m1TempPassword = invite.body.temporaryPassword;
    });

    it('refuses a password chosen by the inviter (400 VALIDATION); nothing is created', async () => {
      const res = await api()
        .post('/api/v1/users/invite')
        .set(auth(ownerTokenA))
        .send({ email: `chosen-${RUN}@test.dev`, roleCode: 'VIEWER', password: PASS });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('signs in with the temporary password; /me reports the flag and business routes are refused', async () => {
      const res = await login(emailM1, m1TempPassword);
      expect(res.status).toBe(200);
      const token = res.body.accessToken;

      const me = await api().get('/api/v1/me').set(auth(token));
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(true);

      const tenants = await api().get('/api/v1/me/tenants').set(auth(token));
      expect(tenants.status).toBe(200);

      const branches = await api().get('/api/v1/branches').set(auth(token));
      expect(branches.status).toBe(403);
      expect(branches.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    });

    it('refuses a wrong current password, and a new password equal to the current one', async () => {
      const token = (await login(emailM1, m1TempPassword)).body.accessToken;

      const wrong = await api()
        .post('/api/v1/auth/change-password')
        .set(auth(token))
        .send({ currentPassword: 'not-the-password', newPassword: NEW_PASS });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

      const same = await api()
        .post('/api/v1/auth/change-password')
        .set(auth(token))
        .send({ currentPassword: m1TempPassword, newPassword: m1TempPassword });
      expect(same.status).toBe(400);
      expect(same.body.error.code).toBe('VALIDATION');
    });

    it('changes the password (204): flag cleared; the pre-change token is refused; the kept session refreshes', async () => {
      // M1's 3rd sign-in in this suite (login limit is 10 per minute per IP+email).
      const signIn = await login(emailM1, m1TempPassword);
      const token = signIn.body.accessToken;
      const cookie = refreshOf(signIn);
      await waitPastIatSecond();

      const change = await api()
        .post('/api/v1/auth/change-password')
        .set(auth(token))
        .set('Cookie', [`refresh_token=${cookie}`])
        .send({ currentPassword: m1TempPassword, newPassword: NEW_PASS });
      expect(change.status).toBe(204);

      // The token issued before the change is refused on a business route.
      const stale = await api().get('/api/v1/branches').set(auth(token));
      expect(stale.status).toBe(401);

      // The session that changed the password refreshes with its kept cookie.
      const refreshed = await refresh(cookie);
      expect(refreshed.status).toBe(200);
      const fresh = refreshed.body.accessToken;
      const me = await api().get('/api/v1/me').set(auth(fresh));
      expect(me.body.user.mustChangePassword).toBe(false);
      const branches = await api().get('/api/v1/branches').set(auth(fresh));
      expect(branches.status).toBe(200);

      const oldLogin = await login(emailM1, m1TempPassword);
      expect(oldLogin.status).toBe(401);
      const newLogin = await login(emailM1, NEW_PASS);
      expect(newLogin.status).toBe(200);
      m1Session = { token: newLogin.body.accessToken, cookie: refreshOf(newLogin) };
    });
  });

  describe('b. other sessions are signed out', () => {
    it('keeps the session that changed the password and revokes the others', async () => {
      // A separate member of tenant B: M1's sign-in count stays within the login limit.
      // A new user: the temporary password is replaced by SESSIONS_PASS inside addMember.
      const member = await addMember(BASE, ownerTokenB, {
        email: emailS,
        roleCode: 'VIEWER',
        password: SESSIONS_PASS,
      });
      expect(member.membershipId).toBeTruthy();

      const s1 = await login(emailS, SESSIONS_PASS);
      const s2 = await login(emailS, SESSIONS_PASS);
      expect(s1.status).toBe(200);
      expect(s2.status).toBe(200);
      const cookie1 = refreshOf(s1);
      const cookie2 = refreshOf(s2);
      await waitPastIatSecond();

      const change = await api()
        .post('/api/v1/auth/change-password')
        .set(auth(s1.body.accessToken))
        .set('Cookie', [`refresh_token=${cookie1}`])
        .send({ currentPassword: SESSIONS_PASS, newPassword: NEWER_PASS });
      expect(change.status).toBe(204);

      const other = await refresh(cookie2);
      expect(other.status).toBe(401);

      const staleOwn = await api().get('/api/v1/me').set(auth(s1.body.accessToken));
      expect(staleOwn.status).toBe(401);
      const own = await refresh(cookie1);
      expect(own.status).toBe(200);
    });
  });

  describe('c. owner resets a member password', () => {
    it('resets M1 (200) with a temporary password; old sessions end; the new password works', async () => {
      // M1's session from (a): issued after the change, so it is valid until the reset.
      const { token: preResetToken, cookie: oldCookie } = m1Session;
      await waitPastIatSecond();

      const reset = await api()
        .post(`/api/v1/users/${m1MembershipId}/reset-password`)
        .set(auth(ownerTokenA));
      expect(reset.status).toBe(200);
      expect(Object.keys(reset.body)).toEqual(['temporaryPassword']);
      temporaryAfterReset = reset.body.temporaryPassword;
      expect(typeof temporaryAfterReset).toBe('string');

      const stale = await refresh(oldCookie);
      expect(stale.status).toBe(401);
      const staleToken = await api().get('/api/v1/branches').set(auth(preResetToken));
      expect(staleToken.status).toBe(401);

      const signIn = await login(emailM1, temporaryAfterReset);
      expect(signIn.status).toBe(200);
      const me = await api().get('/api/v1/me').set(auth(signIn.body.accessToken));
      expect(me.body.user.mustChangePassword).toBe(true);
    });

    it("refuses a reset of the caller's own membership (403)", async () => {
      const res = await api()
        .post(`/api/v1/users/${ownerMembershipA}/reset-password`)
        .set(auth(ownerTokenA));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_RESET_NOT_ALLOWED');
    });

    it('invites X (accountant) into A as a new user, then into B where X is an existing user who accepts', async () => {
      const inA = await addMember(BASE, ownerTokenA, {
        email: emailX,
        roleCode: 'ACCOUNTANT',
        password: SHARED_PASS,
      });
      xMembershipIdInA = inA.membershipId;

      // X already has an account: the B invitation is INVITED until X accepts it (addMember does that).
      const inB = await addMember(BASE, ownerTokenB, {
        email: emailX,
        roleCode: 'VIEWER',
        password: SHARED_PASS,
      });
      expect(inB.invite.temporaryPassword).toBeUndefined();
      expect(inB.membershipId).toBeTruthy();
    });

    it('refuses owner A resetting X, who also belongs to tenant B (403)', async () => {
      const res = await api()
        .post(`/api/v1/users/${xMembershipIdInA}/reset-password`)
        .set(auth(ownerTokenA));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_RESET_NOT_ALLOWED');
    });

    it('refuses an accountant resetting the owner (403)', async () => {
      const accountant = await login(emailX, SHARED_PASS);
      expect(accountant.status).toBe(200);
      const res = await api()
        .post(`/api/v1/users/${ownerMembershipA}/reset-password`)
        .set(auth(accountant.body.accessToken));
      // user.manage is OWNER-only (decisions.md §Platform): the permission gate refuses first.
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('isolates tenants: owner B resetting a membership of tenant A is 404', async () => {
      const res = await api()
        .post(`/api/v1/users/${m1MembershipId}/reset-password`)
        .set(auth(ownerTokenB));
      expect(res.status).toBe(404);
    });

    it('keeps passwords out of the audit log', async () => {
      const rows = (await db.query(
        "SELECT action, entity_id, before_json, after_json FROM audit_logs WHERE action IN ('user.password_reset', 'auth.password_change') AND (entity_id = ? OR user_id = ?)",
        [m1MembershipId, m1UserId],
      )) as { action: string; entity_id: string; before_json: unknown; after_json: unknown }[];
      const resetRow = rows.find((r) => r.action === 'user.password_reset');
      expect(resetRow).toBeDefined();
      expect(resetRow!.entity_id).toBe(m1MembershipId);
      expect(rows.find((r) => r.action === 'auth.password_change')).toBeDefined();
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(temporaryAfterReset);
      expect(dump).not.toContain(NEWER_PASS);
      expect(dump).not.toContain(NEW_PASS);
    });
  });

  describe('d. CLI reset', () => {
    it('resets a user from the shell: JSON with a temporary password, flag set, audit row', async () => {
      const reg = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `Pwd C ${RUN}`, ownerName: 'Owner C', email: emailCli, password: PASS });
      expect(reg.status).toBe(201);
      const before = await db.query('SELECT must_change_password FROM users WHERE email = ?', [emailCli]);
      expect(Number(before[0].must_change_password)).toBe(0);

      // Not a terminal here: the temporary password is printed only on request (PLAT-30).
      const res = await cli(['reset-password', emailCli, '--print-password']);
      expect(res.code).toBe(0);
      const out = JSON.parse(res.stdout) as {
        job: string;
        email: string;
        temporaryPassword: string;
        sessionsRevoked: number;
      };
      expect(out.job).toBe('reset-password');
      expect(out.email).toBe(emailCli);
      expect(typeof out.temporaryPassword).toBe('string');
      expect(out.sessionsRevoked).toBe(1);

      const after = await db.query('SELECT must_change_password FROM users WHERE email = ?', [emailCli]);
      expect(Number(after[0].must_change_password)).toBe(1);

      const audit = (await db.query(
        "SELECT after_json, user_id, tenant_id FROM audit_logs WHERE action = 'auth.password_reset' AND entity_id = (SELECT CAST(id AS CHAR) FROM users WHERE email = ?)",
        [emailCli],
      )) as { after_json: unknown; user_id: unknown; tenant_id: unknown }[];
      expect(audit).toHaveLength(1);
      expect(audit[0]!.tenant_id).toBeNull();
      expect(audit[0]!.user_id).toBeNull();
      const afterJson =
        typeof audit[0]!.after_json === 'string' ? JSON.parse(audit[0]!.after_json) : audit[0]!.after_json;
      expect(afterJson).toEqual({ by: 'cli' });
      expect(JSON.stringify(audit)).not.toContain(out.temporaryPassword);

      const signIn = await login(emailCli, out.temporaryPassword);
      expect(signIn.status).toBe(200);
    }, 60_000);

    it('exits 1 for an unknown email', async () => {
      const res = await cli(['reset-password', `nobody-${RUN}@test.dev`, '--print-password']);
      expect(res.code).toBe(1);
    }, 60_000);

    it('refuses to print a temporary password outside a terminal without --print-password', async () => {
      const res = await cli(['reset-password', emailCli]);
      expect(res.code).toBe(1);
      expect(res.stderr).toMatch(/--print-password/);
      // Refused before the reset: the password hash is unchanged.
      const before = await db.query('SELECT password_hash FROM users WHERE email = ?', [emailCli]);
      const again = await cli(['reset-password', emailCli]);
      expect(again.code).toBe(1);
      const after = await db.query('SELECT password_hash FROM users WHERE email = ?', [emailCli]);
      expect(after[0].password_hash).toBe(before[0].password_hash);
    }, 60_000);
  });
});
