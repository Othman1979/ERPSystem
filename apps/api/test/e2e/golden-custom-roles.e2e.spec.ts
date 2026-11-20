/**
 * Phase 23 (ADR-038): a company's own roles. G1 a custom role replaces the
 * system role's permissions in the guard and /me; G2 editing it applies on the
 * next request, and a role in use cannot be deleted; G3 the catalog limits.
 * Real MariaDB (erp_test), two tenants (A & B). Spawns the BUILT API.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { ROLE_PERMISSIONS } from '../../src/common/permissions/permissions.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3693;
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

describe('custom roles (erp_test)', () => {
  const emailA = `cr-owner-a-${RUN}@test.dev`;
  const emailB = `cr-owner-b-${RUN}@test.dev`;
  const emailX = `cr-member-${RUN}@test.dev`;
  const emailY = `cr-member-b-${RUN}@test.dev`;
  let ownerA = '';
  let ownerB = '';
  let xToken = '';
  let xMembership = '';
  let yMembership = '';
  let roleId = '';

  const me = async (token: string) => (await api().get('/api/v1/me').set(auth(token))).body.currentMembership;

  it('sets up tenant A (owner, viewer X) and tenant B (owner, viewer Y)', async () => {
    const a = await api().post('/api/v1/auth/register').send({ tenantName: `CR A ${RUN}`, ownerName: 'Owner A', email: emailA, password: PASS });
    const b = await api().post('/api/v1/auth/register').send({ tenantName: `CR B ${RUN}`, ownerName: 'Owner B', email: emailB, password: PASS });
    expect([a.status, b.status]).toEqual([201, 201]);
    ownerA = a.body.accessToken;
    ownerB = b.body.accessToken;
    const x = await addMember(BASE, ownerA, { email: emailX, roleCode: 'VIEWER', password: PASS });
    xToken = x.token;
    xMembership = x.membershipId;
    yMembership = (await addMember(BASE, ownerB, { email: emailY, roleCode: 'VIEWER', password: PASS })).membershipId;
  });

  it('G3: the catalog leaves out team management and the per-member purchase permissions', async () => {
    const res = await api().get('/api/v1/roles/catalog').set(auth(ownerA));
    expect(res.status).toBe(200);
    for (const code of ['user.manage', 'platform.admin', 'purchase.direct', 'purchase.approve', 'stock.issue_without_request']) {
      expect(res.body.assignable).not.toContain(code);
    }
    expect(res.body.assignable).toContain('warehouse.manage');
    for (const bad of ['user.manage', 'platform.admin', 'purchase.approve']) {
      const r = await api().post('/api/v1/roles/custom').set(auth(ownerA)).send({ code: 'BAD', nameAr: 'x', permissions: [bad] });
      expect(r.status).toBe(400);
    }
  });

  it('G1: creates a role (tenant.read always added) and refuses a second with the same code', async () => {
    const res = await api()
      .post('/api/v1/roles/custom')
      .set(auth(ownerA))
      .send({ code: 'CLERK', nameAr: 'كاتب', nameEn: 'Clerk', permissions: ['reports.view', 'parties.manage'] });
    expect(res.status).toBe(201);
    expect(res.body.permissions).toEqual(['parties.manage', 'reports.view', 'tenant.read']);
    expect(res.body.memberCount).toBe(0);
    roleId = res.body.id;
    const dup = await api().post('/api/v1/roles/custom').set(auth(ownerA)).send({ code: 'CLERK', nameAr: 'y', permissions: [] });
    expect(dup.status).toBe(409);
  });

  it('G1: the assigned role replaces the system role in /me and in the guard', async () => {
    expect((await api().post('/api/v1/warehouses').set(auth(xToken)).send({ code: `W${RUN}`, nameAr: 'w' })).status).toBe(403);
    const assign = await api().patch(`/api/v1/users/${xMembership}`).set(auth(ownerA)).send({ customRoleId: roleId });
    expect(assign.status).toBe(200);
    expect(assign.body.customRole).toMatchObject({ id: roleId, code: 'CLERK' });
    const m = await me(xToken);
    expect(m.roleCode).toBe('VIEWER');
    expect(m.permissions).toEqual(['parties.manage', 'reports.view', 'tenant.read']);
    expect((await api().post('/api/v1/warehouses').set(auth(xToken)).send({ code: `W${RUN}`, nameAr: 'w' })).status).toBe(403);
  });

  it('G2: an edit applies on the next request; a role in use is not deleted', async () => {
    const put = await api()
      .put(`/api/v1/roles/custom/${roleId}`)
      .set(auth(ownerA))
      .send({ code: 'CLERK', nameAr: 'كاتب', permissions: ['warehouse.manage'] });
    expect(put.status).toBe(200);
    expect(put.body.memberCount).toBe(1);
    expect((await api().post('/api/v1/warehouses').set(auth(xToken)).send({ code: `W${RUN}`, nameAr: 'w' })).status).toBe(201);
    expect((await me(xToken)).permissions).toEqual(['tenant.read', 'warehouse.manage']);

    const del = await api().delete(`/api/v1/roles/custom/${roleId}`).set(auth(ownerA));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe('ROLE_IN_USE');
  });

  it('an owner never holds a custom role', async () => {
    const r = await api().patch(`/api/v1/users/${xMembership}`).set(auth(ownerA)).send({ roleCode: 'OWNER', customRoleId: roleId });
    expect(r.status).toBe(400);
  });

  it('isolation: tenant B neither sees, edits, deletes nor assigns A\'s role', async () => {
    // B may reuse A's code: codes are unique per company, and A's role stays as it was.
    const own = await api().post('/api/v1/roles/custom').set(auth(ownerB)).send({ code: 'CLERK', nameAr: 'B', permissions: [] });
    expect(own.status).toBe(201);
    expect(own.body.id).not.toBe(roleId);
    const listA = await api().get('/api/v1/roles/custom').set(auth(ownerA));
    expect(listA.body.find((r: { id: string }) => r.id === roleId)).toMatchObject({ nameAr: 'كاتب', permissions: ['tenant.read', 'warehouse.manage'] });
    const list = await api().get('/api/v1/roles/custom').set(auth(ownerB));
    expect(list.status).toBe(200);
    expect(list.body.map((r: { id: string }) => r.id)).not.toContain(roleId);
    expect((await api().put(`/api/v1/roles/custom/${roleId}`).set(auth(ownerB)).send({ code: 'CLERK', nameAr: 'x', permissions: [] })).status).toBe(404);
    expect((await api().delete(`/api/v1/roles/custom/${roleId}`).set(auth(ownerB))).status).toBe(404);
    expect((await api().patch(`/api/v1/users/${yMembership}`).set(auth(ownerB)).send({ customRoleId: roleId })).status).toBe(404);
  });

  it('a member without user.manage cannot list roles', async () => {
    expect((await api().get('/api/v1/roles/custom').set(auth(xToken))).status).toBe(403);
  });

  it('clearing the role restores the system role; then the role deletes', async () => {
    const clear = await api().patch(`/api/v1/users/${xMembership}`).set(auth(ownerA)).send({ customRoleId: null });
    expect(clear.status).toBe(200);
    expect(clear.body.customRole).toBeNull();
    expect((await me(xToken)).permissions).toEqual([...ROLE_PERMISSIONS.VIEWER!].sort());
    expect((await api().delete(`/api/v1/roles/custom/${roleId}`).set(auth(ownerA))).status).toBe(200);
  });
});
