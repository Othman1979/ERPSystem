/**
 * Phase 5 acceptance items not covered by phase5.e2e / golden.e2e
 * (BUILD_PLAN §17, Phase 5):
 *  - posting a sales invoice creates exactly one journal entry and its stock
 *    movements once — a repeated post (same or new Idempotency-Key) adds nothing;
 *  - totals sent by the client are not accepted; the server computes them;
 *  - service items produce no stock movements.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3194;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const key = () => `p5-${RUN}-${Math.random().toString(36).slice(2)}`;
const m3 = (v: string) => new Decimal(v).toFixed(3);

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
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
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
    database: 'erp_test',
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Phase 5 acceptance — single posting, server totals, service items', () => {
  let token = '';
  let tenantId: bigint;
  let warehouseId = '';
  let stockItemId = '';
  let serviceItemId = '';
  let customerId = '';

  async function countFor(table: 'journal_entries' | 'stock_movements', sourceType: string, sourceId: string) {
    const rows = (await db.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND source_type = ? AND source_id = ?`,
      [tenantId, sourceType, sourceId],
    )) as { n: bigint }[];
    return Number(rows[0].n);
  }

  it('setup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P5acc ${RUN}`, ownerName: 'Owner', email: `p5acc-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const [t] = (await db.query('SELECT id FROM tenants WHERE name = ?', [`P5acc ${RUN}`])) as { id: bigint }[];
    tenantId = t.id;

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    stockItemId = (
      await api().post('/api/v1/items').set(auth(token)).send({ code: 'STK', nameAr: 'Stock', baseUnitId: pcs })
    ).body.id;
    serviceItemId = (
      await api()
        .post('/api/v1/items')
        .set(auth(token))
        .send({ code: 'SVC', nameAr: 'Service', baseUnitId: pcs, itemKind: 'SERVICE' })
    ).body.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })
    ).body.id;

    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId: stockItemId, qty: '50', unitCost: '4.000' }],
      });
    expect(adj.status).toBe(201);
    const post = await api()
      .post(`/api/v1/stock-adjustments/${adj.body.id}/post`)
      .set(auth(token))
      .set('Idempotency-Key', key());
    expect(post.status).toBe(201);
  });

  it('a sales invoice posts one journal entry and its stock movements exactly once', async () => {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-02-10',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [
          { itemId: stockItemId, qty: '3', unitPrice: '10.000' },
          { itemId: stockItemId, qty: '2', unitPrice: '10.000' },
        ],
      });
    expect(inv.status).toBe(201);
    const id = inv.body.id as string;

    const k = key();
    const first = await api().post(`/api/v1/sales-invoices/${id}/post`).set(auth(token)).set('Idempotency-Key', k);
    expect(first.status).toBe(201);

    // Same key: the stored response is replayed, nothing is posted again.
    const replay = await api().post(`/api/v1/sales-invoices/${id}/post`).set(auth(token)).set('Idempotency-Key', k);
    expect(replay.status).toBe(201);
    expect(replay.body.journalEntryId).toBe(first.body.journalEntryId);

    // New key: the invoice is no longer a draft.
    const again = await api().post(`/api/v1/sales-invoices/${id}/post`).set(auth(token)).set('Idempotency-Key', key());
    expect(again.status).toBeGreaterThanOrEqual(400);

    expect(await countFor('journal_entries', 'SALES_INVOICE', id)).toBe(1);
    expect(await countFor('stock_movements', 'SALES_INVOICE', id)).toBe(2); // one per stock line
  });

  it('client-sent totals are rejected; the server computes them from the lines', async () => {
    const injected = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-02-11',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        grandTotal: '1.000',
        netTotal: '1.000',
        lines: [{ itemId: stockItemId, qty: '1', unitPrice: '10.000' }],
      });
    expect(injected.status).toBe(400);
    expect(injected.body.error.code).toBe('VALIDATION');

    const lineInjected = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-02-11',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: stockItemId, qty: '1', unitPrice: '10.000', lineTotal: '1.000', taxAmount: '0' }],
      });
    expect(lineInjected.status).toBe(400);

    const clean = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-02-11',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: stockItemId, qty: '1', unitPrice: '10.000' }],
      });
    expect(clean.status).toBe(201);
    expect(m3(clean.body.netTotal)).toBe('10.000');
    expect(m3(clean.body.taxTotal)).toBe('1.600');
    expect(m3(clean.body.grandTotal)).toBe('11.600');
  });

  it('service items produce no stock movements and no COGS', async () => {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-02-12',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: serviceItemId, qty: '2', unitPrice: '15.000' }],
      });
    expect(inv.status).toBe(201);
    const posted = await api()
      .post(`/api/v1/sales-invoices/${inv.body.id}/post`)
      .set(auth(token))
      .set('Idempotency-Key', key());
    expect(posted.status).toBe(201);
    expect(m3(posted.body.costTotal)).toBe('0.000');
    expect(await countFor('stock_movements', 'SALES_INVOICE', inv.body.id)).toBe(0);

    const entry = await api().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`).set(auth(token));
    const codes = (entry.body.lines as { account: { code: string } }[]).map((l) => l.account.code);
    expect(codes).not.toContain('5101'); // COGS
    expect(codes).not.toContain('1104'); // inventory
  });
});
