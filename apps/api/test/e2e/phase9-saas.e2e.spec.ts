/**
 * Phase 9.1 — subscriptions and the platform console (ADR-009):
 *  - registration starts a TRIAL of TRIAL_DAYS;
 *  - the monthly sales-invoice quota of the plan (402 PLAN_LIMIT_EXCEEDED);
 *  - plans: list / edit by the platform admin only, amounts validated;
 *  - recording a payment: paid period with its amount, tenant ACTIVE;
 *  - `job:tenant-status`: TRIAL ended → SUSPENDED, period ended → PAST_DUE
 *    (period EXPIRED), grace over → SUSPENDED, CANCELLED past retention
 *    listed (never deleted); a second run changes nothing; audit rows;
 *  - a SUSPENDED tenant is read only.
 * Real MariaDB (erp_test) + built API and job. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3208;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const DAY = 24 * 60 * 60 * 1000;

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `p9-${RUN}-${Math.random().toString(36).slice(2)}` });

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

/** Runs the Cron command against erp_test and returns its JSON summary. */
async function runStatusJob() {
  const { stdout } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'tenant-status'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
  });
  return JSON.parse(stdout) as {
    changed: { tenantId: string; from: string; to: string }[];
    dueForDeletion: { tenantId: string }[];
    expiredSubscriptions: number;
  };
}

const sqlDate = (d: Date) => d.toISOString().slice(0, 10);

