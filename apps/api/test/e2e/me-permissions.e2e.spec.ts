/**
 * GET /me lists the caller's permission codes for the ACTIVE tenant (Wave 3B):
 * the web hides menu entries, routes and buttons the role cannot use.
 * Real MariaDB (erp_test), two tenants (A & B).
 *
 * Spawns the BUILT API (`node dist/main.js`). Run `pnpm build` first.
 * Tenant A: owner A and accountant X. Tenant B: owner B, with X invited as a
 * viewer, so one user holds a different role in each tenant.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../src/common/permissions/permissions.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3681;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sorted = (codes: readonly string[]) => [...codes].sort();

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
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

describe('GET /me permissions (erp_test)', () => {
  const emailA = `mp-owner-a-${RUN}@test.dev`;
  const emailB = `mp-owner-b-${RUN}@test.dev`;
  const emailX = `mp-accountant-${RUN}@test.dev`;

  let ownerTokenA = '';
  let ownerTokenB = '';
  let xTokenA = '';
  let tenantB = '';

  it('sets up tenant A (owner, accountant X) and tenant B (owner, X as viewer)', async () => {
    const regA = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `MP A ${RUN}`, ownerName: 'Owner A', email: emailA, password: PASS });
    expect(regA.status).toBe(201);
    ownerTokenA = regA.body.accessToken;

    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `MP B ${RUN}`, ownerName: 'Owner B', email: emailB, password: PASS });
    expect(regB.status).toBe(201);
    ownerTokenB = regB.body.accessToken;
    const meB = await api().get('/api/v1/me').set(auth(ownerTokenB));
    tenantB = meB.body.currentTenant.tenantId;

    xTokenA = (await addMember(BASE, ownerTokenA, { email: emailX, roleCode: 'ACCOUNTANT', password: PASS })).token;
    await addMember(BASE, ownerTokenB, { email: emailX, roleCode: 'VIEWER', password: PASS, tenantId: tenantB });
  });

  it("lists every tenant permission for the owner, user.manage included, and never platform.admin", async () => {
    const res = await api().get('/api/v1/me').set(auth(ownerTokenA));
    expect(res.status).toBe(200);
    const permissions: string[] = res.body.currentMembership.permissions;
    expect(permissions).toEqual(sorted(ROLE_PERMISSIONS.OWNER!));
    expect(permissions).toContain(PERMISSIONS.USER_MANAGE);
    expect(permissions).not.toContain(PERMISSIONS.PLATFORM_ADMIN);
  });

  it('lists the accountant role without user.manage, matching the 403 on /users', async () => {
    const res = await api().get('/api/v1/me').set(auth(xTokenA));
    expect(res.status).toBe(200);
    expect(res.body.currentMembership.roleCode).toBe('ACCOUNTANT');
    const permissions: string[] = res.body.currentMembership.permissions;
    expect(permissions).toEqual(sorted(ROLE_PERMISSIONS.ACCOUNTANT!));
    expect(permissions).not.toContain(PERMISSIONS.USER_MANAGE);
    expect(permissions).toContain(PERMISSIONS.JOURNAL_POST);

    // What /me says is what the guard enforces.
    const users = await api().get('/api/v1/users').set(auth(xTokenA));
    expect(users.status).toBe(403);
  });

  it("isolation: the same user gets tenant B's role permissions only while signed in to B", async () => {
    const login = await api().post('/api/v1/auth/login').send({ email: emailX, password: PASS, tenantId: tenantB });
    expect(login.status).toBe(200);
    const res = await api().get('/api/v1/me').set(auth(login.body.accessToken));
    expect(res.status).toBe(200);
    expect(res.body.currentTenant.tenantId).toBe(tenantB);
    expect(res.body.currentMembership.roleCode).toBe('VIEWER');
    expect(res.body.currentMembership.permissions).toEqual(sorted(ROLE_PERMISSIONS.VIEWER!));
    // Nothing of tenant A's accountant role leaks into B.
    expect(res.body.currentMembership.permissions).not.toContain(PERMISSIONS.JOURNAL_POST);

    // And back in A, the accountant role again.
    const inA = await api().get('/api/v1/me').set(auth(xTokenA));
    expect(inA.body.currentMembership.permissions).toEqual(sorted(ROLE_PERMISSIONS.ACCOUNTANT!));
  });

  it("isolation: owner B's /me carries B's membership only", async () => {
    const res = await api().get('/api/v1/me').set(auth(ownerTokenB));
    expect(res.status).toBe(200);
    expect(res.body.currentTenant.tenantId).toBe(tenantB);
    expect(res.body.tenants).toHaveLength(1);
    expect(res.body.currentMembership.permissions).toEqual(sorted(ROLE_PERMISSIONS.OWNER!));
  });
});
