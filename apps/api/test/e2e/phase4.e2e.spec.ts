/**
 * Phase 4 integration tests — inventory: catalog, warehouses, stock
 * adjustments (opening/IN/OUT), weighted-average costing, transfers,
 * stock counts, stock:verify, negative-stock & backdating rules,
 * tenant isolation. Real MariaDB (erp_test), built API on :3198.
 * Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';

const API_PORT = 3198;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const TODAY = '2025-03-15';

let server: ChildProcess;
let db: Connection;

function api() {
  return request(BASE);
}
function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
function idem() {
  return { 'Idempotency-Key': `k-${RUN}-${Math.random().toString(36).slice(2)}` };
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
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
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
    database: 'erp_test',
  });

  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

describe('Phase 4 — inventory (erp_test)', () => {
  let token = '';
  let tokenB = '';
  let warehouseId = '';
  let warehouse2Id = '';
  let itemId = '';
  let serviceItemId = '';
  let pcsUnitId = '';

  async function registerTenant(suffix: string) {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Inv ${suffix} ${RUN}`,
        ownerName: 'Owner',
        email: `inv-${suffix}-${RUN}@test.dev`,
        password: PASS,
      });
    expect(res.status).toBe(201);
    return res.body.accessToken as string;
  }

  async function postAdjustment(body: object) {
    const created = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send(body);
    expect(created.status).toBe(201);
    return api()
      .post(`/api/v1/stock-adjustments/${created.body.id}/post`)
      .set(auth(token))
      .set(idem());
  }

  async function balanceOf(item: string, warehouse?: string) {
    const res = await api().get('/api/v1/stock/balances').set(auth(token));
    expect(res.status).toBe(200);
    const rows = (res.body as { itemId: string; warehouseId: string; qtyOnHand: string }[]).filter(
      (r) => r.itemId === item && (!warehouse || r.warehouseId === warehouse),
    );
    return rows.reduce((s, r) => s + Number(r.qtyOnHand), 0);
  }

  it('sets up tenant: fiscal year, unit, warehouse, items', async () => {
    token = await registerTenant('a');
    tokenB = await registerTenant('b');

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);

    const units = await api().get('/api/v1/units').set(auth(token));
    pcsUnitId = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;

    const wh = await api()
      .post('/api/v1/warehouses')
      .set(auth(token))
      .send({ code: 'WH1', nameAr: 'المستودع الرئيسي' });
    expect(wh.status).toBe(201);
    warehouseId = wh.body.id;

    // TRIAL plan allows only 1 warehouse — insert the second directly to
    // exercise transfers (plan-limit behavior is covered in phase1 tests).
    const tRows = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Inv a ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const { tenantId: tid, companyId: cid } = tRows[0];
    const now = new Date();
    const ins = await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tid, cid, 'WH2', 'مستودع الفرع', now, now],
    );
    warehouse2Id = String((ins as { insertId: bigint }).insertId);

    const item = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'ITM-1', nameAr: 'صنف تجريبي', baseUnitId: pcsUnitId, salePrice: '10' });
    expect(item.status).toBe(201);
    itemId = item.body.id;

    const svc = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({
        code: 'SVC-1',
        nameAr: 'خدمة توصيل',
        baseUnitId: pcsUnitId,
        itemKind: 'SERVICE',
      });
    serviceItemId = svc.body.id;
  });

  it('posts an OPENING adjustment → balance + journal entry', async () => {
    const res = await postAdjustment({
      adjustmentDate: TODAY,
      adjustmentType: 'OPENING',
      warehouseId,
      lines: [{ itemId, qty: '10', unitCost: '5.000' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('POSTED');
    expect(res.body.docNo).toMatch(/^SA-2025-/);
    expect(res.body.journalEntryId).not.toBeNull();

    expect(await balanceOf(itemId)).toBeCloseTo(10);

    const entry = await api()
      .get(`/api/v1/journal-entries/${res.body.journalEntryId}`)
      .set(auth(token));
    expect(entry.status).toBe(200);
    const lines = entry.body.lines as { debit: string; credit: string }[];
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    expect(totalDebit).toBeCloseTo(50);
  });

  it('weighted-average: IN 10 @ 7 → avg 6, OUT 5 → cost 30', async () => {
    const inn = await postAdjustment({
      adjustmentDate: TODAY,
      adjustmentType: 'IN',
      warehouseId,
      lines: [{ itemId, qty: '10', unitCost: '7.000' }],
    });
    expect(inn.status).toBe(201);

    const val = await api().get('/api/v1/stock/valuation').set(auth(token));
    const row = (val.body.rows as { itemId: string; qty: string; avgCost: string }[]).find(
      (r) => r.itemId === itemId,
    )!;
    expect(Number(row.qty)).toBeCloseTo(20);
    expect(Number(row.avgCost)).toBeCloseTo(6);

    const out = await postAdjustment({
      adjustmentDate: TODAY,
      adjustmentType: 'OUT',
      warehouseId,
      lines: [{ itemId, qty: '5' }],
    });
    expect(out.status).toBe(201);

    const movements = await api()
      .get(`/api/v1/stock/movements?itemId=${itemId}`)
      .set(auth(token));
    const outMove = (movements.body.rows as { movementType: string; totalCost: string }[]).find(
      (m) => m.movementType === 'OUT',
    )!;
    expect(Number(outMove.totalCost)).toBeCloseTo(30);
    expect(await balanceOf(itemId)).toBeCloseTo(15);
  });

  it('rejects OUT exceeding stock (STOCK_INSUFFICIENT) and service items', async () => {
    const tooMuch = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: TODAY,
        adjustmentType: 'OUT',
        warehouseId,
        lines: [{ itemId, qty: '999' }],
      });
    expect(tooMuch.status).toBe(201);
    const post = await api()
      .post(`/api/v1/stock-adjustments/${tooMuch.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe('STOCK_INSUFFICIENT');

    const svcAdj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: TODAY,
        adjustmentType: 'IN',
        warehouseId,
        lines: [{ itemId: serviceItemId, qty: '1', unitCost: '5' }],
      });
    expect(svcAdj.status).toBe(400);
  });

  it('rejects backdated stock posting', async () => {
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-03-01',
        adjustmentType: 'IN',
        warehouseId,
        lines: [{ itemId, qty: '1', unitCost: '5' }],
      });
    expect(adj.status).toBe(201);
    const post = await api()
      .post(`/api/v1/stock-adjustments/${adj.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe('BACKDATED_STOCK_POSTING');
  });

  it('transfers stock between warehouses at same cost, no journal', async () => {
    const tr = await api()
      .post('/api/v1/stock-transfers')
      .set(auth(token))
      .send({
        transferDate: TODAY,
        fromWarehouseId: warehouseId,
        toWarehouseId: warehouse2Id,
        lines: [{ itemId, qty: '4' }],
      });
    expect(tr.status).toBe(201);
    const post = await api()
      .post(`/api/v1/stock-transfers/${tr.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(201);
    expect(post.body.status).toBe('POSTED');
    expect(post.body.docNo).toMatch(/^ST-2025-/);

    expect(await balanceOf(itemId, warehouseId)).toBeCloseTo(11);
    expect(await balanceOf(itemId, warehouse2Id)).toBeCloseTo(4);

    // Same-cost check: destination IN movement cost == source OUT cost.
    const moves = await api()
      .get(`/api/v1/stock/movements?itemId=${itemId}&sourceType=STOCK_TRANSFER`)
      .set(auth(token));
    const costs = new Set(
      (moves.body.rows as { unitCost: string }[]).map((m) => Number(m.unitCost)),
    );
    expect(costs.size).toBe(1);
  });

  it('reverses a transfer → balances restored', async () => {
    const list = await api().get('/api/v1/stock-transfers?status=POSTED').set(auth(token));
    const posted = (list.body as { id: string; reversalOfId: string | null }[]).find(
      (t) => !t.reversalOfId,
    )!;
    const rev = await api()
      .post(`/api/v1/stock-transfers/${posted.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: TODAY });
    expect(rev.status).toBe(201);
    expect(await balanceOf(itemId, warehouseId)).toBeCloseTo(15);
    expect(await balanceOf(itemId, warehouse2Id)).toBeCloseTo(0);
  });

  it('stock count → approve generates COUNT_ADJUSTMENT', async () => {
    // WH1 has 15 on hand; count 12 → shortage of 3.
    const count = await api()
      .post('/api/v1/stock-counts')
      .set(auth(token))
      .send({ countDate: TODAY, warehouseId });
    expect(count.status).toBe(201);
    expect(count.body.lines.length).toBeGreaterThan(0);

    // countedQty=null everywhere → approve must fail.
    const early = await api()
      .post(`/api/v1/stock-counts/${count.body.id}/approve`)
      .set(auth(token));
    expect(early.status).toBe(400);

    for (const line of count.body.lines as {
      id: string;
      itemId: string;
      systemQty: string;
    }[]) {
      const counted =
        line.itemId === itemId ? String(Number(line.systemQty) - 3) : line.systemQty;
      const upd = await api()
        .put(`/api/v1/stock-counts/${count.body.id}/lines/${line.id}`)
        .set(auth(token))
        .send({ countedQty: counted });
      expect(upd.status).toBe(200);
    }

    const approve = await api()
      .post(`/api/v1/stock-counts/${count.body.id}/approve`)
      .set(auth(token));
    expect(approve.status).toBe(201);
    expect(approve.body.status).toBe('POSTED');
    expect(approve.body.adjustmentId).not.toBeNull();

    expect(await balanceOf(itemId, warehouseId)).toBeCloseTo(12);
  });

  it('stock:verify reports no mismatches', async () => {
    const res = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.mismatches).toEqual([]);
  });

  it('tenant isolation: tenant B cannot see tenant A stock data', async () => {
    const balances = await api().get('/api/v1/stock/balances').set(auth(tokenB));
    expect(balances.status).toBe(200);
    expect(
      (balances.body as { itemId: string }[]).every((r) => r.itemId !== itemId),
    ).toBe(true);

    const itemA = await api().get(`/api/v1/items/${itemId}`).set(auth(tokenB));
    expect(itemA.status).toBe(404);

    const whA = await api().get(`/api/v1/warehouses/${warehouseId}`).set(auth(tokenB));
    expect(whA.status).toBe(404);
  });
});
