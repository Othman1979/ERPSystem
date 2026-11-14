/**
 * Posting concurrency (BUILD_PLAN §10.1 step 12, §10.4; review findings
 * DB-02/TRADE-05 and DB-03/TRADE-08):
 *  - lock order: two 120-line sales invoices over the same items, one in
 *    ascending and one in descending line order, posted at the same time.
 *    Locking line by line deadlocked; StockLedgerService.lockForDocument
 *    locks all (item, warehouse) pairs in one sorted order first;
 *  - first movement: two purchase invoices on a brand-new item, posted at
 *    the same time. Both used to create the item_costs / stock_balances rows
 *    and the second failed with a unique violation (500).
 *  - pool (3D finding): 12 invoices posted at once with the default pool of 10
 *    connections all succeed; the plan quota read used a second connection
 *    inside the posting transaction and deadlocked the pool (503);
 *  - cost snapshot (TRADE-21): a 120-line invoice writes each line's unit/total cost in one batched UPDATE; each matches its stock movement.
 * After each scenario stock:verify finds no difference and the trial
 * balance is balanced. Tenant B sees none of tenant A's documents.
 *
 * The 120 items are master data cloned with SQL from one item created through
 * the API: creating them one by one would hit the per-user request limit
 * (ADR-011). Every posting goes through the API.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3561;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const LINES = 120;

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const key = () => `pc-${RUN}-${Math.random().toString(36).slice(2)}`;

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
    // DB_POOL_SIZE pinned to its default (10): the pool test below posts more
    // invoices at once than the pool has connections.
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', DB_POOL_SIZE: '10' },
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

async function register(label: string): Promise<{ token: string; tenantId: bigint }> {
  const name = `PC${label} ${RUN}`;
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: name, ownerName: 'Owner', email: `pc${label.toLowerCase()}-${RUN}@test.dev`, password: PASS });
  expect(reg.status).toBe(201);
  const [t] = (await db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
  return { token: reg.body.accessToken as string, tenantId: t.id };
}

describe('Posting concurrency — sorted stock locks, race-safe first movement', () => {
  let token = '';
  let tenantId: bigint;
  let tokenB = '';
  let warehouseId = '';
  let pcs = '';
  let customerId = '';
  let supplierId = '';
  const itemIds: string[] = [];

  async function post(doc: string, id: string) {
    return api().post(`/api/v1/${doc}/${id}/post`).set(auth(token)).set('Idempotency-Key', key());
  }

  /** stock:verify clean and the trial balance balanced (CLAUDE.md «الاختبارات»). */
  async function assertLedgersConsistent() {
    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
  }

  it('setup: tenants A and B, 120 stock items with opening stock', async () => {
    ({ token, tenantId } = await register('A'));
    ({ token: tokenB } = await register('B'));

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    const wh = await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' });
    expect(wh.status).toBe(201);
    warehouseId = wh.body.id as string;
    const units = await api().get('/api/v1/units').set(auth(token));
    pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })
    ).body.id as string;
    supplierId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' })
    ).body.id as string;

    const template = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'I000', nameAr: 'Item 0', baseUnitId: pcs });
    expect(template.status).toBe(201);
    itemIds.push(template.body.id as string);
    for (let i = 1; i < LINES; i += 1) {
      const code = `I${String(i).padStart(3, '0')}`;
      const res = (await db.query(
        `INSERT INTO items (tenant_id, company_id, code, name_ar, item_kind, base_unit_id, tax_category_id,
                            min_stock, sale_price_includes_tax, is_active, created_at, updated_at)
         SELECT tenant_id, company_id, ?, ?, item_kind, base_unit_id, tax_category_id,
                min_stock, sale_price_includes_tax, 1, NOW(3), NOW(3)
         FROM items WHERE tenant_id = ? AND id = ?`,
        [code, `Item ${i}`, tenantId, template.body.id],
      )) as { insertId: bigint };
      itemIds.push(res.insertId.toString());
    }

    const opening = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-01-05',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: itemIds.map((itemId) => ({ itemId, qty: '100', unitCost: '2.000' })),
      });
    expect(opening.status).toBe(201);
    expect((await post('stock-adjustments', opening.body.id as string)).status).toBe(201);
    await assertLedgersConsistent();
  }, 120_000);

  it('two 120-line invoices in opposite line order post concurrently without deadlock', async () => {
    const draft = async (ids: string[]) => {
      const res = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(token))
        .send({
          invoiceDate: '2025-02-10',
          customerId,
          warehouseId,
          paymentType: 'CREDIT',
          lines: ids.map((itemId) => ({ itemId, qty: '1', unitPrice: '5.000' })),
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const ascending = await draft(itemIds);
    const descending = await draft([...itemIds].reverse());

    const results = await Promise.all([post('sales-invoices', ascending), post('sales-invoices', descending)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(results.map((r) => r.body.status)).toEqual(['POSTED', 'POSTED']);

    const balances = (await db.query(
      'SELECT COUNT(*) AS n, MIN(qty_on_hand) AS lo, MAX(qty_on_hand) AS hi FROM stock_balances WHERE tenant_id = ? AND warehouse_id = ?',
      [tenantId, warehouseId],
    )) as { n: bigint; lo: string; hi: string }[];
    expect(Number(balances[0].n)).toBe(LINES);
    expect(new Decimal(balances[0].lo).toFixed(6)).toBe('98.000000');
    expect(new Decimal(balances[0].hi).toFixed(6)).toBe('98.000000');
    await assertLedgersConsistent();
  }, 120_000);

  it("TRADE-21: a 120-line invoice writes every line's cost snapshot from its own stock movement", async () => {
    // Varied quantities (1..9) so every line has a different cost total.
    const lines = itemIds.map((itemId, i) => ({ itemId, qty: String((i % 9) + 1), unitPrice: '5.000' }));
    const res = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({ invoiceDate: '2025-02-12', customerId, warehouseId, paymentType: 'CREDIT', lines });
    expect(res.status).toBe(201);
    const invoiceId = res.body.id as string;

    const posted = await post('sales-invoices', invoiceId);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe('POSTED');

    const rows = (await db.query(
      `SELECT l.id, l.unit_cost, l.cost_total, m.unit_cost AS m_unit, m.total_cost AS m_total
         FROM sales_invoice_lines l
         JOIN stock_movements m ON m.tenant_id = l.tenant_id AND m.source_type = 'SALES_INVOICE' AND m.source_line_id = l.id
        WHERE l.tenant_id = ? AND l.invoice_id = ?`,
      [tenantId, invoiceId],
    )) as { id: bigint; unit_cost: string; cost_total: string; m_unit: string; m_total: string }[];
    expect(rows).toHaveLength(LINES);

    // Opening cost is 2.000, so every snapshot unit cost is 2.000000.
    expect(rows.map((r) => new Decimal(r.unit_cost).toFixed(6))).toEqual(rows.map(() => '2.000000'));
    // Each line's snapshot matches the movement written for that same line.
    const snapshot = rows.map((r) => [String(r.id), new Decimal(r.unit_cost).toFixed(6), new Decimal(r.cost_total).toFixed(3)]);
    const fromMovement = rows.map((r) => [String(r.id), new Decimal(r.m_unit).toFixed(6), new Decimal(r.m_total).toFixed(3)]);
    expect(snapshot).toEqual(fromMovement);

    // Invoice total = sum of line totals = Σ(qty × 2.000) over the 120 lines.
    const sumLines = rows.reduce<Decimal>((acc, r) => acc.plus(r.cost_total), new Decimal(0));
    let expected = new Decimal(0);
    for (let i = 0; i < LINES; i += 1) expected = expected.plus(new Decimal((i % 9) + 1).times(2));
    const [header] = (await db.query('SELECT cost_total FROM sales_invoices WHERE tenant_id = ? AND id = ?', [
      tenantId,
      invoiceId,
    ])) as { cost_total: string }[];
    expect(sumLines.toFixed(3)).toBe(expected.toFixed(3));
    expect(new Decimal(header.cost_total).toFixed(3)).toBe(expected.toFixed(3));

    await assertLedgersConsistent();
  }, 120_000);

  it('12 invoices posted at once with the default pool (10) all succeed with consecutive numbers', async () => {
    // Each posting holds one connection for its transaction. Any read through
    // another client inside it (the plan quota did) needs a second one, so 10+
    // postings at once used to wait on each other until the acquire timeout.
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(token))
        .send({
          invoiceDate: '2025-02-14',
          customerId,
          warehouseId,
          paymentType: 'CREDIT',
          lines: [{ itemId: itemIds[i], qty: '1', unitPrice: '5.000' }],
        });
      expect(res.status).toBe(201);
      ids.push(res.body.id as string);
    }

    const results = await Promise.all(ids.map((id) => post('sales-invoices', id)));
    expect(results.map((r) => r.status)).toEqual(ids.map(() => 201));

    const suffix = (no: string) => Number(no.split('-').pop());
    const consecutive = (nos: string[]) => {
      const n = nos.map(suffix).sort((a, b) => a - b);
      return n.every((v, i) => i === 0 || v === n[i - 1] + 1);
    };
    const invoiceNos = results.map((r) => r.body.invoiceNo as string);
    expect(new Set(invoiceNos).size).toBe(12);
    expect(consecutive(invoiceNos)).toBe(true);

    const entries = (await db.query(
      `SELECT je.entry_no FROM sales_invoices si JOIN journal_entries je ON je.tenant_id = si.tenant_id AND je.id = si.journal_entry_id
        WHERE si.tenant_id = ? AND si.id IN (?)`,
      [tenantId, ids],
    )) as { entry_no: string }[];
    expect(entries).toHaveLength(12);
    expect(consecutive(entries.map((e) => e.entry_no))).toBe(true);
    await assertLedgersConsistent();
  }, 120_000);

  it('two documents race on the first movement of a brand-new item', async () => {
    const item = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'NEW', nameAr: 'New item', baseUnitId: pcs });
    expect(item.status).toBe(201);
    const newItemId = item.body.id as string;

    const draft = async (supplierInvoiceNo: string) => {
      const res = await api()
        .post('/api/v1/purchase-invoices')
        .set(auth(token))
        .send({
          invoiceDate: '2025-03-01',
          supplierId,
          warehouseId,
          paymentType: 'CREDIT',
          supplierInvoiceNo,
          lines: [{ itemId: newItemId, qty: '10', unitCost: '3.000' }],
        });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const [first, second] = [await draft('NEW-1'), await draft('NEW-2')];

    const results = await Promise.all([post('purchase-invoices', first), post('purchase-invoices', second)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);

    const costs = (await db.query(
      'SELECT total_qty, avg_cost FROM item_costs WHERE tenant_id = ? AND item_id = ?',
      [tenantId, newItemId],
    )) as { total_qty: string; avg_cost: string }[];
    expect(costs).toHaveLength(1);
    expect(new Decimal(costs[0].total_qty).toFixed(6)).toBe('20.000000');
    expect(new Decimal(costs[0].avg_cost).toFixed(6)).toBe('3.000000');
    const balances = (await db.query(
      'SELECT qty_on_hand FROM stock_balances WHERE tenant_id = ? AND item_id = ?',
      [tenantId, newItemId],
    )) as { qty_on_hand: string }[];
    expect(balances).toHaveLength(1);
    expect(new Decimal(balances[0].qty_on_hand).toFixed(6)).toBe('20.000000');
    await assertLedgersConsistent();
  }, 60_000);

  it("tenant B sees none of tenant A's stock", async () => {
    const verify = await api().get('/api/v1/stock/verify').set(auth(tokenB));
    expect(verify.status).toBe(200);
    expect(verify.body.checked).toBe(0);
    const invoice = await api().get(`/api/v1/items/${itemIds[0]}`).set(auth(tokenB));
    expect(invoice.status).toBe(404);
  });
});
