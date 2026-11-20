/**
 * Phase 25 (ADR-040): several companies in one tenant. C1 the owner adds a company with its own
 * chart and MAIN branch, picked with X-Company-Id; C2 a company of another tenant, or a bad id,
 * is refused; C3 a member restricted to one company cannot use the other, and the last active
 * company cannot be deactivated. Real MariaDB, two tenants (A & B). Spawns the BUILT API.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3872;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string, companyId?: string) => ({
  Authorization: `Bearer ${token}`,
  ...(companyId ? { 'X-Company-Id': companyId } : {}),
});

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
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(), API_PORT: String(API_PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

describe('multi-company (ADR-040)', () => {
  let ownerA = '';
  let ownerB = '';
  let memberToken = '';
  let memberMembership = '';
  let first = '';
  let second = '';

  const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));

  it('sets up tenant A (owner, accountant) and tenant B (owner)', async () => {
    const a = await api().post('/api/v1/auth/register').send({ tenantName: `MC A ${RUN}`, ownerName: 'Owner A', email: `mc-a-${RUN}@test.dev`, password: PASS });
    const b = await api().post('/api/v1/auth/register').send({ tenantName: `MC B ${RUN}`, ownerName: 'Owner B', email: `mc-b-${RUN}@test.dev`, password: PASS });
    expect([a.status, b.status]).toEqual([201, 201]);
    ownerA = a.body.accessToken;
    ownerB = b.body.accessToken;
    const m = await addMember(BASE, ownerA, { email: `mc-m-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
    memberToken = m.token;
    memberMembership = m.membershipId;
    const list = await api().get('/api/v1/companies').set(auth(ownerA));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].current).toBe(true);
    first = list.body[0].id;
  });

  it('C1: the owner adds a company with its own chart and MAIN branch', async () => {
    const created = await api().post('/api/v1/companies').set(auth(ownerA)).send({ legalNameAr: 'الشركة الثانية', legalNameEn: 'Second Co' });
    expect(created.status).toBe(201);
    second = created.body.id;
    expect(second).not.toBe(first);
    const denied = await api().post('/api/v1/companies').set(auth(memberToken)).send({ legalNameAr: 'x' });
    expect(denied.status).toBe(403);

    const listed = await api().get('/api/v1/companies').set(auth(ownerA, second));
    expect(listed.body.map((c: { id: string; current: boolean }) => [c.id, c.current])).toEqual([[first, false], [second, true]]);

    const accounts1 = await api().get('/api/v1/accounts').set(auth(ownerA, first));
    const accounts2 = await api().get('/api/v1/accounts').set(auth(ownerA, second));
    expect([accounts1.status, accounts2.status]).toEqual([200, 200]);
    expect(accounts2.body.length).toBeGreaterThan(0);
    const one = ids(accounts1.body);
    expect(accounts2.body.some((r: { id: string }) => one.has(r.id))).toBe(false);

    const branches1 = await api().get('/api/v1/branches').set(auth(ownerA, first));
    const branches2 = await api().get('/api/v1/branches').set(auth(ownerA, second));
    expect([branches1.status, branches2.status]).toEqual([200, 200]);
    const b1 = ids(branches1.body.items ?? branches1.body);
    const rows2 = (branches2.body.items ?? branches2.body) as { id: string; code: string }[];
    expect(rows2.map((r) => r.code)).toEqual(['MAIN']);
    expect(rows2.some((r) => b1.has(r.id))).toBe(false);
  });

  it('C2: another tenant cannot pick the company, and the header must be an id', async () => {
    const other = await api().get('/api/v1/accounts').set(auth(ownerB, second));
    expect(other.status).toBe(403);
    expect(other.body.error.code).toBe('COMPANY_NOT_ALLOWED');
    const bad = await api().get('/api/v1/accounts').set(auth(ownerA, 'abc'));
    expect(bad.status).toBe(400);
    const patch = await api().patch(`/api/v1/companies/${second}`).set(auth(ownerB)).send({ legalNameAr: 'x' });
    expect(patch.status).toBe(404);
  });

  it('C3: a member restricted to the first company cannot use the second', async () => {
    const before = await api().get('/api/v1/accounts').set(auth(memberToken, second));
    expect(before.status).toBe(200);
    const restrict = await api().patch(`/api/v1/users/${memberMembership}`).set(auth(ownerA)).send({ companyIds: [first] });
    expect(restrict.status).toBe(200);
    expect(restrict.body.companyIds).toEqual([first]);
    const after = await api().get('/api/v1/accounts').set(auth(memberToken, second));
    expect(after.status).toBe(403);
    const listed = await api().get('/api/v1/companies').set(auth(memberToken));
    expect(listed.body.map((c: { id: string }) => c.id)).toEqual([first]);
  });

  it('C3: the last active company cannot be deactivated', async () => {
    const off = await api().patch(`/api/v1/companies/${second}`).set(auth(ownerA)).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    const last = await api().patch(`/api/v1/companies/${first}`).set(auth(ownerA)).send({ isActive: false });
    expect(last.status).toBe(409);
    const gone = await api().get('/api/v1/accounts').set(auth(ownerA, second));
    expect(gone.status).toBe(403);
  });
});
