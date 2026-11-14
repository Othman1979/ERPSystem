/**
 * Phase 2 integration tests — chart of accounts, mappings, fiscal years,
 * settings lookups. Real MariaDB (erp_test); spawns the BUILT API on :3198.
 * Run `pnpm build` before `pnpm test` (CI builds first).
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3198;
const BASE = `http://127.0.0.1:${API_PORT}`;
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
    cwd: path.resolve(import.meta.dirname, '..', '..'),
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

describe('Phase 2 — financial setup (erp_test)', () => {
  let tokenA = '';
  let tokenB = '';
  let viewerToken = '';
  let salesAccountId = '';
  let parentAccountId = '';
  let yearId = '';

  it('provisions chart + mappings + defaults on registration', async () => {
    const regA = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Fin A ${RUN}`,
        ownerName: 'Owner A',
        email: `fin-a-${RUN}@test.dev`,
        password: PASS,
      });
    expect(regA.status).toBe(201);
    tokenA = regA.body.accessToken;

    const accounts = await api().get('/api/v1/accounts').set(auth(tokenA));
    expect(accounts.status).toBe(200);
    expect(accounts.body.length).toBeGreaterThanOrEqual(24);
    const codes = accounts.body.map((a: { code: string }) => a.code);
    for (const c of ['1', '11', '1101', '4101', '5101', '5205']) {
      expect(codes).toContain(c);
    }
    // parents are not postable
    const root = accounts.body.find((a: { code: string }) => a.code === '1');
    expect(root.isPostable).toBe(false);

    const mappings = await api().get('/api/v1/account-mappings').set(auth(tokenA));
    expect(mappings.status).toBe(200);
    expect(mappings.body).toHaveLength(15);
    for (const m of mappings.body) {
      expect(m.accountId).not.toBeNull();
    }
    const sales = mappings.body.find(
      (m: { mappingKey: string }) => m.mappingKey === 'SALES',
    );
    salesAccountId = sales.accountId;

    const units = await api().get('/api/v1/units').set(auth(tokenA));
    expect(units.body.length).toBeGreaterThanOrEqual(7);
    const taxes = await api().get('/api/v1/tax-categories').set(auth(tokenA));
    expect(taxes.body.length).toBeGreaterThanOrEqual(2);
    const payments = await api().get('/api/v1/payment-methods').set(auth(tokenA));
    expect(payments.body.length).toBeGreaterThanOrEqual(4);
  });

  it('provision endpoint is idempotent', async () => {
    const before = await api().get('/api/v1/accounts').set(auth(tokenA));
    const res = await api()
      .post('/api/v1/accounting/setup/provision')
      .set(auth(tokenA));
    expect(res.status).toBe(201);
    const after = await api().get('/api/v1/accounts').set(auth(tokenA));
    expect(after.body.length).toBe(before.body.length);
  });

  it('rejects duplicate account code within a company', async () => {
    const res = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({
        code: '4101',
        nameAr: 'مبيعات مكررة',
        accountType: 'REVENUE',
      });
    expect(res.status).toBe(409);
  });

  it('forces parent non-postable when it gains a child', async () => {
    // create a new leaf group then a child under it
    const group = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({
        code: '61',
        nameAr: 'مصروفات جديدة',
        accountType: 'EXPENSE',
        isPostable: false,
      });
    expect(group.status).toBe(201);
    parentAccountId = group.body.id;

    const leaf = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({
        code: '6101',
        nameAr: 'مصروف فرعي',
        accountType: 'EXPENSE',
        parentId: parentAccountId,
      });
    expect(leaf.status).toBe(201);

    // try to make the parent postable → rejected (has children)
    const bad = await api()
      .patch(`/api/v1/accounts/${parentAccountId}`)
      .set(auth(tokenA))
      .send({ isPostable: true });
    expect(bad.status).toBe(409);
  });

  it('auto-generates child codes as parent-NN', async () => {
    // root account without a code is rejected
    const noCode = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({ nameAr: 'بدون رمز', accountType: 'EXPENSE' });
    expect(noCode.status).toBe(400);

    // children of group '61' get sequential dash codes
    const c1 = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({ nameAr: 'حساب فرعي أول', accountType: 'EXPENSE', parentId: parentAccountId });
    expect(c1.status).toBe(201);
    expect(c1.body.code).toBe('61-01');

    const c2 = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({ nameAr: 'حساب فرعي ثان', accountType: 'EXPENSE', parentId: parentAccountId });
    expect(c2.body.code).toBe('61-02');

    // nested: child of 61-01 continues the pattern
    const c3 = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({ nameAr: 'حساب فرعي ثالث', accountType: 'EXPENSE', parentId: c1.body.id });
    expect(c3.body.code).toBe('61-01-01');
    expect(c3.body.level).toBe(4);
  });

  it('blocks deactivating an account used in a mapping', async () => {
    const res = await api()
      .patch(`/api/v1/accounts/${salesAccountId}`)
      .set(auth(tokenA))
      .send({ isActive: false });
    expect(res.status).toBe(409);
  });

  it('creates a fiscal year with 12 monthly periods + sequences', async () => {
    const res = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(tokenA))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(res.status).toBe(201);
    yearId = res.body.id;
    expect(res.body.periods).toHaveLength(12);
    expect(res.body.periods[0].periodNo).toBe(1);
    expect(res.body.periods[11].periodNo).toBe(12);

    const seqs = await api()
      .get(`/api/v1/document-sequences?fiscalYearId=${yearId}`)
      .set(auth(tokenA));
    expect(seqs.status).toBe(200);
    expect(seqs.body.length).toBeGreaterThanOrEqual(10);
    expect(seqs.body[0].prefix).toContain('2025');

    // overlapping year rejected
    const overlap = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(tokenA))
      .send({ code: '2025B', startDate: '2025-06-01', endDate: '2026-05-31' });
    expect(overlap.status).toBe(409);
  });

  it('gates period close/open by permission and audits it', async () => {
    // invite a VIEWER (no fiscal.close)
    const viewer = await addMember(BASE, tokenA, {
      email: `viewer-fin-${RUN}@test.dev`,
      roleCode: 'VIEWER',
      password: 'viewer-pass-1',
    });
    viewerToken = viewer.token;

    const year = await api().get(`/api/v1/fiscal-years/${yearId}`).set(auth(tokenA));
    const periodId = year.body.periods[0].id;

    const denied = await api()
      .post(`/api/v1/fiscal-periods/${periodId}/close`)
      .set(auth(viewerToken));
    expect(denied.status).toBe(403);

    const closed = await api()
      .post(`/api/v1/fiscal-periods/${periodId}/close`)
      .set(auth(tokenA));
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('CLOSED');
    expect(closed.body.closedAt).not.toBeNull();

    const auditRows = await db.query(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'fiscal_period.close' AND entity_id = ?",
      [periodId],
    );
    expect(Number((auditRows[0] as { n: number }).n)).toBeGreaterThanOrEqual(1);

    const reopened = await api()
      .post(`/api/v1/fiscal-periods/${periodId}/open`)
      .set(auth(tokenA));
    expect(reopened.status).toBe(201);
    expect(reopened.body.status).toBe('OPEN');
  });

  it('enforces tenant isolation on accounts and fiscal years', async () => {
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Fin B ${RUN}`,
        ownerName: 'Owner B',
        email: `fin-b-${RUN}@test.dev`,
        password: PASS,
      });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    // custom account created in A must not appear in B
    const custom = await api()
      .post('/api/v1/accounts')
      .set(auth(tokenA))
      .send({
        code: '9901',
        nameAr: 'حساب خاص أ',
        accountType: 'ASSET',
      });
    expect(custom.status).toBe(201);

    const accountsB = await api().get('/api/v1/accounts').set(auth(tokenB));
    expect(accountsB.body.find((a: { code: string }) => a.code === '9901')).toBeUndefined();

    // fiscal years are tenant-scoped too
    const yearsB = await api().get('/api/v1/fiscal-years').set(auth(tokenB));
    expect(yearsB.body).toHaveLength(0);
  });
});
