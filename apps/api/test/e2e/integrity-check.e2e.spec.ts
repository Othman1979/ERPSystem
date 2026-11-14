/**
 * Integrity check job (`job:integrity-check`, DB-15 / DB-18):
 *  - a clean tenant passes every check, and the collation check passes;
 *  - an orphan party reference in one tenant fails that tenant's run (exit 1);
 *  - another tenant's run is not affected by it (--tenant isolation);
 *  - a malformed --tenant is a usage error.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 * Other suites share erp_test, so every run is scoped with --tenant.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3661;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');

const CHECKS = [
  'journal_lines.party_id',
  'journal_lines.party_type',
  'journal_lines.branch_id',
  'journal_lines.entry_date',
  'allocations.document',
  'einvoice_submissions.document',
  'journal_entries.source',
  'stock_movements.source',
  'stock_movements.source_line',
  'collation',
];

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

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

/** Runs the CLI job; a non-zero exit is returned, not thrown. */
async function cli(args: string[]) {
  try {
    const { stdout, stderr } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'integrity-check', ...args], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

type Report = { job: string; ok: boolean; tenantId: string | null; checks: { name: string; ok: boolean; count: number }[] };

const report = (stdout: string) => JSON.parse(stdout) as Report;
const check = (r: Report, name: string) => r.checks.find((c) => c.name === name);

/** Registers a tenant and returns its token and id. */
async function register(tag: string) {
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: `IC ${tag} ${RUN}`, ownerName: 'Owner', email: `ic-${tag}-${RUN}@test.dev`, password: PASS });
  expect(res.status).toBe(201);
  const me = await api().get('/api/v1/me').set(auth(res.body.accessToken));
  return { token: res.body.accessToken as string, tenantId: String(me.body.currentTenant.tenantId) };
}

beforeAll(async () => {
  databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
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
    database: 'erp_test',
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  // A server that already exited (failed to start) emits no further 'exit'.
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await db?.end();
});

