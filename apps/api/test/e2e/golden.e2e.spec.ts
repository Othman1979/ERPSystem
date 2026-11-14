/**
 * Golden scenarios S1–S11 — BUILD_PLAN §18, verbatim.
 *
 * One fresh tenant runs the whole story in order; every expected figure below
 * is copied from the plan. Per CLAUDE.md these numbers must never be edited to
 * make a test pass — a failure means the code (or the plan) is wrong.
 *
 * Real MariaDB (erp_test) + the built API on its own port; item_costs is read
 * straight from the database because the API exposes qty × avg, not the stored
 * total_value the scenarios assert. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { wholeStatement } from './support/statements.js';

const API_PORT = 3195;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `g-${RUN}-${Math.random().toString(36).slice(2)}` });

/** Exact 3-decimal money string, e.g. "50.000". */
const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);
/** Exact 6-decimal cost/qty string, e.g. "5.625000". */
const d6 = (v: Decimal.Value) => new Decimal(v).toFixed(6);

/** Every stock movement of an item, following nextCursor (ADR-022 §4): never capped at one page. */
async function allMovements(token: string, itemId: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: string | null = null;
  do {
    const res: request.Response = await api()
      .get(`/api/v1/stock/movements?itemId=${itemId}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      .set(auth(token));
    if (res.status !== 200) throw new Error(`movements: ${res.status} ${JSON.stringify(res.body)}`);
    rows.push(...(res.body.items as unknown[]));
    cursor = res.body.nextCursor as string | null;
  } while (cursor);
  return rows;
}

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

describe('Golden scenarios S1–S11 (BUILD_PLAN §18)', () => {
  let token = '';
  let W1 = '';
  let W2 = '';
  let A = '';
  let customerId = '';
  let supplierId = '';
  let cashAccountId = '';
  let cashAccountCode = '';
  let s2InvoiceId = '';

  // ------------------------------------------------------------- helpers

  /** Stored item_costs row of item A (tenant-scoped). */
  async function itemCosts() {
    const rows = (await db.query(
      `SELECT ic.total_qty AS qty, ic.total_value AS value, ic.avg_cost AS avg
         FROM item_costs ic
         JOIN items i ON i.id = ic.item_id AND i.tenant_id = ic.tenant_id
        WHERE ic.item_id = ?`,
      [A],
    )) as { qty: string; value: string; avg: string }[];
    expect(rows).toHaveLength(1);
    return { qty: d6(rows[0].qty), value: m3(rows[0].value), avg: d6(rows[0].avg) };
  }

  async function stockBalance(warehouseId: string) {
    const res = await api().get('/api/v1/stock/balances').set(auth(token));
    const row = (res.body as { itemId: string; warehouseId: string; qtyOnHand: string }[]).find(
      (r) => r.itemId === A && r.warehouseId === warehouseId,
    );
    return d6(row?.qtyOnHand ?? '0');
  }

  /** Journal lines as sorted "CODE Dr|Cr amount [party]" strings. */
  async function entryLines(entryId: string) {
    const res = await api().get(`/api/v1/journal-entries/${entryId}`).set(auth(token));
    expect(res.status).toBe(200);
    return (
      res.body.lines as {
        account: { code: string };
        debit: string;
        credit: string;
        partyId?: string | null;
      }[]
    )
      .map((l) => {
        const dr = new Decimal(l.debit);
        const side = dr.gt(0) ? `Dr ${m3(dr)}` : `Cr ${m3(l.credit)}`;
        const party = l.partyId === supplierId ? ' supplier' : l.partyId === customerId ? ' customer' : '';
        return `${l.account.code} ${side}${party}`;
      })
      .sort();
  }

  async function createAndPost(kind: string, body: object) {
    const created = await api().post(`/api/v1/${kind}`).set(auth(token)).send(body);
    // Show the API's error body on failure, not just the status.
    if (created.status !== 201) {
      throw new Error(`create ${kind} → ${created.status} ${JSON.stringify(created.body)}`);
    }
    const posted = await api()
      .post(`/api/v1/${kind}/${created.body.id}/post`)
      .set(auth(token))
      .set(idem());
    return { created, posted };
  }

  // --------------------------------------------------------------- setup

  it('setup: new company, W1 + W2, item A (piece), 16% tax', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Golden ${RUN}`, ownerName: 'Owner', email: `golden-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);

    W1 = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W1', nameAr: 'رئيسي' })).body.id;
    expect(W1).toBeDefined();
    // The TRIAL plan allows one warehouse; add W2 directly (plan limits are
    // covered by the phase 1 tests), as the phase 4 suite does.
    const [{ tenantId, companyId }] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Golden ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, companyId, 'W2', 'فرعي', now, now],
    )) as { insertId: bigint };
    W2 = String(ins.insertId);

    const units = await api().get('/api/v1/units').set(auth(token));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const taxes = await api().get('/api/v1/tax-categories').set(auth(token));
    const tax16 = (taxes.body as { id: string; rate: string }[]).find((t) => new Decimal(t.rate).eq(16))!;
    expect(tax16).toBeDefined();

    const item = await api()
      .post('/api/v1/items')
      .set(auth(token))
      .send({ code: 'A', nameAr: 'الصنف أ', baseUnitId: pcs, taxCategoryId: tax16.id });
    expect(item.status).toBe(201);
    A = item.body.id;

    customerId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'عميل', partyType: 'CUSTOMER' })
    ).body.id;
    supplierId = (
      await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'مورد', partyType: 'SUPPLIER' })
    ).body.id;

    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    const flat: { id: string; code: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; code: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    const cash = flat.find((a) => a.controlType === 'CASH')!;
    cashAccountId = cash.id;
    cashAccountCode = cash.code;
  });

  // ------------------------------------------------------------ S1 — S11

  it('S1 credit purchase: 10 × 5.000 into W1', async () => {
    const { created, posted } = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-05',
      supplierId,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '10', unitCost: '5.000' }],
    });
    expect(posted.status).toBe(201);
    expect(m3(created.body.netTotal)).toBe('50.000');
    expect(m3(created.body.taxTotal)).toBe('8.000');
    expect(m3(created.body.grandTotal)).toBe('58.000');
    expect(await entryLines(posted.body.journalEntryId)).toEqual(
      ['1104 Dr 50.000', '1105 Dr 8.000', '2101 Cr 58.000 supplier'].sort(),
    );
    expect(await itemCosts()).toEqual({ qty: '10.000000', value: '50.000', avg: '5.000000' });
    expect(await stockBalance(W1)).toBe('10.000000');
  });

  it('S2 credit sale: 4 × 8.000 from W1', async () => {
    const { created, posted } = await createAndPost('sales-invoices', {
      invoiceDate: '2025-01-06',
      customerId,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '4', unitPrice: '8.000' }],
    });
    expect(posted.status).toBe(201);
    s2InvoiceId = created.body.id;
    expect(m3(created.body.netTotal)).toBe('32.000');
    expect(m3(created.body.taxTotal)).toBe('5.120');
    expect(m3(created.body.grandTotal)).toBe('37.120');
    expect(m3(posted.body.costTotal)).toBe('20.000');
    expect(await entryLines(posted.body.journalEntryId)).toEqual(
      ['1103 Dr 37.120 customer', '4101 Cr 32.000', '2102 Cr 5.120', '5101 Dr 20.000', '1104 Cr 20.000'].sort(),
    );
    expect(await itemCosts()).toEqual({ qty: '6.000000', value: '30.000', avg: '5.000000' });
  });

  it('S3 purchase at a different price: 10 × 6.000', async () => {
    const { posted } = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-07',
      supplierId,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '10', unitCost: '6.000' }],
    });
    expect(posted.status).toBe(201);
    expect(await itemCosts()).toEqual({ qty: '16.000000', value: '90.000', avg: '5.625000' });
  });

  it('S4 cash sale at the new average: 3 × 9.000', async () => {
    const { created, posted } = await createAndPost('sales-invoices', {
      invoiceDate: '2025-01-08',
      customerId,
      warehouseId: W1,
      paymentType: 'CASH',
      cashAccountId,
      lines: [{ itemId: A, qty: '3', unitPrice: '9.000' }],
    });
    expect(posted.status).toBe(201);
    expect(m3(created.body.netTotal)).toBe('27.000');
    expect(m3(created.body.taxTotal)).toBe('4.320');
    expect(m3(created.body.grandTotal)).toBe('31.320');
    expect(m3(posted.body.costTotal)).toBe('16.875');
    expect(await entryLines(posted.body.journalEntryId)).toEqual(
      [`${cashAccountCode} Dr 31.320`, '4101 Cr 27.000', '2102 Cr 4.320', '5101 Dr 16.875', '1104 Cr 16.875'].sort(),
    );
    expect(await itemCosts()).toEqual({ qty: '13.000000', value: '73.125', avg: '5.625000' });
  });

  it('S5 sales return of 1 piece from S2, at the original line cost', async () => {
    const inv = await api().get(`/api/v1/sales-invoices/${s2InvoiceId}`).set(auth(token));
    const lineId = (inv.body.lines as { id: string }[])[0].id;
    const { posted } = await createAndPost('sales-returns', {
      returnDate: '2025-01-09',
      originalInvoiceId: s2InvoiceId,
      refundType: 'CREDIT',
      lines: [{ originalLineId: lineId, qty: '1' }],
    });
    expect(posted.status).toBe(201);
    expect(await entryLines(posted.body.journalEntryId)).toEqual(
      ['4102 Dr 8.000', '2102 Dr 1.280', '1103 Cr 9.280 customer', '1104 Dr 5.000', '5101 Cr 5.000'].sort(),
    );
    expect(await itemCosts()).toEqual({ qty: '14.000000', value: '78.125', avg: '5.580357' });
  });

  it('S6 write-off of the whole balance takes exactly the remaining value', async () => {
    const { posted } = await createAndPost('stock-adjustments', {
      adjustmentDate: '2025-01-10',
      adjustmentType: 'OUT',
      warehouseId: W1,
      lines: [{ itemId: A, qty: '14' }],
    });
    expect(posted.status).toBe(201);
    const moves = await allMovements(token, A);
    const out = (moves as { movementType: string; sourceType: string; qtyOut: string; totalCost: string }[]).find(
      (r) => r.movementType === 'OUT' && new Decimal(r.qtyOut).eq(14),
    )!;
    expect(m3(out.totalCost)).toBe('78.125'); // not 14 × 5.580357 = 78.124998
    expect(await itemCosts()).toEqual({ qty: '0.000000', value: '0.000', avg: expect.any(String) });
  });

  it('S7 transfer 2 from W1 to W2 after buying 5: balances move, costs and journal do not', async () => {
    const buy = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-11',
      supplierId,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '5', unitCost: '6.000' }],
    });
    expect(buy.posted.status).toBe(201);
    const before = await itemCosts();
    const w1Before = new Decimal(await stockBalance(W1));
    const w2Before = new Decimal(await stockBalance(W2));

    const { posted } = await createAndPost('stock-transfers', {
      transferDate: '2025-01-12',
      fromWarehouseId: W1,
      toWarehouseId: W2,
      lines: [{ itemId: A, qty: '2' }],
    });
    expect(posted.status).toBe(201);
    expect(posted.body.journalEntryId ?? null).toBeNull();
    expect(await stockBalance(W1)).toBe(d6(w1Before.minus(2)));
    expect(await stockBalance(W2)).toBe(d6(w2Before.plus(2)));
    expect(await itemCosts()).toEqual(before);
  });

  it('S8 negative stock: selling 10 from W2 (balance 2) is rejected and changes nothing', async () => {
    const seq = async () =>
      ((await api().get('/api/v1/document-sequences').set(auth(token))).body as { prefix: string; nextNumber: number }[])
        .filter((s) => s.prefix === 'SI')
        .map((s) => s.nextNumber);
    // Counts read the lists' totals (ADR-022): the figures compared are unchanged.
    const entries = async () => (await api().get('/api/v1/journal-entries').set(auth(token))).body.total as number;
    const moves = async () => (await allMovements(token, A)).length;
    const [seqBefore, entriesBefore, movesBefore] = [await seq(), await entries(), await moves()];

    const { posted } = await createAndPost('sales-invoices', {
      invoiceDate: '2025-01-13',
      customerId,
      warehouseId: W2,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '10', unitPrice: '9.000' }],
    });
    expect(posted.status).toBeGreaterThanOrEqual(400);
    expect(posted.body.error.code).toBe('STOCK_INSUFFICIENT');
    expect(await seq()).toEqual(seqBefore); // no invoice number consumed
    expect(await entries()).toBe(entriesBefore);
    expect(await moves()).toBe(movesBefore);
  });

  it('S9 back-dated stock posting is rejected', async () => {
    const { posted } = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-02', // before A's last movement (2025-01-12)
      supplierId,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: A, qty: '1', unitCost: '6.000' }],
    });
    expect(posted.status).toBeGreaterThanOrEqual(400);
    expect(posted.body.error.code).toBe('BACKDATED_STOCK_POSTING');
  });

  it('S10 receipt of 20.000 allocated to the S2 invoice', async () => {
    const before = await api().get(`/api/v1/sales-invoices/${s2InvoiceId}`).set(auth(token));
    // 37.120 less the 9.280 credit return applied automatically
    expect(m3(before.body.grandTotal)).toBe('37.120');
    expect(m3(before.body.creditedAmount)).toBe('9.280');
    expect(m3(before.body.outstanding)).toBe('27.840');

    const rc = await api()
      .post('/api/v1/receipts')
      .set(auth(token))
      .set(idem())
      .send({
        receiptDate: '2025-01-14',
        partyType: 'CUSTOMER',
        partyId: customerId,
        cashAccountId,
        amount: '20.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: s2InvoiceId, amount: '20.000' }],
      });
    expect(rc.status).toBe(201);
    expect(await entryLines(rc.body.journalEntryId)).toEqual(
      [`${cashAccountCode} Dr 20.000`, '1103 Cr 20.000 customer'].sort(),
    );

    const after = await api().get(`/api/v1/sales-invoices/${s2InvoiceId}`).set(auth(token));
    expect(m3(after.body.outstanding)).toBe('7.840');

    const st = await wholeStatement(BASE, `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}`, token);
    expect(m3(st.body.closingBalance)).toBe('7.840');
    // The running balance read page by page ends on the same figure (ADR-022 §4).
    expect(m3((st.body.rows as { balance: string }[]).at(-1)!.balance)).toBe('7.840');

    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    const control = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find(
      (r) => r.code === '1103',
    )!;
    expect(m3(new Decimal(control.totalDebit).minus(control.totalCredit))).toBe('7.840');
  });

  it('S11 final reconciliation: TB balanced, inventory = item_costs, stock:verify clean', async () => {
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.body.balanced).toBe(true);
    const inv = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find(
      (r) => r.code === '1104',
    )!;
    const costs = await itemCosts();
    expect(m3(new Decimal(inv.totalDebit).minus(inv.totalCredit))).toBe(costs.value);

    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
  });
});
