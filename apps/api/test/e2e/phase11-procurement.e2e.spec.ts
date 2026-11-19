/**
 * Phase 11B — procurement level and purchase permissions (ADR-013 §1–2, ADR-024 §2–3):
 *  - companies.procurement_level: raised any time; lowered only while no open
 *    cycle document is counted (a test-only counter, NODE_ENV=test, stands in
 *    for phases 12–13); company.manage; audited; tenant B unaffected;
 *  - member_permissions: owner-only PUT users/:membershipId/purchase-permissions,
 *    each grant, revoke and limit change audited; GET users and /me show them;
 *    TenantGuard adds them to the request permissions (a test-only route
 *    guarded by purchase.approve); tenant B can neither see nor change A's.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../../src/common/permissions/permissions.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3711;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p11-audit-${RUN}.jsonl`);

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const sorted = (codes: readonly string[]) => [...new Set(codes)].sort();

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
    // Its own response audit file: the test routes here are undocumented on purpose,
    // so the last test checks that they are the only findings (ADR-023).
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
      OPENAPI_RESPONSE_AUDIT: AUDIT_FILE,
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
  rmSync(AUDIT_FILE, { force: true });
});

/** JSON columns come back as text or as objects, by driver version. */
const json = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as unknown) : v);

/** member_permissions rows of a tenant (one member's, when given). */
async function grantsOf(tenantId: string, membershipId?: string): Promise<number> {
  const [r] = (await db.query(
    `SELECT COUNT(*) AS n FROM member_permissions WHERE tenant_id = ?${membershipId ? ' AND membership_id = ?' : ''}`,
    membershipId ? [tenantId, membershipId] : [tenantId],
  )) as { n: bigint }[];
  return Number(r.n);
}

