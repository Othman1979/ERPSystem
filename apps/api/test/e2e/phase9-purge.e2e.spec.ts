/**
 * Phase 9 — deleting a cancelled tenant after retention (ADR-009 §14):
 *  - `purge-tenant` refuses a tenant that is not CANCELLED, one still inside
 *    RETENTION_DAYS, and a wrong --confirm name;
 *  - without --confirm it only reports (nothing changes);
 *  - with it, no row of the tenant is left in any tenant table, its files
 *    are gone, users of that tenant only are deleted (a user who is also in
 *    another tenant stays, and so does one with history in another company,
 *    such as a declined invitation), and a platform audit row records it;
 *  - the other tenant is untouched (rows, trial balance, sign-in).
 * Real MariaDB (erp_test) + built API and job. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

import { addMember } from './support/members.js';

const API_PORT = 3211;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const STORAGE = mkdtempSync(path.join(os.tmpdir(), 'erp-purge-'));
const DAY = 24 * 60 * 60 * 1000;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `pg-${RUN}-${Math.random().toString(36).slice(2)}` });
/** Each command run boots Nest and counts every tenant table: a few seconds. */
const slow = (name: string, fn: () => Promise<void>) => it(name, fn, 60_000);

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

/** Runs the purge command; returns its exit code, JSON output and error text. */
async function purge(...args: string[]) {
  try {
    const { stdout } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'purge-tenant', ...args], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test', STORAGE_DIR: STORAGE },
    });
    return { code: 0, json: JSON.parse(stdout) as Record<string, unknown>, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: e.code ?? 1, json: null, stderr: e.stderr ?? '' };
  }
}