beforeAll(async () => {
  databaseUrl = testDatabaseUrl();
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
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

describe('Phase 9.1 — subscriptions and the platform console', () => {
  let adminToken = '';
  let token = '';
  let tokenB = '';
  let tenantA = '';
  const ids: Record<string, string> = {};
  let trialPlanBefore: { max_invoices_per_month: number } | undefined;

  // Registration allows 5 a minute per address (ADR-012): each tenant here comes from its own client address.
  let registrations = 0;
  async function register(tag: string) {
    const res = await api()
      .post('/api/v1/auth/register')
      .set('X-Forwarded-For', `198.51.100.${++registrations}`)
      .send({ tenantName: `P9 ${tag} ${RUN}`, ownerName: 'Owner', email: `p9-${tag}-${RUN}@test.dev`, password: PASS });
    expect(res.status).toBe(201);
    const me = await api().get('/api/v1/me').set(auth(res.body.accessToken));
    return { token: res.body.accessToken as string, tenantId: String(me.body.currentTenant.tenantId) };
  }

  afterAll(async () => {
    // Shared plans: put the trial quota back for the other suites.
    if (trialPlanBefore) {
      await db.query("UPDATE plans SET max_invoices_per_month = ? WHERE code = 'TRIAL'", [
        trialPlanBefore.max_invoices_per_month,
      ]);
    }
    server?.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
    await db?.end();
  });

  it('setup: a platform admin, tenant A with a customer and an item, tenant B', async () => {
    const admin = await register('admin');
    await db.query('UPDATE users SET is_platform_admin = 1 WHERE email = ?', [`p9-admin-${RUN}@test.dev`]);
    adminToken = admin.token;
    const a = await register('a');
    token = a.token;
    tenantA = a.tenantId;
    tokenB = (await register('b')).token;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    ids.wh = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    ids.item = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'S', nameAr: 'S', baseUnitId: pcs, itemKind: 'SERVICE' })
    ).body.id;
    ids.customer = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })
    ).body.id;
  });

  it('registration starts a TRIAL of TRIAL_DAYS (14)', async () => {
    const [t] = (await db.query('SELECT status, trial_ends_at, status_changed_at, created_at FROM tenants WHERE id = ?', [
      tenantA,
    ])) as { status: string; trial_ends_at: Date; status_changed_at: Date | null; created_at: Date }[];
    expect(t.status).toBe('TRIAL');
    const days = (t.trial_ends_at.getTime() - t.created_at.getTime()) / DAY;
    expect(days).toBeGreaterThan(13.99);
    expect(days).toBeLessThan(14.01);
    expect(t.status_changed_at).not.toBeNull();
  });

  it('plans: the platform admin lists and edits them; others get 403', async () => {
    expect((await api().get('/api/v1/admin/plans').set(auth(token))).status).toBe(403);
    expect((await api().patch('/api/v1/admin/plans/BASIC').set(auth(token)).send({ maxUsers: 9 })).status).toBe(403);

    const plans = await api().get('/api/v1/admin/plans').set(auth(adminToken));
    expect(plans.status).toBe(200);
    const codes = (plans.body as { code: string }[]).map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['TRIAL', 'BASIC', 'PRO']));

    expect(
      (await api().patch('/api/v1/admin/plans/BASIC').set(auth(adminToken)).send({ priceMonthly: '1.2345' })).status,
    ).toBe(400);
    expect((await api().patch('/api/v1/admin/plans/NOPE').set(auth(adminToken)).send({ maxUsers: 2 })).status).toBe(404);

    // Lower the trial quota to 2 invoices a month for the next test (restored in afterAll).
    [trialPlanBefore] = (await db.query("SELECT max_invoices_per_month FROM plans WHERE code = 'TRIAL'")) as {
      max_invoices_per_month: number;
    }[];
    const edit = await api().patch('/api/v1/admin/plans/TRIAL').set(auth(adminToken)).send({ maxInvoicesPerMonth: 2 });
    expect(edit.status).toBe(200);
    expect(edit.body.maxInvoicesPerMonth).toBe(2);
    const [audit] = (await db.query(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'admin.update_plan' AND entity_id = ?",
      [edit.body.id],
    )) as { n: bigint }[];
    expect(Number(audit.n)).toBeGreaterThan(0);
  });

  it('the monthly invoice quota: the third invoice of March is refused, April is fine', async () => {
    const sale = async (invoiceDate: string) => {
      const inv = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(token))
        .send({
          invoiceDate,
          customerId: ids.customer,
          warehouseId: ids.wh,
          paymentType: 'CREDIT',
          lines: [{ itemId: ids.item, qty: '1', unitPrice: '10.000' }],
        });
      expect(inv.status).toBe(201);
      return api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(token)).set(idem());
    };
    expect((await sale('2025-03-02')).status).toBe(201);
    expect((await sale('2025-03-20')).status).toBe(201);
    const third = await sale('2025-03-31');
    expect(third.status).toBe(402);
    expect(third.body.error.code).toBe('PLAN_LIMIT_EXCEEDED');
    expect(third.body.error.details).toEqual({ limit: 2, used: 2 });
    expect((await sale('2025-04-01')).status).toBe(201);
  });

  it('recording a payment creates a paid period with its amount and activates the tenant', async () => {
    const bad = await api()
      .post(`/api/v1/admin/tenants/${tenantA}/subscriptions`)
      .set(auth(adminToken))
      .send({ planCode: 'BASIC', periodEnd: '2099-01-31', amount: '15.0001' });
    expect(bad.status).toBe(400);

    const ok = await api()
      .post(`/api/v1/admin/tenants/${tenantA}/subscriptions`)
      .set(auth(adminToken))
      .send({ planCode: 'BASIC', periodStart: '2099-01-01', periodEnd: '2099-01-31', amount: '15.000', notes: 'CliQ 123' });
    expect(ok.status).toBe(201);
    const t = await api().get(`/api/v1/admin/tenants/${tenantA}`).set(auth(adminToken));
    expect([t.body.status, t.body.plan.code, t.body.trialEndsAt]).toEqual(['ACTIVE', 'BASIC', null]);
    expect(t.body.statusChangedAt).not.toBeNull();
    expect(t.body.subscriptions[0].amount).toBe('15');
    expect(t.body.subscriptions[0].notes).toBe('CliQ 123');
  });

  it('tenant B cannot reach the platform console', async () => {
    expect((await api().get('/api/v1/admin/tenants').set(auth(tokenB))).status).toBe(403);
    expect((await api().get(`/api/v1/admin/tenants/${tenantA}`).set(auth(tokenB))).status).toBe(403);
  });

  describe('job:tenant-status', () => {
    const t: Record<string, { token: string; tenantId: string }> = {};
    const now = Date.now();
    const statusOf = async (id: string) =>
      ((await db.query('SELECT status FROM tenants WHERE id = ?', [id])) as { status: string }[])[0].status;

    it('setup: tenants in every state', async () => {
      for (const tag of ['trial', 'expired', 'pastdue-old', 'pastdue-new', 'active', 'cancelled']) t[tag] = await register(tag);
      const planId = ((await db.query("SELECT id FROM plans WHERE code = 'BASIC'")) as { id: bigint }[])[0].id;
      const sub = (tag: string, end: Date) =>
        db.query(
          "INSERT INTO subscriptions (tenant_id, plan_id, period_start, period_end, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))",
          [t[tag].tenantId, planId, sqlDate(new Date(end.getTime() - 30 * DAY)), sqlDate(end)],
        );
      await db.query('UPDATE tenants SET trial_ends_at = ? WHERE id = ?', [new Date(now - DAY), t.trial.tenantId]);
      for (const [tag, status] of [
        ['expired', 'ACTIVE'],
        ['pastdue-old', 'PAST_DUE'],
        ['pastdue-new', 'PAST_DUE'],
        ['active', 'ACTIVE'],
      ] as const) {
        await db.query('UPDATE tenants SET status = ?, plan_id = ?, trial_ends_at = NULL WHERE id = ?', [
          status,
          planId,
          t[tag].tenantId,
        ]);
      }
      await sub('expired', new Date(now - 5 * DAY));
      await sub('pastdue-old', new Date(now - 30 * DAY));
      await sub('pastdue-new', new Date(now - 3 * DAY));
      await sub('active', new Date(now + 20 * DAY));
      await db.query("UPDATE tenants SET status = 'CANCELLED', status_changed_at = ? WHERE id = ?", [
        new Date(now - 100 * DAY),
        t.cancelled.tenantId,
      ]);
    }, 60_000);

    it('moves each tenant per ADR-009 and lists cancelled ones past retention', async () => {
      const run = await runStatusJob();
      const moved = (tag: string) => run.changed.find((c) => c.tenantId === t[tag].tenantId);
      expect(moved('trial')).toMatchObject({ from: 'TRIAL', to: 'SUSPENDED' });
      expect(moved('expired')).toMatchObject({ from: 'ACTIVE', to: 'PAST_DUE' });
      expect(moved('pastdue-old')).toMatchObject({ from: 'PAST_DUE', to: 'SUSPENDED' });
      expect(moved('pastdue-new')).toBeUndefined();
      expect(moved('active')).toBeUndefined();
      expect(run.dueForDeletion.map((d) => d.tenantId)).toContain(t.cancelled.tenantId);

      expect(await statusOf(t.trial.tenantId)).toBe('SUSPENDED');
      expect(await statusOf(t.expired.tenantId)).toBe('PAST_DUE');
      expect(await statusOf(t['pastdue-old'].tenantId)).toBe('SUSPENDED');
      expect(await statusOf(t['pastdue-new'].tenantId)).toBe('PAST_DUE');
      expect(await statusOf(t.active.tenantId)).toBe('ACTIVE');
      // Listed, never deleted.
      expect(await statusOf(t.cancelled.tenantId)).toBe('CANCELLED');

      // The paid period that ended is EXPIRED; the registration's trial period still runs.
      const subs = (await db.query(
        'SELECT p.code, s.status FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? ORDER BY p.code',
        [t.expired.tenantId],
      )) as { code: string; status: string }[];
      expect(subs.map((s) => [s.code, s.status])).toEqual([
        ['BASIC', 'EXPIRED'],
        ['TRIAL', 'ACTIVE'],
      ]);
      const audit = (await db.query(
        "SELECT before_json, after_json FROM audit_logs WHERE action = 'job.tenant_status' AND tenant_id = ?",
        [t.trial.tenantId],
      )) as { before_json: unknown; after_json: unknown }[];
      expect(audit).toHaveLength(1);
      // The driver returns JSON columns as text.
      const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as { status: string };
      expect([json(audit[0].before_json).status, json(audit[0].after_json).status]).toEqual(['TRIAL', 'SUSPENDED']);
    }, 60_000);

    it('a second run the same day changes nothing for these tenants', async () => {
      const run = await runStatusJob();
      const mine = new Set(Object.values(t).map((x) => x.tenantId));
      expect(run.changed.filter((c) => mine.has(c.tenantId))).toEqual([]);
    }, 60_000);

    it('a suspended tenant reads but cannot write', async () => {
      const read = await api().get('/api/v1/parties?partyType=&isActive=').set(auth(t.trial.token));
      expect(read.status).toBe(200);
      const write = await api()
        .post('/api/v1/parties')
        .set(auth(t.trial.token))
        .send({ code: 'X', nameAr: 'X', partyType: 'CUSTOMER' });
      expect(write.status).toBe(403);
      expect(write.body.error.code).toBe('TENANT_READ_ONLY');
    });
  });
});