describe('Phase 11B — procurement level and purchase permissions', () => {
  const emailX = `p11-acc-${RUN}@test.dev`;
  let ownerA = '';
  let ownerB = '';
  let tenantA = '';
  let tenantB = '';
  let ownerMembershipA = '';
  let xMembership = '';
  let xA = '';
  let xB = '';

  const company = (token: string) => api().get('/api/v1/company').set(auth(token));
  const setLevel = (token: string, procurementLevel: string) =>
    api().patch('/api/v1/company').set(auth(token)).send({ procurementLevel });
  const openDocuments = (token: string, count: number) =>
    api().put('/api/v1/__test/procurement/open-documents').set(auth(token)).send({ count });
  const setPermissions = (token: string, membershipId: string, permissions: object[]) =>
    api().put(`/api/v1/users/${membershipId}/purchase-permissions`).set(auth(token)).send({ permissions });
  const me = async (token: string) => (await api().get('/api/v1/me').set(auth(token))).body.currentMembership;
  const approveCheck = (token: string) => api().get('/api/v1/__test/procurement/approve-check').set(auth(token));

  it('setup: tenant A (owner, accountant X) and tenant B (owner, X as viewer)', async () => {
    for (const tag of ['a', 'b']) {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `P11 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p11-${tag}-${RUN}@test.dev`, password: PASS });
      expect(res.status).toBe(201);
      if (tag === 'a') ownerA = res.body.accessToken;
      else ownerB = res.body.accessToken;
    }
    tenantA = (await api().get('/api/v1/me').set(auth(ownerA))).body.currentTenant.tenantId;
    tenantB = (await api().get('/api/v1/me').set(auth(ownerB))).body.currentTenant.tenantId;
    ownerMembershipA = (await me(ownerA)).membershipId;

    const x = await addMember(BASE, ownerA, { email: emailX, roleCode: 'ACCOUNTANT', password: PASS });
    xMembership = x.membershipId;
    xA = x.token;
    xB = (await addMember(BASE, ownerB, { email: emailX, roleCode: 'VIEWER', password: PASS, tenantId: tenantB })).token;
  });

  describe('procurement level (ADR-024 §2)', () => {
    it('starts SIMPLE', async () => {
      const res = await company(ownerA);
      expect(res.status).toBe(200);
      expect(res.body.procurementLevel).toBe('SIMPLE');
    });

    it('is raised any time, by a company.manage holder too, and the change is audited', async () => {
      const res = await setLevel(xA, 'MEDIUM');
      expect(res.status).toBe(200);
      expect(res.body.procurementLevel).toBe('MEDIUM');
      expect((await setLevel(ownerA, 'FULL')).body.procurementLevel).toBe('FULL');

      const rows = (await db.query(
        "SELECT before_json, after_json FROM audit_logs WHERE tenant_id = ? AND action = 'company.update' ORDER BY id",
        [tenantA],
      )) as { before_json: unknown; after_json: unknown }[];
      expect(rows.map((r) => [(json(r.before_json) as { procurementLevel: string }).procurementLevel, (json(r.after_json) as { procurementLevel: string }).procurementLevel])).toEqual([
        ['SIMPLE', 'MEDIUM'],
        ['MEDIUM', 'FULL'],
      ]);
    });

    it('refuses a lowering while a cycle document is open, and keeps the level', async () => {
      expect((await openDocuments(ownerA, 2)).body).toEqual({ count: 2 });
      const res = await setLevel(ownerA, 'MEDIUM');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS');
      expect(res.body.error.details).toEqual({ from: 'FULL', to: 'MEDIUM', openDocuments: { testDocuments: 2 } });
      expect((await setLevel(ownerA, 'SIMPLE')).status).toBe(409);
      expect((await company(ownerA)).body.procurementLevel).toBe('FULL');
      // The same level is not a change: the rest of the profile still saves.
      const same = await api().patch('/api/v1/company').set(auth(ownerA)).send({ procurementLevel: 'FULL', phone: '0790000000' });
      expect([same.status, same.body.phone]).toEqual([200, '0790000000']);
    });

    it("isolation: A's open documents do not hold tenant B, and B never changes A", async () => {
      expect((await setLevel(ownerB, 'FULL')).status).toBe(200);
      const lowered = await setLevel(ownerB, 'SIMPLE');
      expect([lowered.status, lowered.body.procurementLevel]).toEqual([200, 'SIMPLE']);
      expect((await company(ownerB)).body.legalNameAr).not.toBe((await company(ownerA)).body.legalNameAr);
      expect((await company(ownerA)).body.procurementLevel).toBe('FULL');
    });

    it('lowers once nothing is open; raising with open documents is allowed', async () => {
      await openDocuments(ownerA, 0);
      expect((await setLevel(ownerA, 'SIMPLE')).body.procurementLevel).toBe('SIMPLE');
      await openDocuments(ownerA, 1);
      expect((await setLevel(ownerA, 'MEDIUM')).body.procurementLevel).toBe('MEDIUM');
      expect((await setLevel(ownerA, 'SIMPLE')).status).toBe(409);
      await openDocuments(ownerA, 0);
      expect((await setLevel(ownerA, 'SIMPLE')).status).toBe(200);
    });

    it('validates the value, and needs the settings role', async () => {
      const bad = await setLevel(ownerA, 'HUGE');
      expect([bad.status, bad.body.error.code]).toEqual([400, 'VALIDATION']);
      expect((await setLevel(xB, 'FULL')).status).toBe(403); // a viewer in B
    });
  });

  describe('purchase permissions per member (ADR-024 §3)', () => {
    it('GET users: the owner holds every member permission without a limit, a member none', async () => {
      const res = await api().get('/api/v1/users').set(auth(ownerA));
      expect(res.status).toBe(200);
      const byId = new Map((res.body as { membershipId: string; purchasePermissions: unknown }[]).map((m) => [m.membershipId, m.purchasePermissions]));
      expect(byId.get(ownerMembershipA)).toEqual([
        { code: 'purchase.direct', amountLimit: null },
        { code: 'purchase.approve', amountLimit: null },
        { code: 'sales.approve', amountLimit: null },
        { code: 'stock.issue_without_request', amountLimit: null },
      ]);
      expect(byId.get(xMembership)).toEqual([]);
    });

    it('/me: the owner role carries them; the member has none, and the guard refuses', async () => {
      const owner = await me(ownerA);
      expect(owner.permissions).toEqual(sorted(ROLE_PERMISSIONS.OWNER!));
      expect(owner.permissions).toContain(PERMISSIONS.PURCHASE_APPROVE);
      expect(owner.approvalLimit).toBeNull();
      expect((await approveCheck(ownerA)).status).toBe(200);

      const x = await me(xA);
      expect(x.permissions).toEqual(sorted(ROLE_PERMISSIONS.ACCOUNTANT!));
      expect(x.approvalLimit).toBeNull();
      expect((await approveCheck(xA)).status).toBe(403);
    });

    it('the owner grants: /me, GET users and the guard all see it', async () => {
      const res = await setPermissions(ownerA, xMembership, [
        { code: 'stock.issue_without_request' },
        { code: 'purchase.approve', amountLimit: '1500.5' },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.purchasePermissions).toEqual([
        { code: 'purchase.approve', amountLimit: '1500.500' },
        { code: 'stock.issue_without_request', amountLimit: null },
      ]);

      const x = await me(xA);
      expect(x.permissions).toEqual(sorted([...ROLE_PERMISSIONS.ACCOUNTANT!, 'purchase.approve', 'stock.issue_without_request']));
      expect(x.approvalLimit).toBe('1500.500');
      expect((await approveCheck(xA)).status).toBe(200);

      const users = (await api().get('/api/v1/users').set(auth(ownerA))).body as { membershipId: string; purchasePermissions: unknown }[];
      expect(users.find((m) => m.membershipId === xMembership)!.purchasePermissions).toEqual(res.body.purchasePermissions);
    });

    it('changes and revokes; every grant, revoke and limit change is one audit row', async () => {
      const changed = await setPermissions(ownerA, xMembership, [{ code: 'purchase.approve' }, { code: 'purchase.direct' }]);
      expect(changed.status).toBe(200);
      expect(changed.body.purchasePermissions).toEqual([
        { code: 'purchase.direct', amountLimit: null },
        { code: 'purchase.approve', amountLimit: null },
      ]);
      const x = await me(xA);
      expect(x.approvalLimit).toBeNull();
      expect(x.permissions).toContain('purchase.direct');
      expect(x.permissions).not.toContain('stock.issue_without_request');

      // The same set again changes nothing and writes no audit row.
      expect((await setPermissions(ownerA, xMembership, [{ code: 'purchase.direct' }, { code: 'purchase.approve' }])).status).toBe(200);

      const revoked = await setPermissions(ownerA, xMembership, []);
      expect([revoked.status, revoked.body.purchasePermissions]).toEqual([200, []]);
      expect((await approveCheck(xA)).status).toBe(403);
      expect((await me(xA)).permissions).toEqual(sorted(ROLE_PERMISSIONS.ACCOUNTANT!));

      const rows = (await db.query(
        "SELECT action, user_id, before_json, after_json FROM audit_logs WHERE tenant_id = ? AND entity_type = 'tenant_membership' AND entity_id = ? AND action LIKE 'user.purchase_permission_%' ORDER BY id",
        [tenantA, xMembership],
      )) as { action: string; user_id: bigint; before_json: unknown; after_json: unknown }[];
      expect(rows.map((r) => [r.action, json(r.before_json), json(r.after_json)])).toEqual([
        ['user.purchase_permission_grant', null, { code: 'stock.issue_without_request', amountLimit: null }],
        ['user.purchase_permission_grant', null, { code: 'purchase.approve', amountLimit: '1500.500' }],
        ['user.purchase_permission_grant', null, { code: 'purchase.direct', amountLimit: null }],
        ['user.purchase_permission_revoke', { code: 'stock.issue_without_request', amountLimit: null }, null],
        ['user.purchase_permission_limit', { code: 'purchase.approve', amountLimit: '1500.500' }, { code: 'purchase.approve', amountLimit: null }],
        ['user.purchase_permission_revoke', { code: 'purchase.approve', amountLimit: null }, null],
        ['user.purchase_permission_revoke', { code: 'purchase.direct', amountLimit: null }, null],
      ]);
      const [owner] = (await db.query('SELECT id FROM users WHERE email = ?', [`p11-a-${RUN}@test.dev`])) as { id: bigint }[];
      expect(new Set(rows.map((r) => String(r.user_id)))).toEqual(new Set([String(owner.id)]));
    });

    it('validates the body', async () => {
      const cases: object[][] = [
        [{ code: 'purchase.direct', amountLimit: '10' }], // a limit on another code
        [{ code: 'purchase.approve', amountLimit: '0' }],
        [{ code: 'purchase.approve', amountLimit: '1.2345' }],
        [{ code: 'purchase.approve', amountLimit: '-5' }],
        [{ code: 'purchase.approve', amountLimit: 15 }],
        [{ code: 'user.manage' }],
        [{ code: 'purchase.direct' }, { code: 'purchase.direct' }],
        [{ code: 'purchase.direct', extra: true }],
      ];
      for (const permissions of cases) {
        const res = await setPermissions(ownerA, xMembership, permissions);
        expect([JSON.stringify(permissions), res.status, res.body.error?.code]).toEqual([JSON.stringify(permissions), 400, 'VALIDATION']);
      }
      expect((await api().put(`/api/v1/users/${xMembership}/purchase-permissions`).set(auth(ownerA)).send({})).status).toBe(400);
      expect((await api().put('/api/v1/users/abc/purchase-permissions').set(auth(ownerA)).send({ permissions: [] })).status).toBe(400);
      // An owner holds them all already.
      const owner = await setPermissions(ownerA, ownerMembershipA, [{ code: 'purchase.direct' }]);
      expect([owner.status, owner.body.error.code]).toEqual([400, 'VALIDATION']);
      expect(await grantsOf(tenantA)).toBe(0);
    });

    it('takes a null limit as no limit, as GET users shows it, on any code', async () => {
      const res = await setPermissions(ownerA, xMembership, [
        { code: 'purchase.approve', amountLimit: null },
        { code: 'purchase.direct', amountLimit: null },
      ]);
      expect(res.status).toBe(200);
      expect(res.body.purchasePermissions).toEqual([
        { code: 'purchase.direct', amountLimit: null },
        { code: 'purchase.approve', amountLimit: null },
      ]);
      expect((await me(xA)).approvalLimit).toBeNull();
      // What GET users answers can be sent back unchanged.
      const back = await setPermissions(ownerA, xMembership, res.body.purchasePermissions as object[]);
      expect([back.status, back.body.purchasePermissions]).toEqual([200, res.body.purchasePermissions]);
      expect((await setPermissions(ownerA, xMembership, [])).status).toBe(200);
    });

    it('a non-owner cannot grant, not even to themself', async () => {
      const res = await setPermissions(xA, xMembership, [{ code: 'purchase.direct' }]);
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
      expect((await me(xA)).permissions).not.toContain('purchase.direct');
    });

    it("isolation: tenant B can neither change nor see A's member, and A's grants stay in A", async () => {
      expect((await setPermissions(ownerA, xMembership, [{ code: 'purchase.approve', amountLimit: '99' }])).status).toBe(200);

      const fromB = await setPermissions(ownerB, xMembership, [{ code: 'purchase.direct' }]);
      expect([fromB.status, fromB.body.error.code]).toEqual([404, 'NOT_FOUND']);
      const listB = (await api().get('/api/v1/users').set(auth(ownerB))).body as { membershipId: string; purchasePermissions: unknown[] }[];
      expect(listB.map((m) => m.membershipId)).not.toContain(xMembership);
      expect(listB.flatMap((m) => m.purchasePermissions).filter((p) => (p as { amountLimit: string | null }).amountLimit !== null)).toEqual([]);

      // The same user signed in to B: B's viewer role only, no limit from A.
      const inB = await me(xB);
      expect(inB.permissions).toEqual(sorted(ROLE_PERMISSIONS.VIEWER!));
      expect(inB.approvalLimit).toBeNull();
      expect((await approveCheck(xB)).status).toBe(403);
      // And in A, the grant is still there.
      expect((await me(xA)).approvalLimit).toBe('99.000');
      const usersA = (await api().get('/api/v1/users').set(auth(ownerA))).body as { membershipId: string; purchasePermissions: unknown }[];
      expect(usersA.find((m) => m.membershipId === xMembership)!.purchasePermissions).toEqual([{ code: 'purchase.approve', amountLimit: '99.000' }]);
      expect(tenantB).not.toBe(tenantA);
    });

    it("cancelling an invitation removes the invitee's grants (FK cascade)", async () => {
      const invited = await api()
        .post('/api/v1/users/invite')
        .set(auth(ownerA))
        .send({ email: `p11-b-${RUN}@test.dev`, roleCode: 'CASHIER' });
      // The owner of B is an existing user: an INVITED membership in A.
      expect(invited.status).toBe(201);
      const id = invited.body.membershipId as string;
      expect((await setPermissions(ownerA, id, [{ code: 'purchase.direct' }])).status).toBe(200);
      expect(await grantsOf(tenantA, id)).toBe(1);
      expect((await api().delete(`/api/v1/users/${id}`).set(auth(ownerA))).status).toBe(200);
      expect(await grantsOf(tenantA, id)).toBe(0);
      expect(await grantsOf(tenantA, xMembership)).toBe(1);
    });

    it('a role change clears the grants, each revoke audited (ADR-024 §3.6)', async () => {
      const setRole = (roleCode: string) =>
        api().patch(`/api/v1/users/${xMembership}`).set(auth(ownerA)).send({ roleCode });

      // ACCOUNTANT → CASHIER: the approval granted to the accountant goes.
      expect((await setRole('CASHIER')).status).toBe(200);
      expect(await grantsOf(tenantA, xMembership)).toBe(0);

      // A cashier with purchase.approve, demoted to VIEWER, has none afterwards.
      expect((await setPermissions(ownerA, xMembership, [{ code: 'purchase.approve', amountLimit: '500' }])).status).toBe(200);
      expect((await approveCheck(xA)).status).toBe(200);
      const viewer = await setRole('VIEWER');
      expect([viewer.status, viewer.body.purchasePermissions]).toEqual([200, []]);
      expect(await grantsOf(tenantA, xMembership)).toBe(0);
      expect((await approveCheck(xA)).status).toBe(403);
      const x = await me(xA);
      expect([x.permissions, x.approvalLimit]).toEqual([sorted(ROLE_PERMISSIONS.VIEWER!), null]);

      // The same role again is not a change: the grant stays.
      expect((await setPermissions(ownerA, xMembership, [{ code: 'purchase.direct' }])).status).toBe(200);
      expect((await setRole('VIEWER')).status).toBe(200);
      expect(await grantsOf(tenantA, xMembership)).toBe(1);

      // Promoted to OWNER, then demoted: nothing is left.
      expect((await setRole('OWNER')).status).toBe(200);
      expect(await grantsOf(tenantA, xMembership)).toBe(0);
      expect((await setRole('VIEWER')).status).toBe(200);
      expect(await grantsOf(tenantA, xMembership)).toBe(0);
      expect((await me(xA)).permissions).toEqual(sorted(ROLE_PERMISSIONS.VIEWER!));

      const rows = (await db.query(
        "SELECT before_json, after_json FROM audit_logs WHERE tenant_id = ? AND entity_id = ? AND action = 'user.purchase_permission_revoke' AND CAST(after_json AS CHAR) LIKE '%role_change%' ORDER BY id",
        [tenantA, xMembership],
      )) as { before_json: unknown; after_json: unknown }[];
      expect(rows.map((r) => [json(r.before_json), json(r.after_json)])).toEqual([
        [{ code: 'purchase.approve', amountLimit: '99.000' }, { reason: 'role_change', roleCode: 'CASHIER' }],
        [{ code: 'purchase.approve', amountLimit: '500.000' }, { reason: 'role_change', roleCode: 'VIEWER' }],
        [{ code: 'purchase.direct', amountLimit: null }, { reason: 'role_change', roleCode: 'OWNER' }],
      ]);
    });

    it('the test counter route needs settings.manage', async () => {
      const res = await openDocuments(xA, 1); // X is a viewer now
      expect([res.status, res.body.error.code]).toEqual([403, 'FORBIDDEN']);
    });
  });

  it('response audit: only the undocumented test routes are recorded', () => {
    const findings = existsSync(AUDIT_FILE)
      ? readFileSync(AUDIT_FILE, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { route: string; problems: string[] })
      : [];
    const isTestRoute = (f: { route: string }) => f.route.startsWith('/api/v1/__test/procurement/');
    expect(findings.filter((f) => !isTestRoute(f))).toEqual([]);
    expect(findings.length).toBeGreaterThan(0); // the audit ran
    for (const f of findings) expect(f.problems).toEqual([expect.stringMatching(/^no operation (GET|PUT) \/api\/v1\/__test\/procurement\//)]);
  });
});
