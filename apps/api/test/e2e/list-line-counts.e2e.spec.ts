/**
 * Line counts in the document lists (Wave 5A, `withLineCounts`): each row's
 * `_count.lines` is the exact number of its own lines, counted for the page
 * only and inside the caller's tenant. Tenant A and tenant B each create a
 * sales invoice, a purchase return and a stock adjustment with 1 and 3 lines
 * (A) or 2 and 4 lines (B); each tenant's page 1 shows its own documents with
 * its own counts, and never the other tenant's documents or lines.
 * Real MariaDB (E2E_DB_NAME, default erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import { testDatabaseUrl } from './support/test-db.js';

const API_PORT = 3297;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `lc-${RUN}-${Math.random().toString(36).slice(2)}` });

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
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
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

/** A tenant's documents: id → the number of lines it was created with. */
interface Tenant {
  token: string;
  salesInvoices: Map<string, number>;
  purchaseReturns: Map<string, number>;
  stockAdjustments: Map<string, number>;
}

async function created(res: request.Response, what: string): Promise<string> {
  if (res.status !== 201) throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id as string;
}

/** Registers a tenant and creates its documents: one with `small` lines, one with `large` lines, of each kind. */
async function setUpTenant(label: string, small: number, large: number): Promise<Tenant> {
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: `Line counts ${label} ${RUN}`, ownerName: 'Owner', email: `lc-${label}-${RUN}@test.dev`, password: PASS });
  if (reg.status !== 201) throw new Error(`register ${label}: ${reg.status} ${JSON.stringify(reg.body)}`);
  const token = reg.body.accessToken as string;
  const get = async <T,>(url: string): Promise<T> => {
    const res = await api().get(url).set(auth(token));
    if (res.status !== 200) throw new Error(`GET ${url}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  };
  const send = (url: string, body: object) => api().post(url).set(auth(token)).send(body);

  await created(await send('/api/v1/fiscal-years', { code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' }), 'fiscal year');
  const warehouseId = await created(await send('/api/v1/warehouses', { code: 'W1', nameAr: 'W1' }), 'warehouse');
  const pcs = (await get<{ id: string; code: string }[]>('/api/v1/units')).find((u) => u.code === 'PCS')!.id;
  const items: string[] = [];
  for (let i = 1; i <= large; i++) {
    items.push(await created(await send('/api/v1/items', { code: `I${i}`, nameAr: `I${i}`, baseUnitId: pcs }), `item ${i}`));
  }
  const customerId = await created(
    await send('/api/v1/parties', { code: 'CUST', nameAr: `Customer ${label}`, partyType: 'CUSTOMER' }),
    'customer',
  );
  const supplierId = await created(
    await send('/api/v1/parties', { code: 'SUPP', nameAr: `Supplier ${label}`, partyType: 'SUPPLIER' }),
    'supplier',
  );

  // A posted purchase invoice with `large` lines: the purchase returns name its lines.
  const purchaseId = await created(
    await send('/api/v1/purchase-invoices', {
      invoiceDate: '2025-02-01',
      supplierId,
      warehouseId,
      paymentType: 'CREDIT',
      lines: items.map((itemId) => ({ itemId, qty: '5', unitCost: '2.000' })),
    }),
    'purchase invoice',
  );
  const posted = await api().post(`/api/v1/purchase-invoices/${purchaseId}/post`).set(auth(token)).set(idem());
  if (posted.status !== 201) throw new Error(`post purchase invoice: ${posted.status} ${JSON.stringify(posted.body)}`);
  const purchaseLines = (await get<{ lines: { id: string }[] }>(`/api/v1/purchase-invoices/${purchaseId}`)).lines;

  const tenant: Tenant = { token, salesInvoices: new Map(), purchaseReturns: new Map(), stockAdjustments: new Map() };
  for (const n of [small, large]) {
    const some = items.slice(0, n);
    tenant.salesInvoices.set(
      await created(
        await send('/api/v1/sales-invoices', {
          invoiceDate: '2025-03-01',
          customerId,
          warehouseId,
          paymentType: 'CREDIT',
          lines: some.map((itemId) => ({ itemId, qty: '1', unitPrice: '3.000' })),
        }),
        'sales invoice',
      ),
      n,
    );
    tenant.purchaseReturns.set(
      await created(
        await send('/api/v1/purchase-returns', {
          returnDate: '2025-03-02',
          originalInvoiceId: purchaseId,
          warehouseId,
          refundType: 'CREDIT',
          lines: purchaseLines.slice(0, n).map((l) => ({ originalLineId: l.id, qty: '1' })),
        }),
        'purchase return',
      ),
      n,
    );
    tenant.stockAdjustments.set(
      await created(
        await send('/api/v1/stock-adjustments', {
          adjustmentDate: '2025-03-03',
          adjustmentType: 'OPENING',
          warehouseId,
          lines: some.map((itemId) => ({ itemId, qty: '2', unitCost: '1.000' })),
        }),
        'stock adjustment',
      ),
      n,
    );
  }
  return tenant;
}

describe('_count.lines in the document lists (Wave 5A)', () => {
  let a: Tenant;
  let b: Tenant;

  it('setup: tenants A (1 and 3 lines) and B (2 and 4 lines)', async () => {
    a = await setUpTenant('a', 1, 3);
    b = await setUpTenant('b', 2, 4);
  }, 120_000);

  const lists = [
    ['/api/v1/sales-invoices', 'salesInvoices'],
    ['/api/v1/purchase-returns', 'purchaseReturns'],
    ['/api/v1/stock-adjustments', 'stockAdjustments'],
  ] as const;

  it.each(lists)("%s: each row counts its own lines, in its own tenant only", async (url, kind) => {
    for (const [me, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await api().get(`${url}?page=1&pageSize=50`).set(auth(me.token));
      expect(res.status).toBe(200);
      const rows = res.body.items as { id: string; _count: { lines: number } }[];
      const counts = Object.fromEntries(rows.map((r) => [r.id, r._count.lines]));
      // Exactly this tenant's documents, each with the number of lines it was created with.
      expect(counts).toEqual(Object.fromEntries(me[kind]));
      for (const id of other[kind].keys()) expect(counts[id]).toBeUndefined();
    }
  });

  it('a page past the end has no rows and the real total', async () => {
    const res = await api().get('/api/v1/sales-invoices?page=5&pageSize=1').set(auth(a.token));
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.total).toBe(2);
  });
});