/** Rows of a tenant in every table that has a tenant_id. */
async function rowsOf(tenantId: string): Promise<Record<string, number>> {
  const tables = (await db.query(
    "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'tenant_id' AND TABLE_NAME <> 'tenants'",
  )) as { t: string }[];
  const out: Record<string, number> = {};
  for (const { t } of tables) {
    const [r] = (await db.query(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE tenant_id = ?`, [tenantId])) as { n: bigint }[];
    if (Number(r.n) > 0) out[t] = Number(r.n);
  }
  return out;
}

beforeAll(async () => {
  databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', STORAGE_DIR: STORAGE },
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
  rmSync(STORAGE, { recursive: true, force: true });
});

describe('purge-tenant', () => {
  const nameA = `PG A ${RUN}`;
  let tokenA = '';
  let tokenB = '';
  let tenantA = '';
  let tenantB = '';
  let rowsB: Record<string, number> = {};
  let tbB = '';

  async function seed(token: string, tag: string) {
    await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    await api().post('/api/v1/parties').set(auth(token)).send({ code: `P-${tag}`, nameAr: tag, partyType: 'CUSTOMER' });
    const accounts = (await api().get('/api/v1/accounts').set(auth(token))).body as { id: string; code: string }[];
    const acc = (c: string) => accounts.find((a) => a.code === c)!.id;
    const je = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({ entryDate: '2025-02-01', lines: [{ accountId: acc('5204'), debit: '25.500' }, { accountId: acc('1101'), credit: '25.500' }] });
    await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem());
    return je.body.id as string;
  }

  slow('setup: tenant A with data, a reversal, stock, a logo, a solo and a shared user; tenant B', async () => {
    const a = await api().post('/api/v1/auth/register').send({ tenantName: nameA, ownerName: 'Owner A', email: `pg-a-${RUN}@test.dev`, password: PASS });
    expect([a.status, a.body.error?.message]).toEqual([201, undefined]);
    tokenA = a.body.accessToken;
    tenantA = String((await api().get('/api/v1/me').set(auth(tokenA))).body.currentTenant.tenantId);
    const b = await api().post('/api/v1/auth/register').send({ tenantName: `PG B ${RUN}`, ownerName: 'Owner B', email: `pg-b-${RUN}@test.dev`, password: PASS });
    tokenB = b.body.accessToken;
    tenantB = String((await api().get('/api/v1/me').set(auth(tokenB))).body.currentTenant.tenantId);

    const entry = await seed(tokenA, 'A');
    // A reversal points at its original (a self reference inside the tenant).
    expect((await api().post(`/api/v1/journal-entries/${entry}/reverse`).set(auth(tokenA)).set(idem()).send({ reversalDate: '2025-02-02' })).status).toBe(201);
    const wh = (await api().post('/api/v1/warehouses').set(auth(tokenA)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(tokenA));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const item = (await api().post('/api/v1/items').set(auth(tokenA)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs, itemKind: 'STOCK' })).body.id;
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(tokenA))
      .send({ adjustmentDate: '2025-01-05', adjustmentType: 'OPENING', warehouseId: wh, lines: [{ itemId: item, qty: '3', unitCost: '2.000' }] });
    expect((await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(tokenA)).set(idem())).status).toBe(201);
    expect((await api().post('/api/v1/company/logo').set(auth(tokenA)).attach('file', PNG, { filename: 'a.png', contentType: 'image/png' })).status).toBe(201);
    for (const [token, email] of [
      [tokenA, `pg-solo-${RUN}@test.dev`],
      [tokenA, `pg-shared-${RUN}@test.dev`],
      [tokenB, `pg-shared-${RUN}@test.dev`],
    ]) {
      await addMember(BASE, token, { email, roleCode: 'ACCOUNTANT', password: PASS });
    }
    await seed(tokenB, 'B');
    // The declined-invitation case: invited to B, the invitation declined (B's membership goes, the audit row
    // stays in B), and a member of A only. A is at its plan's user limit, so its membership is written here
    // directly; roles are global, so the ACCOUNTANT role is the same row for both companies.
    const declEmail = `pg-decl-${RUN}@test.dev`;
    await addMember(BASE, tokenB, { email: declEmail, roleCode: 'ACCOUNTANT', password: PASS });
    const [decl] = (await db.query('SELECT id FROM users WHERE email = ?', [declEmail])) as { id: bigint }[];
    const [accountant] = (await db.query("SELECT id FROM roles WHERE code = 'ACCOUNTANT'")) as { id: bigint }[];
    await db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role_id, status) VALUES (?, ?, ?, 'ACTIVE')", [
      tenantA,
      String(decl.id),
      String(accountant.id),
    ]);
    await db.query('DELETE FROM tenant_memberships WHERE tenant_id = ? AND user_id = ?', [tenantB, String(decl.id)]);
    await db.query("INSERT INTO audit_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES (?, ?, 'user.invite_decline', 'membership', ?)", [
      tenantB,
      String(decl.id),
      String(decl.id),
    ]);

    expect(Object.keys(await rowsOf(tenantA)).length).toBeGreaterThan(10);
    expect(existsSync(path.join(STORAGE, `t${tenantA}`))).toBe(true);
    rowsB = await rowsOf(tenantB);
    tbB = JSON.stringify((await api().get('/api/v1/reports/trial-balance').set(auth(tokenB))).body.totals);
  });

  slow('refuses a tenant that is not cancelled, or still inside the retention period', async () => {
    const before = await rowsOf(tenantA);
    const trial = await purge(tenantA, '--confirm', nameA);
    expect(trial.code).toBe(1);
    expect(trial.stderr).toContain('status is TRIAL');

    await db.query("UPDATE tenants SET status = 'CANCELLED', status_changed_at = ? WHERE id = ?", [new Date(Date.now() - 10 * DAY), tenantA]);
    const early = await purge(tenantA, '--confirm', nameA);
    expect(early.code).toBe(1);
    expect(early.stderr).toContain('retention of 90 days');
    expect(await rowsOf(tenantA)).toEqual(before);
  });

  slow('without --confirm it only reports; a wrong name is refused', async () => {
    await db.query('UPDATE tenants SET status_changed_at = ? WHERE id = ?', [new Date(Date.now() - 100 * DAY), tenantA]);
    const before = await rowsOf(tenantA);
    const dry = await purge(tenantA);
    expect(dry.code).toBe(0);
    expect(dry.json).toMatchObject({ dryRun: true, eligible: true, name: nameA });
    expect((dry.json!.rows as Record<string, number>).journal_lines).toBe(before.journal_lines);
    // The shared user belongs to B as well: kept.
    expect((dry.json!.users as string[]).sort()).toEqual([`pg-a-${RUN}@test.dev`, `pg-solo-${RUN}@test.dev`].sort());
    expect(await rowsOf(tenantA)).toEqual(before);

    const wrong = await purge(tenantA, '--confirm', 'PG A');
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('exact tenant name');
    expect(await rowsOf(tenantA)).toEqual(before);
  });

  slow('deletes every row, file and sole user of the tenant, and records it', async () => {
    // The sole users' ids and addresses, read before they are deleted.
    const soleEmails = [`pg-a-${RUN}@test.dev`, `pg-solo-${RUN}@test.dev`];
    const soleIds = ((await db.query('SELECT id FROM users WHERE email IN (?, ?)', soleEmails)) as { id: bigint }[]).map((u) =>
      String(u.id),
    );
    expect(soleIds).toHaveLength(2);

    const done = await purge(tenantA, '--confirm', nameA);
    expect(done.code).toBe(0);
    expect(done.json).toMatchObject({ purged: true, tenantId: tenantA });

    // No audit row keeps a purged user's id or address (the platform's own rows included).
    const [kept] = (await db.query(
      `SELECT COUNT(*) AS n FROM audit_logs
        WHERE user_id IN (?) OR entity_id IN (?)
           OR CAST(after_json AS CHAR) LIKE ? OR CAST(after_json AS CHAR) LIKE ?
           OR CAST(before_json AS CHAR) LIKE ? OR CAST(before_json AS CHAR) LIKE ?`,
      [
        soleIds,
        soleIds,
        `%${soleEmails[0]}%`,
        `%${soleEmails[1]}%`,
        `%${soleEmails[0]}%`,
        `%${soleEmails[1]}%`,
      ],
    )) as { n: bigint }[];
    expect(Number(kept.n)).toBe(0);

    expect(await rowsOf(tenantA)).toEqual({});
    expect(await db.query('SELECT id FROM tenants WHERE id = ?', [tenantA])).toHaveLength(0);
    expect(existsSync(path.join(STORAGE, `t${tenantA}`))).toBe(false);

    const users = (await db.query('SELECT email FROM users WHERE email IN (?, ?, ?)', [
      `pg-a-${RUN}@test.dev`,
      `pg-solo-${RUN}@test.dev`,
      `pg-shared-${RUN}@test.dev`,
    ])) as { email: string }[];
    expect(users.map((u) => u.email)).toEqual([`pg-shared-${RUN}@test.dev`]);
    const tokens = (await db.query(
      'SELECT COUNT(*) AS n FROM refresh_tokens r JOIN users u ON u.id = r.user_id WHERE u.email = ?',
      [`pg-a-${RUN}@test.dev`],
    )) as { n: bigint }[];
    expect(Number(tokens[0].n)).toBe(0);

    const audit = (await db.query(
      "SELECT tenant_id FROM audit_logs WHERE action = 'job.tenant_purge' AND entity_id = ?",
      [tenantA],
    )) as { tenant_id: bigint | null }[];
    expect(audit).toHaveLength(1);
    expect(audit[0].tenant_id).toBeNull();
    const [checks] = (await db.query('SELECT @@FOREIGN_KEY_CHECKS AS on_')) as { on_: number }[];
    expect(Number(checks.on_)).toBe(1);
  });

  slow('keeps a member whose history reaches another company, and that history stays whole', async () => {
    const [decl] = (await db.query('SELECT id FROM users WHERE email = ?', [`pg-decl-${RUN}@test.dev`])) as { id: bigint }[];
    expect(decl).toBeDefined();
    // The membership in A went with the tenant; the user and the record in B did not.
    const [memberships] = (await db.query('SELECT COUNT(*) AS n FROM tenant_memberships WHERE user_id = ?', [String(decl.id)])) as { n: bigint }[];
    expect(Number(memberships.n)).toBe(0);
    const [declines] = (await db.query(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.invite_decline' AND user_id = ? AND tenant_id = ?",
      [String(decl.id), tenantB],
    )) as { n: bigint }[];
    expect(Number(declines.n)).toBe(1);
  });

  slow('leaves the other tenant exactly as it was', async () => {
    expect(await rowsOf(tenantB)).toEqual(rowsB);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(tokenB));
    expect(tb.status).toBe(200);
    expect(JSON.stringify(tb.body.totals)).toBe(tbB);
    expect(tb.body.balanced).toBe(true);
    const shared = await api().post('/api/v1/auth/login').send({ email: `pg-shared-${RUN}@test.dev`, password: PASS });
    expect(shared.status).toBe(200);
    // A's token is dead: its user and tenant are gone.
    expect((await api().get('/api/v1/company').set(auth(tokenA))).status).toBe(401);
  });
});
