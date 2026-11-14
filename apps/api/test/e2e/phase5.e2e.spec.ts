/**
 * Phase 5 integration tests — parties, purchase/sales invoices (stock +
 * journal posting), returns, GRN/GIN goods notes, treasury receipts/payments
 * with invoice allocations. Real MariaDB (erp_test), built API on :3199.
 * Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';

const API_PORT = 3199;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

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
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

const g = globalThis as { __siId?: string; __siGrand?: number };

describe('Phase 5 — parties, invoices, returns, goods notes, treasury', () => {
  let token = '';
  let tokenB = '';
  let warehouseId = '';
  let stockItemId = '';
  let serviceItemId = '';
  let customerId = '';
  let supplierId = '';
  let cashAccountId = '';

  async function registerTenant(suffix: string) {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `Doc ${suffix} ${RUN}`,
        ownerName: 'Owner',
        email: `doc-${suffix}-${RUN}@test.dev`,
        password: PASS,
      });
    expect(res.status).toBe(201);
    return res.body.accessToken as string;
  }

  async function postDoc(kind: 'sales-invoices' | 'purchase-invoices' | 'sales-returns' | 'purchase-returns' | 'goods-notes', id: string) {
    return api()
      .post(`/api/v1/${kind}/${id}/post`)
      .set(auth(token))
      .set(idem());
  }

  async function balances(itemId: string) {
    const res = await api().get('/api/v1/stock/balances').set(auth(token));
    return (res.body as { itemId: string; qtyOnHand: string }[])
      .filter((r) => r.itemId === itemId)
      .reduce((s, r) => s + Number(r.qtyOnHand), 0);
  }

  function journalTotals(lines: { debit: string; credit: string }[]) {
    return {
      debit: lines.reduce((s, l) => s + Number(l.debit), 0),
      credit: lines.reduce((s, l) => s + Number(l.credit), 0),
    };
  }

  it('sets up tenant: FY, warehouse, items, parties, cash account', async () => {
    token = await registerTenant('a');
    tokenB = await registerTenant('b');

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);

    const wh = await api()
      .post('/api/v1/warehouses')
      .set(auth(token))
      .send({ code: 'WH1', nameAr: 'Main' });
    expect(wh.status).toBe(201);
    warehouseId = wh.body.id;

    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;

    const item = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'ITM-1', nameAr: 'Item One', baseUnitId: pcs });
    expect(item.status).toBe(201);
    stockItemId = item.body.id;

    const svc = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'SVC-1', nameAr: 'Service One', baseUnitId: pcs, itemKind: 'SERVICE' });
    serviceItemId = svc.body.id;

    const cust = await api()
      .post('/api/v1/parties')
      .set(auth(token))
      .send({ code: 'C-1', nameAr: 'Customer One', partyType: 'CUSTOMER' });
    expect(cust.status).toBe(201);
    customerId = cust.body.id;

    const supp = await api()
      .post('/api/v1/parties')
      .set(auth(token))
      .send({ code: 'S-1', nameAr: 'Supplier One', partyType: 'SUPPLIER' });
    expect(supp.status).toBe(201);
    supplierId = supp.body.id;

    // Opening stock 100 @ 5 via adjustment.
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(token))
      .send({
        adjustmentDate: '2025-03-01',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId: stockItemId, qty: '100', unitCost: '5.000' }],
      });
    expect(adj.status).toBe(201);
    const adjPost = await api()
      .post(`/api/v1/stock-adjustments/${adj.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(adjPost.status).toBe(201);

    // Find the cash account (1101) from the account tree.
    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    const flat: { id: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;
  });

  it('purchase invoice (credit) posts stock IN + balanced journal', async () => {
    const created = await api()
      .post('/api/v1/purchase-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-10',
        supplierId,
        warehouseId,
        paymentType: 'CREDIT',
        supplierInvoiceNo: 'SUP-1',
        lines: [
          { itemId: stockItemId, qty: '10', unitCost: '6.00' },
          { itemId: serviceItemId, qty: '2', unitCost: '20.00' },
        ],
      });
    expect(created.status).toBe(201);
    // 10*6=60 + 2*20=40 → net 100, tax 16 → grand 116
    expect(Number(created.body.netTotal)).toBeCloseTo(100);
    expect(Number(created.body.grandTotal)).toBeCloseTo(116);

    const posted = await postDoc('purchase-invoices', created.body.id);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.invoiceNo).toMatch(/^PI-2025-/);

    expect(await balances(stockItemId)).toBeCloseTo(110);

    const entry = await api()
      .get(`/api/v1/journal-entries/${posted.body.journalEntryId}`)
      .set(auth(token));
    const t = journalTotals(entry.body.lines);
    expect(t.debit).toBeCloseTo(t.credit);
    expect(t.debit).toBeCloseTo(116);
  });

  it('sales invoice (credit) posts stock OUT + COGS journal', async () => {
    const created = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-12',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: stockItemId, qty: '20', unitPrice: '8.00' }],
      });
    expect(created.status).toBe(201);
    // 20*8=160 net, tax 25.6 → 185.6
    expect(Number(created.body.grandTotal)).toBeCloseTo(185.6);

    const posted = await postDoc('sales-invoices', created.body.id);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.costTotal).not.toBe('0');

    expect(await balances(stockItemId)).toBeCloseTo(90);

    const entry = await api()
      .get(`/api/v1/journal-entries/${posted.body.journalEntryId}`)
      .set(auth(token));
    const t = journalTotals(entry.body.lines);
    expect(t.debit).toBeCloseTo(t.credit);
    expect(t.debit).toBeCloseTo(185.6 + Number(posted.body.costTotal));
    g.__siId = created.body.id as string;
    g.__siGrand = Number(created.body.grandTotal);
  });

  it('sales return (credit) restores stock at original cost', async () => {
    const siId = g.__siId as string;
    const inv = await api().get(`/api/v1/sales-invoices/${siId}`).set(auth(token));
    const lineId = (inv.body.lines as { id: string }[])[0].id;

    const created = await api()
      .post('/api/v1/sales-returns')
      .set(auth(token))
      .send({
        returnDate: '2025-03-14',
        originalInvoiceId: siId,
        refundType: 'CREDIT',
        lines: [{ originalLineId: lineId, qty: '5' }],
      });
    expect(created.status).toBe(201);

    const posted = await postDoc('sales-returns', created.body.id);
    expect(posted.status).toBe(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.returnNo).toMatch(/^SR-2025-/);

    expect(await balances(stockItemId)).toBeCloseTo(95);
  });

  it('rejects over-returning an invoice line', async () => {
    const siId = g.__siId as string;
    const inv = await api().get(`/api/v1/sales-invoices/${siId}`).set(auth(token));
    const lineId = (inv.body.lines as { id: string }[])[0].id;

    const created = await api()
      .post('/api/v1/sales-returns')
      .set(auth(token))
      .send({
        returnDate: '2025-03-15',
        originalInvoiceId: siId,
        refundType: 'CREDIT',
        lines: [{ originalLineId: lineId, qty: '16' }], // only 15 remain
      });
    expect(created.status).toBe(400);
  });

  it('receipt voucher allocates to the sales invoice and updates paid_amount', async () => {
    const siId = g.__siId as string;
    const grand = g.__siGrand as number;
    // Credit return of 5/20 units → outstanding = grand − 46.4 = 139.2.
    const outstanding = Math.round((grand - 46.4) * 1000) / 1000;

    const res = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-03-16',
        partyType: 'CUSTOMER',
        partyId: customerId,
        cashAccountId,
        amount: String(outstanding),
        referenceNo: 'RCP-1',
        allocations: [
          { documentType: 'SALES_INVOICE', documentId: siId, amount: String(outstanding) },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.receiptNo).toMatch(/^RC-2025-/);
    expect(res.body.journalEntryId).not.toBeNull();

    const inv = await api().get(`/api/v1/sales-invoices/${siId}`).set(auth(token));
    expect(Number(inv.body.paidAmount)).toBeCloseTo(outstanding);
  });

  it('rejects allocation exceeding invoice outstanding', async () => {
    const siId = g.__siId as string;
    const res = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-03-17',
        partyType: 'CUSTOMER',
        partyId: customerId,
        cashAccountId,
        amount: '500',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: siId, amount: '500' }],
      });
    // Invoice fully settled by credit return + receipt → outstanding ≤ 0.
    expect(res.status).toBe(400);
  });

  it('payment voucher to supplier settles the purchase invoice', async () => {
    const pinv = await api()
      .get('/api/v1/purchase-invoices')
      .set(auth(token))
      .query({ status: 'POSTED' });
    const inv = (pinv.body as { id: string; supplierId: string; grandTotal: string }[])[0];

    const res = await api()
      .post('/api/v1/payments')
      .set(auth(token))
      .set(idem())
      .send({
        paymentDate: '2025-03-18',
        partyType: 'SUPPLIER',
        partyId: supplierId,
        cashAccountId,
        amount: inv.grandTotal,
        allocations: [
          { documentType: 'PURCHASE_INVOICE', documentId: inv.id, amount: inv.grandTotal },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.paymentNo).toMatch(/^PY-2025-/);

    const after = await api().get(`/api/v1/purchase-invoices/${inv.id}`).set(auth(token));
    expect(Number(after.body.paidAmount)).toBeCloseTo(Number(inv.grandTotal));
  });

  it('GRN posts stock IN against GRNI; GIN posts stock OUT', async () => {
    const grn = await api()
      .post('/api/v1/goods-notes')
      .set(auth(token))
      .send({
        noteDate: '2025-03-19',
        warehouseId,
        noteType: 'GRN',
        lines: [{ itemId: stockItemId, qty: '10', unitCost: '4.00' }],
      });
    expect(grn.status).toBe(201);
    const grnPost = await postDoc('goods-notes', grn.body.id);
    expect(grnPost.status).toBe(201);
    expect(grnPost.body.docNo).toMatch(/^GRN-2025-/);
    expect(await balances(stockItemId)).toBeCloseTo(105);

    const gin = await api()
      .post('/api/v1/goods-notes')
      .set(auth(token))
      .send({
        noteDate: '2025-03-20',
        warehouseId,
        noteType: 'GIN',
        lines: [{ itemId: stockItemId, qty: '5' }],
      });
    const ginPost = await postDoc('goods-notes', gin.body.id);
    expect(ginPost.status).toBe(201);
    expect(ginPost.body.docNo).toMatch(/^GIN-2025-/);
    expect(await balances(stockItemId)).toBeCloseTo(100);
  });

  it('draft invoice can be modified then deleted; posted is immutable', async () => {
    const created = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-21',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: serviceItemId, qty: '1', unitPrice: '50.00' }],
      });
    expect(created.status).toBe(201);

    const upd = await api()
      .put(`/api/v1/sales-invoices/${created.body.id}`)
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-21',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: serviceItemId, qty: '2', unitPrice: '50.00' }],
      });
    expect(upd.status).toBe(200);
    expect(Number(upd.body.grandTotal)).toBeCloseTo(116);

    const del = await api()
      .delete(`/api/v1/sales-invoices/${created.body.id}`)
      .set(auth(token));
    expect(del.status).toBe(200);

    // Posted invoice cannot be updated.
    const siId = g.__siId as string;
    const bad = await api()
      .put(`/api/v1/sales-invoices/${siId}`)
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-21',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: serviceItemId, qty: '1', unitPrice: '1.00' }],
      });
    expect(bad.status).toBe(409);
  });

  it('cash invoice requires cashAccountId', async () => {
    const res = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2025-03-22',
        customerId,
        warehouseId,
        paymentType: 'CASH',
        lines: [{ itemId: serviceItemId, qty: '1', unitPrice: '10.00' }],
      });
    expect(res.status).toBe(400);
  });

  it('tenant isolation: parties/invoices of tenant B are invisible', async () => {
    const parties = await api().get('/api/v1/parties').set(auth(tokenB));
    expect(parties.status).toBe(200);
    expect((parties.body as unknown[]).length).toBe(0);

    const invoices = await api().get('/api/v1/sales-invoices').set(auth(tokenB));
    expect(invoices.body).toMatchObject({ items: [], total: 0 });

    const other = await api()
      .get(`/api/v1/sales-invoices/${g.__siId as string}`)
      .set(auth(tokenB));
    expect(other.status).toBe(404);
  });
});