describe('Integrity check job — references and collation (erp_test)', () => {
  let tenantA = { token: '', tenantId: '' };
  let tenantB = { token: '', tenantId: '' };

  it('a clean tenant passes every check', async () => {
    tenantA = await register('a');
    const accounts = await api().get('/api/v1/accounts').set(auth(tenantA.token));
    expect(accounts.status).toBe(200);
    const cash = accounts.body.find((a: { code: string; isPostable: boolean }) => a.code === '1101' && a.isPostable);
    const sales = accounts.body.find((a: { code: string; isPostable: boolean }) => a.code === '4101' && a.isPostable);
    expect(cash).toBeDefined();
    expect(sales).toBeDefined();

    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(tenantA.token))
      .send({
        entryDate: new Date().toISOString().slice(0, 10),
        description: 'integrity fixture',
        lines: [
          { accountId: cash.id, debit: '10.000' },
          { accountId: sales.id, credit: '10.000' },
        ],
      });
    expect(draft.status).toBe(201);

    const run = await cli(['--tenant', tenantA.tenantId]);
    expect(run.code).toBe(0);
    const r = report(run.stdout);
    expect(r.ok).toBe(true);
    expect(r.tenantId).toBe(tenantA.tenantId);
    expect(r.checks.map((c) => c.name)).toEqual(CHECKS);
    for (const c of r.checks) expect(c).toMatchObject({ ok: true, count: 0 });
    expect(check(r, 'collation')).toMatchObject({ ok: true, count: 0 });
  }, 60_000);

  it('an orphan party reference fails the tenant that has it', async () => {
    // One line of tenant A now points at a party that does not exist.
    const upd = await db.query(
      `UPDATE journal_lines SET party_type = 'CUSTOMER', party_id = 999999999 WHERE tenant_id = ? LIMIT 1`,
      [tenantA.tenantId],
    );
    expect(upd.affectedRows).toBe(1);

    const run = await cli(['--tenant', tenantA.tenantId]);
    expect(run.code).toBe(1);
    const r = report(run.stdout);
    expect(r.ok).toBe(false);
    expect(check(r, 'journal_lines.party_id')).toMatchObject({ ok: false, count: 1 });
    // The other checks still ran and still pass.
    expect(check(r, 'journal_lines.party_type')).toMatchObject({ ok: true, count: 0 });
    expect(check(r, 'collation')).toMatchObject({ ok: true });

    // Leave erp_test clean for a whole-database run.
    await db.query(`UPDATE journal_lines SET party_type = NULL, party_id = NULL WHERE tenant_id = ? AND party_id = 999999999`, [
      tenantA.tenantId,
    ]);
    expect((await cli(['--tenant', tenantA.tenantId])).code).toBe(0);
  }, 60_000);

  it("a journal line whose entry_date drifted from its entry's fails the check (LEDGER-19)", async () => {
    const upd = await db.query(
      'UPDATE journal_lines SET entry_date = DATE_ADD(entry_date, INTERVAL 1 DAY) WHERE tenant_id = ? LIMIT 1',
      [tenantA.tenantId],
    );
    expect(upd.affectedRows).toBe(1);
    try {
      const run = await cli(['--tenant', tenantA.tenantId]);
      expect(run.code).toBe(1);
      expect(check(report(run.stdout), 'journal_lines.entry_date')).toMatchObject({ ok: false, count: 1 });
    } finally {
      // Back to the entry's date, so erp_test stays clean.
      await db.query(
        `UPDATE journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
            SET l.entry_date = e.entry_date WHERE l.tenant_id = ? AND l.entry_date <> e.entry_date`,
        [tenantA.tenantId],
      );
    }
    expect((await cli(['--tenant', tenantA.tenantId])).code).toBe(0);
  }, 60_000);

  it('another tenant is not affected by that orphan', async () => {
    tenantB = await register('b');
    const run = await cli(['--tenant', tenantB.tenantId]);
    expect(run.code).toBe(0);
    const r = report(run.stdout);
    expect(r.ok).toBe(true);
    expect(r.tenantId).toBe(tenantB.tenantId);
    expect(check(r, 'journal_lines.party_id')).toMatchObject({ ok: true, count: 0 });
  }, 60_000);

  it('a REVALUATION movement (ADR-018) is sound beside its movement, an orphan alone', async () => {
    const c = await register('c');
    const year = new Date().getUTCFullYear();
    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(c.token))
      .send({ code: `FY${year}`, startDate: `${year}-01-01`, endDate: `${year}-12-31` });
    expect(fy.status).toBe(201);
    const units = await api().get('/api/v1/units').set(auth(c.token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const wh = await api().post('/api/v1/warehouses').set(auth(c.token)).send({ code: 'WH1', nameAr: 'المستودع' });
    expect(wh.status).toBe(201);
    const item = await api().post('/api/v1/items').set(auth(c.token)).send({ code: 'ITM-1', nameAr: 'صنف', baseUnitId: pcs });
    expect(item.status).toBe(201);
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(c.token))
      .send({
        adjustmentDate: new Date().toISOString().slice(0, 10),
        adjustmentType: 'OPENING',
        warehouseId: wh.body.id,
        lines: [{ itemId: item.body.id, qty: '10', unitCost: '5.000' }],
      });
    expect(adj.status).toBe(201);
    const posted = await api()
      .post(`/api/v1/stock-adjustments/${adj.body.id}/post`)
      .set(auth(c.token))
      .set({ 'Idempotency-Key': `ic-${RUN}-adj` });
    expect([posted.status, JSON.stringify(posted.body)]).toEqual([201, expect.stringContaining('POSTED')]);

    // As the stock ledger writes it: zero quantity, the source ids of the movement it comes with.
    const revaluation = (sourceId: string, lineId: string) =>
      db.query(
        `INSERT INTO stock_movements (tenant_id, company_id, warehouse_id, item_id, movement_date, movement_type,
           source_type, source_id, source_line_id, qty_in, qty_out, unit_cost, total_cost, balance_qty_after, avg_cost_after)
         SELECT tenant_id, company_id, warehouse_id, item_id, movement_date, 'OUT',
           'REVALUATION', ${sourceId}, ${lineId}, 0, 0, 0, 1.000, balance_qty_after, avg_cost_after
         FROM stock_movements WHERE tenant_id = ? AND source_type = 'STOCK_ADJUSTMENT'`,
        [c.tenantId],
      );
    await revaluation('source_id', 'source_line_id');
    const sound = report((await cli(['--tenant', c.tenantId])).stdout);
    expect(check(sound, 'stock_movements.source')).toMatchObject({ ok: true, count: 0 });
    expect(check(sound, 'stock_movements.source_line')).toMatchObject({ ok: true, count: 0 });
    expect(sound.ok).toBe(true);

    // Without a movement to come with, it points at nothing.
    await revaluation('999999999', 'NULL');
    const run = await cli(['--tenant', c.tenantId]);
    expect(run.code).toBe(1);
    expect(check(report(run.stdout), 'stock_movements.source')).toMatchObject({ ok: false, count: 1 });

    await db.query(`DELETE FROM stock_movements WHERE tenant_id = ? AND source_type = 'REVALUATION'`, [c.tenantId]);
  }, 60_000);

  it('a malformed --tenant is a usage error, an unknown one is refused', async () => {
    const run = await cli(['--tenant', 'abc']);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('Usage');
    // A mistyped id must not report a clean tenant.
    const unknown = await cli(['--tenant', '999999999999']);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('Unknown tenant 999999999999');
  }, 60_000);
});
