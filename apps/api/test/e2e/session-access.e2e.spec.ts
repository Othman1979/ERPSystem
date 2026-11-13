/**
 * Access control and sessions (review 2026-11-13: PLAT-01, PLAT-03, PLAT-04)
 * — real MariaDB (erp_test), two tenants (A & B).
 *
 * Spawns the BUILT API (`node dist/main.js`) against erp_test and exercises it
 * over HTTP with supertest. Run `pnpm build` before this suite. Users are
 * distinct per run (RUN suffix). The TRIAL plan allows 3 users and 1 warehouse
 * per tenant: tenant A holds owner, accountant X and viewer V.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';

const API_PORT = 3501;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
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
  return api()
    .post('/api/v1/auth/refresh')
    .set('Cookie', [`refresh_token=${rawToken}`]);
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function liveTokensInFamilyOf(rawToken: string): Promise<number> {
  const rows = await db.query<{ n: bigint }[]>(
    `SELECT COUNT(*) AS n FROM refresh_tokens
      WHERE revoked_at IS NULL
        AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)`,
    [sha256(rawToken)],
  );
  return Number(rows[0]!.n);
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
    database: 'erp_test',
  });

  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Access control and sessions (erp_test)', () => {
  const emailA = `sa-owner-a-${RUN}@test.dev`;
  const emailB = `sa-owner-b-${RUN}@test.dev`;
  const emailX = `sa-accountant-${RUN}@test.dev`;
  const emailV = `sa-viewer-${RUN}@test.dev`;

  let ownerTokenA = '';
  let ownerTokenB = '';
  let ownerMembershipA = '';
  let xToken = '';
  let xMembership = '';
  let vMembership = '';

  describe('PLAT-01: role changes', () => {
    it('sets up tenant A (owner, accountant X, viewer V) and tenant B', async () => {
      const regA = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `SA A ${RUN}`, ownerName: 'Owner A', email: emailA, password: PASS });
      expect(regA.status).toBe(201);
      ownerTokenA = regA.body.accessToken;

      const regB = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `SA B ${RUN}`, ownerName: 'Owner B', email: emailB, password: PASS });
      expect(regB.status).toBe(201);
      ownerTokenB = regB.body.accessToken;

      const list = await api().get('/api/v1/users').set(auth(ownerTokenA));
      ownerMembershipA = list.body.find(
        (m: { role: { code: string } }) => m.role.code === 'OWNER',
      ).membershipId;

      const x = await api()
        .post('/api/v1/users/invite')
        .set(auth(ownerTokenA))
        .send({ email: emailX, roleCode: 'ACCOUNTANT', password: PASS });
      expect(x.status).toBe(201);
      xMembership = x.body.membershipId;

      const v = await api()
        .post('/api/v1/users/invite')
        .set(auth(ownerTokenA))
        .send({ email: emailV, roleCode: 'VIEWER', password: PASS });
      expect(v.status).toBe(201);
      vMembership = v.body.membershipId;

      const signIn = await login(emailX, PASS);
      expect(signIn.status).toBe(200);
      xToken = signIn.body.accessToken;
    });

    it('refuses an accountant promoting themself to OWNER', async () => {
      const res = await api()
        .patch(`/api/v1/users/${xMembership}`)
        .set(auth(xToken))
        .send({ roleCode: 'OWNER' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses anyone changing their own status, or the owner their own role', async () => {
      const selfSuspend = await api()
        .patch(`/api/v1/users/${xMembership}`)
        .set(auth(xToken))
        .send({ status: 'SUSPENDED' });
      expect(selfSuspend.status).toBe(403);

      const ownerSelf = await api()
        .patch(`/api/v1/users/${ownerMembershipA}`)
        .set(auth(ownerTokenA))
        .send({ roleCode: 'VIEWER' });
      expect(ownerSelf.status).toBe(403);
      expect(ownerSelf.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a non-owner granting OWNER to another member', async () => {
      const res = await api()
        .patch(`/api/v1/users/${vMembership}`)
        .set(auth(xToken))
        .send({ roleCode: 'OWNER' });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it("refuses a non-owner changing or suspending an owner's membership", async () => {
      const demote = await api()
        .patch(`/api/v1/users/${ownerMembershipA}`)
        .set(auth(xToken))
        .send({ roleCode: 'VIEWER' });
      expect(demote.status).toBe(403);

      const suspend = await api().delete(`/api/v1/users/${ownerMembershipA}`).set(auth(xToken));
      expect(suspend.status).toBe(403);
      expect(suspend.body.error.code).toBe('FORBIDDEN');
    });

    it('refuses a non-owner inviting with the OWNER role', async () => {
      const res = await api()
        .post('/api/v1/users/invite')
        .set(auth(xToken))
        .send({ email: `sa-would-be-owner-${RUN}@test.dev`, roleCode: 'OWNER', password: PASS });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('still lets a non-owner assign non-owner roles to others', async () => {
      const res = await api()
        .patch(`/api/v1/users/${vMembership}`)
        .set(auth(xToken))
        .send({ roleCode: 'ACCOUNTANT' });
      expect(res.status).toBe(200);
      expect(res.body.role.code).toBe('ACCOUNTANT');

      const back = await api()
        .patch(`/api/v1/users/${vMembership}`)
        .set(auth(ownerTokenA))
        .send({ roleCode: 'VIEWER' });
      expect(back.status).toBe(200);

      const roles = await api().get('/api/v1/users').set(auth(ownerTokenA));
      const x = roles.body.find((m: { membershipId: string }) => m.membershipId === xMembership);
      expect(x.role.code).toBe('ACCOUNTANT');
    });

    it('two owners demoting each other at once: exactly one wins, an owner remains', async () => {
      const promote = await api()
        .patch(`/api/v1/users/${vMembership}`)
        .set(auth(ownerTokenA))
        .send({ roleCode: 'OWNER' });
      expect(promote.status).toBe(200);
      const vToken = (await login(emailV, PASS)).body.accessToken;

      const [aDemotesV, vDemotesA] = await Promise.all([
        api()
          .patch(`/api/v1/users/${vMembership}`)
          .set(auth(ownerTokenA))
          .send({ roleCode: 'VIEWER' }),
        api()
          .patch(`/api/v1/users/${ownerMembershipA}`)
          .set(auth(vToken))
          .send({ roleCode: 'VIEWER' }),
      ]);
      expect([aDemotesV.status, vDemotesA.status].sort()).toEqual([200, 409]);

      const list = await api().get('/api/v1/users').set(auth(xToken));
      const owners = list.body.filter((m: { role: { code: string } }) => m.role.code === 'OWNER');
      expect(owners).toHaveLength(1);
    });

    it("isolation: tenant B's owner cannot change a membership of tenant A", async () => {
      const res = await api()
        .patch(`/api/v1/users/${vMembership}`)
        .set(auth(ownerTokenB))
        .send({ roleCode: 'OWNER' });
      expect(res.status).toBe(404);
    });
  });

  describe('PLAT-03: refresh rotation', () => {
    it('six concurrent refreshes with one cookie: exactly one wins, the family stays alive', async () => {
      const signIn = await login(emailV, PASS);
      expect(signIn.status).toBe(200);
      const cookie = refreshOf(signIn);

      const results = await Promise.all(Array.from({ length: 6 }, () => refresh(cookie)));
      const winners = results.filter((r) => r.status === 200);
      expect(winners).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(5);

      // Losers within the grace window do not revoke the family: one live token.
      const next = refreshOf(winners[0]!);
      expect(await liveTokensInFamilyOf(next)).toBe(1);

      const again = await refresh(next);
      expect(again.status).toBe(200);
      expect(await liveTokensInFamilyOf(refreshOf(again))).toBe(1);
    });

    it('reuse of a rotated token after the grace window revokes the whole family', async () => {
      const signIn = await login(emailV, PASS);
      const first = refreshOf(signIn);
      const rotated = await refresh(first);
      expect(rotated.status).toBe(200);
      const second = refreshOf(rotated);

      // Age the first rotation past the 10-second window.
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = UTC_TIMESTAMP(3) - INTERVAL 11 SECOND WHERE token_hash = ?`,
        [sha256(first)],
      );

      const reuse = await refresh(first);
      expect(reuse.status).toBe(401);
      expect(await liveTokensInFamilyOf(second)).toBe(0);
      expect((await refresh(second)).status).toBe(401);
    });
  });

  describe('PLAT-04: plan limits under concurrency', () => {
    it('six concurrent warehouse creations on TRIAL (limit 1) never exceed the limit', async () => {
      const before = await api().get('/api/v1/warehouses').set(auth(ownerTokenB));
      expect(before.status).toBe(200);
      const beforeCount = (before.body as unknown[]).length;

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          api()
            .post('/api/v1/warehouses')
            .set(auth(ownerTokenB))
            .send({ code: `SA-WH-${RUN}-${i}`, nameAr: `مستودع ${i}` }),
        ),
      );
      const created = results.filter((r) => r.status === 201).length;
      expect(created).toBe(Math.max(0, 1 - beforeCount));
      for (const r of results.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(402);
        expect(r.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
      }

      const after = await api().get('/api/v1/warehouses').set(auth(ownerTokenB));
      expect((after.body as unknown[]).length).toBe(beforeCount + created);
    });

    it('five concurrent invites on TRIAL (3 users, owner present) admit exactly two', async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          api()
            .post('/api/v1/users/invite')
            .set(auth(ownerTokenB))
            .send({ email: `sa-b-${i}-${RUN}@test.dev`, roleCode: 'VIEWER', password: PASS }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(2);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(402);
        expect(r.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
      }

      const list = await api().get('/api/v1/users').set(auth(ownerTokenB));
      expect(list.body).toHaveLength(3);
    });
  });
});
