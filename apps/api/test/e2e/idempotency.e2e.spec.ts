/**
 * Idempotency-Key on posting routes (CLAUDE.md «الترحيل», BUILD_PLAN §10.3;
 * review 2026-11-13 PLAT-02 and TRADE-16):
 *  - the key is required on every spelling Express routes to a posting
 *    handler: a trailing slash or another letter case posts nothing without it;
 *  - those spellings are the same request: the same key replays;
 *  - two identical requests at the same instant post once; the other gets the
 *    stored response or 409 CONFLICT, never a 500;
 *  - the same key with a different body or another document answers
 *    IDEMPOTENCY_KEY_REUSED;
 *  - tenant B cannot replay tenant A's key.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3521;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const key = () => `idem-${RUN}-${Math.random().toString(36).slice(2)}`;

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
    cwd: path.resolve(import.meta.dirname, '..', '..'),
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

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

interface Tenant {
  token: string;
  tenantId: bigint;
  warehouseId: string;
  itemId: string;
}

async function setupTenant(label: string): Promise<Tenant> {
  const name = `Idem ${label} ${RUN}`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: name, ownerName: 'Owner', email: `idem-${label}-${RUN}@test.dev`, password: PASS });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const [t] = (await db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
  await api()
    .post('/api/v1/fiscal-years')
    .set(auth(token))
    .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
  const warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' }))
    .body.id as string;
  const units = await api().get('/api/v1/units').set(auth(token));
  const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
  const itemId = (
    await api().post('/api/v1/items').set(auth(token)).send({ code: 'STK', nameAr: 'Stock', baseUnitId: pcs })
  ).body.id as string;
  return { token, tenantId: t.id, warehouseId, itemId };
}

describe('Idempotency-Key — route spellings, concurrency, reuse', () => {
  let a: Tenant;
  let b: Tenant;

  /** A draft opening adjustment of one line. */
  async function draft(t: Tenant): Promise<string> {
    const res = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(t.token))
      .send({
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId: t.warehouseId,
        lines: [{ itemId: t.itemId, qty: '5', unitCost: '2.000' }],
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function movements(t: Tenant, id: string): Promise<number> {
    const rows = (await db.query(
      `SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ? AND source_type = 'STOCK_ADJUSTMENT' AND source_id = ?`,
      [t.tenantId, id],
    )) as { n: bigint }[];
    return Number(rows[0].n);
  }

  it('setup', async () => {
    a = await setupTenant('a');
    b = await setupTenant('b');
  });

  it.each([
    ['trailing slash', (id: string) => `/api/v1/stock-adjustments/${id}/post/`],
    ['upper-case action', (id: string) => `/api/v1/stock-adjustments/${id}/POST`],
    ['mixed-case path', (id: string) => `/api/v1/Stock-Adjustments/${id}/Post`],
    ['upper-case reverse', (id: string) => `/api/v1/stock-adjustments/${id}/REVERSE/`],
  ])('%s without a key is refused and posts nothing', async (_label, url) => {
    const id = await draft(a);
    const res = await api().post(url(id)).set(auth(a.token));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(await movements(a, id)).toBe(0);
  });

  it('a trailing slash and the plain path are the same request: the key replays', async () => {
    const id = await draft(a);
    const k = key();
    const first = await api().post(`/api/v1/stock-adjustments/${id}/post/`).set(auth(a.token)).set('Idempotency-Key', k);
    expect(first.status).toBe(201);
    const replay = await api().post(`/api/v1/stock-adjustments/${id}/POST`).set(auth(a.token)).set('Idempotency-Key', k);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(await movements(a, id)).toBe(1);
  });

  it('two identical requests at the same instant post once and never answer 500', async () => {
    for (let round = 0; round < 3; round++) {
      const id = await draft(a);
      const k = key();
      const send = () =>
        api().post(`/api/v1/stock-adjustments/${id}/post`).set(auth(a.token)).set('Idempotency-Key', k);
      const results = await Promise.all([send(), send(), send()]);
      const statuses = results.map((r) => r.status);
      for (const r of results) {
        expect([201, 409]).toContain(r.status);
        if (r.status === 409) expect(r.body.error.code).toBe('CONFLICT');
      }
      const ok = results.filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of ok) expect(r.body).toEqual(ok[0].body);
      expect(await movements(a, id)).toBe(1);
      // Once the first finishes, the key replays the stored response.
      const after = await send();
      expect({ round, statuses, status: after.status }).toEqual({ round, statuses, status: 201 });
      expect(after.body).toEqual(ok[0].body);
    }
  });

  // The two tests below place the competing row in the database first, so the
  // request's reservation always collides (the unique-key path of TRADE-16),
  // whatever the timing of the Promise.all test above.
  it('a key another request is still holding answers 409 CONFLICT, not 500', async () => {
    const id = await draft(a);
    const k = key();
    const send = () => api().post(`/api/v1/stock-adjustments/${id}/post`).set(auth(a.token)).set('Idempotency-Key', k);
    expect((await send()).status).toBe(201);
    // Make the stored row look like a request still in flight.
    await db.query(`UPDATE idempotency_keys SET status = 'IN_PROGRESS', response_json = NULL WHERE tenant_id = ? AND \`key\` = ?`, [
      a.tenantId,
      k,
    ]);
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await movements(a, id)).toBe(1);
  });

  it('a key reserved for another request answers IDEMPOTENCY_KEY_REUSED, not 500', async () => {
    const id = await draft(a);
    const k = key();
    await db.query(
      `INSERT INTO idempotency_keys (tenant_id, \`key\`, endpoint, request_hash, status, expires_at)
       VALUES (?, ?, 'elsewhere', ?, 'IN_PROGRESS', NOW() + INTERVAL 1 DAY)`,
      [a.tenantId, k, '0'.repeat(64)],
    );
    const res = await api().post(`/api/v1/stock-adjustments/${id}/post`).set(auth(a.token)).set('Idempotency-Key', k);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await movements(a, id)).toBe(0);
  });

  it('the same key with a different body answers IDEMPOTENCY_KEY_REUSED', async () => {
    const id = await draft(a);
    const k = key();
    const first = await api()
      .post(`/api/v1/stock-adjustments/${id}/post`)
      .set(auth(a.token))
      .set('Idempotency-Key', k)
      .send({ attempt: 1 });
    expect(first.status).toBe(201);
    const other = await api()
      .post(`/api/v1/stock-adjustments/${id}/post`)
      .set(auth(a.token))
      .set('Idempotency-Key', k)
      .send({ attempt: 2 });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('the same key on another document answers IDEMPOTENCY_KEY_REUSED and posts nothing', async () => {
    const first = await draft(a);
    const second = await draft(a);
    const k = key();
    expect(
      (await api().post(`/api/v1/stock-adjustments/${first}/post`).set(auth(a.token)).set('Idempotency-Key', k)).status,
    ).toBe(201);
    const res = await api().post(`/api/v1/stock-adjustments/${second}/post`).set(auth(a.token)).set('Idempotency-Key', k);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await movements(a, second)).toBe(0);
  });

  it("tenant B's request with tenant A's key does not replay A's response", async () => {
    const idA = await draft(a);
    const k = key();
    const first = await api().post(`/api/v1/stock-adjustments/${idA}/post`).set(auth(a.token)).set('Idempotency-Key', k);
    expect(first.status).toBe(201);
    // Same URL and key from tenant B: A's document is not B's, and A's stored response is not returned.
    const res = await api().post(`/api/v1/stock-adjustments/${idA}/post`).set(auth(b.token)).set('Idempotency-Key', k);
    expect(res.status).toBe(404);
    expect(res.body).not.toEqual(first.body);
    const idB = await draft(b);
    const own = await api().post(`/api/v1/stock-adjustments/${idB}/post`).set(auth(b.token)).set('Idempotency-Key', k);
    expect(own.status).toBe(201);
    expect(await movements(b, idB)).toBe(1);
  });
});
