/**
 * Golden scenarios P1–P5 — receiving against orders, billing from receipts,
 * issues to departments (ADR-026 §11, ADR-016 §2). NEW golden scenarios: the
 * §18 numbers (golden.e2e.spec.ts) and T1–T6 (golden-tax-inclusive) are
 * untouched. Tax 16%, prices exclusive of tax, procurement level MEDIUM.
 * Hand-computed; do not change the expected numbers to make the test pass.
 *
 * P1  PO 10 X @ 5.000 (net 50.000). GRN 6 → Dr 1104 30.000 / Cr 2104 30.000;
 *     GRN 4 → 20.000 / 20.000. One invoice for both at the order price:
 *     lines 6 × 5.000 = 30.000 and 4 × 5.000 = 20.000, tax 8.000, total 58.000
 *     → Dr 2104 50.000, Dr 1105 8.000, Cr 2101 58.000. 2104 = 0, no variance.
 *     X: 10 @ 50.000.
 * P2  PO 5 X @ 4.000 (net 20.000). GRN 5 → 20.000 (X: 15 @ 70.000). Invoice
 *     5 × 4.200 = 21.000, tax 3.360, total 24.360: above the order, so its
 *     posting is refused (PURCHASE_PRICE_ABOVE_ORDER) until the difference is
 *     approved; then Dr 2104 20.000, Dr 5102 1.000, Dr 1105 3.360,
 *     Cr 2101 24.360. Stock stays at receipt cost: X 15 @ 70.000.
 * P3  PO 3 Y @ 3.333333 (6 dp): gross round3(9.999999) = 10.000. GRN 3 at
 *     round6(10.000 / 3) = 3.333333, value round3(3 × 3.333333) = 10.000.
 *     Three bills of 1 @ 3.333333 (net 3.333, tax round3(0.53328) = 0.533,
 *     total 3.866). Clearing is cumulative (review #50): after k units billed
 *     the line has cleared round3(10.000 × k / 3): 3.333, 6.667, 10.000, so the
 *     bills clear 3.333, 3.334 (6.667 − 3.333) and 3.333 (10.000 − 6.667).
 *     Bill 2's variance 3.333 − 3.334 = −0.001 is credited to 5102; bills 1
 *     and 3 have none. 2104 after each: −6.667, −3.333, 0.000 exactly.
 * P4  Returns of the P2 invoice at the receipt cost (4.000 a unit, not 4.200):
 *     2 X → net 8.400, tax 1.344, total 9.744; out at 8.000 (2/5 of 20.000),
 *     Cr 5102 0.400 (its share of the variance) → X 13 @ 62.000. The last
 *     3 X → net 12.600, tax 2.016, total 14.616; out at the rest
 *     20.000 − 8.000 = 12.000, Cr 5102 0.600 → X 10 @ 50.000, and P2's
 *     variance is back to zero (1.000 − 0.400 − 0.600).
 * P5  GIN of 4 X to a department: Dr 5204 (centre D1) 20.000 / Cr 1104 20.000
 *     at the average round3(4 × 5.000000). X 6 @ 30.000.
 * End: 1104 = Σ item values = 30.000 (X) + 10.000 (Y) = 40.000; 2104 = 0;
 *      5102 = −0.001 (P3 only); TB balanced; stock:verify clean after every step.
 * P6  a tax-inclusive order and P7 a receipt worth less than its units (review #50),
 *     hand-computed in their own comments below, then a second end check.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3714;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `gp-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);

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
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', EINVOICE_WORKER: 'off' },
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

describe('Golden scenarios P1–P5 — receiving, billing from receipts, issues (ADR-026)', () => {
  let token = '';
  let tenantId: bigint;
  let W = '';
  let X = '';
  let Y = '';
  let supplierId = '';
  let centre = '';
  let expenseId = '';
  let p2InvoiceId = '';
  const code: Record<string, string> = {};

  async function ok(res: request.Response, status: number, what: string) {
    if (res.status !== status) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }
  const act = (p: string, body: object = {}) => api().post(`/api/v1/${p}`).set(auth(token)).set(idem()).send(body);

  /** An approved order of one line (owner: may approve their own). */
  async function approvedOrder(itemId: string, qty: string, unitPrice: string) {
    const po = await ok(
      await api().post('/api/v1/purchase-orders').set(auth(token)).send({
        orderDate: '2025-03-01',
        supplierId,
        warehouseId: W,
        lines: [{ itemId, qty, unitPrice }],
      }),
      201,
      'create order',
    );
    await ok(await act(`purchase-orders/${po.id}/submit`), 201, 'submit order');
    return ok(await act(`purchase-orders/${po.id}/approve`), 201, 'approve order');
  }

  /** Receiving is one action (review #50): the GRN is created and posted together. */
  async function receiveAndPost(orderId: string, poLineId: string, qty: string, date: string) {
    const grn = await ok(await act(`purchase-orders/${orderId}/receive`, { noteDate: date, lines: [{ poLineId, qty }] }), 201, 'receive');
    expect(grn.status).toBe('POSTED');
    return grn;
  }

  /** Journal lines as sorted "CODE Dr|Cr amount" strings. */
  async function entryLines(entryId: string) {
    const res = await api().get(`/api/v1/journal-entries/${entryId}`).set(auth(token));
    expect(res.status).toBe(200);
    return (res.body.lines as { account: { code: string }; debit: string; credit: string }[])
      .map((l) => `${l.account.code} ${new Decimal(l.debit).gt(0) ? `Dr ${m3(l.debit)}` : `Cr ${m3(l.credit)}`}`)
      .sort();
  }

  async function itemCost(itemId: string) {
    const [r] = (await db.query('SELECT total_qty AS q, total_value AS v FROM item_costs WHERE tenant_id = ? AND item_id = ?', [
      tenantId,
      itemId,
    ])) as { q: string; v: string }[];
    return { qty: new Decimal(r.q).toString(), value: m3(r.v) };
  }

  /** Balance (Dr − Cr) of an account code from the trial balance. */
  async function balance(accountCode: string) {
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    const row = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find((r) => r.code === accountCode);
    return m3(row ? new Decimal(row.totalDebit).minus(row.totalCredit) : 0);
  }

  /** After every posting step (CLAUDE.md): stock:verify clean and the trial balance balanced. */
  async function verified() {
    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.body.balanced).toBe(true);
  }

  it('setup: company at MEDIUM, items X and Y (16%), supplier, a department centre', async () => {
    const name = `GoldenProc ${RUN}`;
    const reg = await api().post('/api/v1/auth/register').send({ tenantName: name, ownerName: 'Owner', email: `gproc-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    [{ id: tenantId }] = (await db.query('SELECT id FROM tenants WHERE name = ?', [name])) as { id: bigint }[];
    await ok(await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' }), 201, 'fy');
    W = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'W' })).body.id;
    const pcs = ((await api().get('/api/v1/units').set(auth(token))).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const tax16 = ((await api().get('/api/v1/tax-categories').set(auth(token))).body as { id: string; rate: string }[]).find((t) =>
      new Decimal(t.rate).eq(16),
    )!;
    X = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'X', nameAr: 'X', baseUnitId: pcs, taxCategoryId: tax16.id })).body.id;
    Y = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'Y', nameAr: 'Y', baseUnitId: pcs, taxCategoryId: tax16.id })).body.id;
    supplierId = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' })).body.id;
    const rows = (await db.query(
      'SELECT m.mapping_key AS k, a.code FROM account_mappings m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ?',
      [tenantId],
    )) as { k: string; code: string }[];
    for (const r of rows) code[r.k] = r.code;
    const [exp] = (await db.query("SELECT id FROM accounts WHERE tenant_id = ? AND code = '5204'", [tenantId])) as { id: bigint }[];
    expenseId = String(exp.id);
    await ok(await api().patch('/api/v1/company').set(auth(token)).send({ procurementLevel: 'MEDIUM', costCentersEnabled: true }), 200, 'company');
    centre = (await ok(await api().post('/api/v1/cost-centers').set(auth(token)).send({ code: 'D1', nameAr: 'قسم 1' }), 201, 'centre')).id;
    expect(code.GOODS_RECEIVED_NOT_INVOICED).toBe('2104');
    expect(code.INVENTORY_ADJUSTMENT).toBe('5102');
  });

  it('P1 order 10 @ 5.000, receipts 6 + 4, one invoice for both: 2104 = 0, no variance', async () => {
    const po = await approvedOrder(X, '10', '5.000');
    expect(m3(po.netTotal)).toBe('50.000');
    const poLine = po.lines[0].id as string;

    const g1 = await receiveAndPost(po.id, poLine, '6', '2025-03-02');
    expect(m3(g1.lines[0].unitCost)).toBe('5.000');
    expect(await entryLines(g1.journalEntryId)).toEqual([`${code.INVENTORY} Dr 30.000`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 30.000`].sort());
    let order = (await api().get(`/api/v1/purchase-orders/${po.id}`).set(auth(token))).body;
    expect(order.status).toBe('PARTIALLY_RECEIVED');
    expect(new Decimal(order.lines[0].receivedQty).toString()).toBe('6');
    await verified();

    const g2 = await receiveAndPost(po.id, poLine, '4', '2025-03-03');
    expect(await entryLines(g2.journalEntryId)).toEqual([`${code.INVENTORY} Dr 20.000`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 20.000`].sort());
    order = (await api().get(`/api/v1/purchase-orders/${po.id}`).set(auth(token))).body;
    expect(order.status).toBe('RECEIVED');
    expect(await balance('2104')).toBe('-50.000');
    await verified();

    const draft = await ok(
      await act(`purchase-orders/${po.id}/bill`, {
        invoiceDate: '2025-03-04',
        paymentType: 'CREDIT',
        lines: [
          { grnLineId: g1.lines[0].id, qty: '6', unitCost: '5.000' },
          { grnLineId: g2.lines[0].id, qty: '4', unitCost: '5.000' },
        ],
      }),
      201,
      'bill',
    );
    expect([m3(draft.netTotal), m3(draft.taxTotal), m3(draft.grandTotal)]).toEqual(['50.000', '8.000', '58.000']);
    const inv = await ok(await act(`purchase-invoices/${draft.id}/post`), 201, 'post invoice');
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [`${code.GOODS_RECEIVED_NOT_INVOICED} Dr 50.000`, `${code.INPUT_TAX} Dr 8.000`, `${code.SUPPLIERS_CONTROL} Cr 58.000`].sort(),
    );
    expect(inv.lines.map((l: { receipts: { clearedValue: string }[] }) => m3(l.receipts[0].clearedValue))).toEqual(['30.000', '20.000']);
    expect(await balance('2104')).toBe('0.000');
    expect(await itemCost(X)).toEqual({ qty: '10', value: '50.000' });
    // No second stock entry anywhere from order to invoice (§17 acceptance).
    const [{ n }] = (await db.query('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ? AND source_type = ?', [
      tenantId,
      'PURCHASE_INVOICE',
    ])) as { n: bigint }[];
    expect(Number(n)).toBe(0);
    await verified();
  });

  it('P2 invoice above the order price: refused until approved, then the variance goes to 5102', async () => {
    const po = await approvedOrder(X, '5', '4.000');
    const g = await receiveAndPost(po.id, po.lines[0].id, '5', '2025-03-05');
    expect(await entryLines(g.journalEntryId)).toEqual([`${code.INVENTORY} Dr 20.000`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 20.000`].sort());
    expect(await itemCost(X)).toEqual({ qty: '15', value: '70.000' });

    const draft = await ok(
      await act(`purchase-orders/${po.id}/bill`, {
        invoiceDate: '2025-03-06',
        paymentType: 'CREDIT',
        lines: [{ grnLineId: g.lines[0].id, qty: '5', unitCost: '4.200' }],
      }),
      201,
      'bill',
    );
    expect([m3(draft.netTotal), m3(draft.taxTotal), m3(draft.grandTotal)]).toEqual(['21.000', '3.360', '24.360']);
    const refused = await act(`purchase-invoices/${draft.id}/post`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PURCHASE_PRICE_ABOVE_ORDER');
    expect(refused.body.error.details.lines).toEqual([
      { lineNo: 1, grnLineId: g.lines[0].id, invoiceNetUnitPrice: '4.200000', orderNetUnitPrice: '4.000000' },
    ]);

    const approved = await ok(await act(`purchase-invoices/${draft.id}/approve-price`), 201, 'approve price');
    expect(approved.priceApprovedAt).not.toBeNull();
    const inv = await ok(await act(`purchase-invoices/${draft.id}/post`), 201, 'post invoice');
    p2InvoiceId = inv.id;
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [
        `${code.GOODS_RECEIVED_NOT_INVOICED} Dr 20.000`,
        `${code.INVENTORY_ADJUSTMENT} Dr 1.000`,
        `${code.INPUT_TAX} Dr 3.360`,
        `${code.SUPPLIERS_CONTROL} Cr 24.360`,
      ].sort(),
    );
    expect(await balance('2104')).toBe('0.000');
    expect(await balance('5102')).toBe('1.000');
    // Stock keeps the receipt cost (ADR-026 §1).
    expect(await itemCost(X)).toEqual({ qty: '15', value: '70.000' });
    await verified();
  });

  it('P3 partial billing at a 6 dp price: the last bill takes the remainder, 2104 exactly 0', async () => {
    const po = await approvedOrder(Y, '3', '3.333333');
    expect([m3(po.netTotal), m3(po.taxTotal), m3(po.grandTotal)]).toEqual(['10.000', '1.600', '11.600']);
    const g = await receiveAndPost(po.id, po.lines[0].id, '3', '2025-03-07');
    expect(new Decimal(g.lines[0].unitCost).toFixed(6)).toBe('3.333333');
    expect(await entryLines(g.journalEntryId)).toEqual([`${code.INVENTORY} Dr 10.000`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 10.000`].sort());

    // Cumulative clearing (review #50): 3.333, 6.667 − 3.333 = 3.334, 10.000 − 6.667 = 3.333.
    const expected = [
      { cleared: '3.333', pending: '-6.667', lines: [`${code.GOODS_RECEIVED_NOT_INVOICED} Dr 3.333`, `${code.INPUT_TAX} Dr 0.533`, `${code.SUPPLIERS_CONTROL} Cr 3.866`] },
      {
        cleared: '3.334',
        pending: '-3.333',
        lines: [
          `${code.GOODS_RECEIVED_NOT_INVOICED} Dr 3.334`,
          `${code.INPUT_TAX} Dr 0.533`,
          `${code.INVENTORY_ADJUSTMENT} Cr 0.001`,
          `${code.SUPPLIERS_CONTROL} Cr 3.866`,
        ],
      },
      { cleared: '3.333', pending: '0.000', lines: [`${code.GOODS_RECEIVED_NOT_INVOICED} Dr 3.333`, `${code.INPUT_TAX} Dr 0.533`, `${code.SUPPLIERS_CONTROL} Cr 3.866`] },
    ];
    for (const [i, e] of expected.entries()) {
      const draft = await ok(
        await act(`purchase-orders/${po.id}/bill`, {
          invoiceDate: `2025-03-${String(8 + i).padStart(2, '0')}`,
          paymentType: 'CREDIT',
          lines: [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '3.333333' }],
        }),
        201,
        `bill ${i + 1}`,
      );
      expect([m3(draft.netTotal), m3(draft.taxTotal), m3(draft.grandTotal)]).toEqual(['3.333', '0.533', '3.866']);
      const inv = await ok(await act(`purchase-invoices/${draft.id}/post`), 201, `post bill ${i + 1}`);
      expect(m3(inv.lines[0].receipts[0].clearedValue)).toBe(e.cleared);
      expect(await entryLines(inv.journalEntryId)).toEqual(e.lines.sort());
      // The rest stays pending in 2104 until it is billed (§17 acceptance).
      expect(await balance('2104')).toBe(e.pending);
      await verified();
    }
    const [line] = (await db.query('SELECT billed_qty, cleared_value FROM goods_note_lines WHERE tenant_id = ? AND id = ?', [
      tenantId,
      g.lines[0].id,
    ])) as { billed_qty: string; cleared_value: string }[];
    expect([new Decimal(line.billed_qty).toString(), m3(line.cleared_value)]).toEqual(['3', '10.000']);
    // A fourth bill has nothing left to bill.
    const over = await act(`purchase-orders/${po.id}/bill`, {
      invoiceDate: '2025-03-11',
      paymentType: 'CREDIT',
      lines: [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '3.333333' }],
    });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('PURCHASE_BILL_EXCEEDS_RECEIPT');
    expect(await itemCost(Y)).toEqual({ qty: '3', value: '10.000' });
    expect(await balance('5102')).toBe('0.999');
  });

  it('P4 returns of a PO-billed invoice leave at the receipt cost and reverse the variance', async () => {
    const original = (await api().get(`/api/v1/purchase-invoices/${p2InvoiceId}`).set(auth(token))).body;
    const lineId = original.lines[0].id as string;
    const ret = async (qty: string, date: string) => {
      const draft = await ok(
        await api().post('/api/v1/purchase-returns').set(auth(token)).send({
          returnDate: date,
          originalInvoiceId: p2InvoiceId,
          refundType: 'CREDIT',
          reason: 'r',
          lines: [{ originalLineId: lineId, qty }],
        }),
        201,
        'create return',
      );
      return ok(await act(`purchase-returns/${draft.id}/post`), 201, 'post return');
    };

    const r1 = await ret('2', '2025-03-12');
    expect([m3(r1.netTotal), m3(r1.taxTotal), m3(r1.grandTotal)]).toEqual(['8.400', '1.344', '9.744']);
    expect(await entryLines(r1.journalEntryId)).toEqual(
      [
        `${code.SUPPLIERS_CONTROL} Dr 9.744`,
        `${code.INVENTORY} Cr 8.000`,
        `${code.INVENTORY_ADJUSTMENT} Cr 0.400`,
        `${code.INPUT_TAX} Cr 1.344`,
      ].sort(),
    );
    expect(await itemCost(X)).toEqual({ qty: '13', value: '62.000' });
    await verified();

    const r2 = await ret('3', '2025-03-13');
    expect([m3(r2.netTotal), m3(r2.taxTotal), m3(r2.grandTotal)]).toEqual(['12.600', '2.016', '14.616']);
    expect(await entryLines(r2.journalEntryId)).toEqual(
      [
        `${code.SUPPLIERS_CONTROL} Dr 14.616`,
        `${code.INVENTORY} Cr 12.000`,
        `${code.INVENTORY_ADJUSTMENT} Cr 0.600`,
        `${code.INPUT_TAX} Cr 2.016`,
      ].sort(),
    );
    expect(await itemCost(X)).toEqual({ qty: '10', value: '50.000' });
    // P2's variance (+1.000) is back to zero; only P3's −0.001 is left.
    expect(await balance('5102')).toBe('-0.001');
    await verified();
  });

  it('P5 issue to a department expense account with a cost centre, at average cost', async () => {
    const draft = await ok(
      await api().post('/api/v1/goods-notes').set(auth(token)).send({
        noteDate: '2025-03-14',
        warehouseId: W,
        noteType: 'GIN',
        expenseAccountId: expenseId,
        costCenterId: centre,
        lines: [{ itemId: X, qty: '4' }],
      }),
      201,
      'create GIN',
    );
    const gin = await ok(await act(`goods-notes/${draft.id}/post`), 201, 'post GIN');
    expect(await entryLines(gin.journalEntryId)).toEqual(['5204 Dr 20.000', `${code.INVENTORY} Cr 20.000`].sort());
    const rows = (await db.query(
      'SELECT a.code, l.cost_center_id AS c FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.tenant_id = ? AND l.journal_entry_id = ?',
      [tenantId, gin.journalEntryId],
    )) as { code: string; c: bigint | null }[];
    expect(rows.find((r) => r.code === '5204')?.c?.toString()).toBe(centre);
    expect(rows.find((r) => r.code === code.INVENTORY)?.c ?? null).toBeNull();
    expect(await itemCost(X)).toEqual({ qty: '6', value: '30.000' });
    await verified();
  });

  it('end: 1104 = item values 40.000, 2104 = 0, TB balanced, stock:verify clean', async () => {
    expect(await balance(code.INVENTORY)).toBe('40.000');
    expect(await balance('2104')).toBe('0.000');
    expect(await balance('5102')).toBe('-0.001');
    await verified();
  });

  /** A new 16% item. */
  async function newItem(itemCode: string) {
    const pcs = ((await api().get('/api/v1/units').set(auth(token))).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const tax16 = ((await api().get('/api/v1/tax-categories').set(auth(token))).body as { id: string; rate: string }[]).find((t) =>
      new Decimal(t.rate).eq(16),
    )!;
    return (await api().post('/api/v1/items').set(auth(token)).send({ code: itemCode, nameAr: itemCode, baseUnitId: pcs, taxCategoryId: tax16.id })).body
      .id as string;
  }

  /**
   * P6 (review #50) — a tax-inclusive order (ADR-017), billed on the same basis:
   * PO 10 Z @ 11.600 incl. 16% → net round3(116.000 / 1.16) = 100.000, tax 16.000,
   * total 116.000. GRN 10 at round6(100.000 / 10) = 10.000000 → Dr 1104 100.000 /
   * Cr 2104 100.000. The billable view suggests 11.600 (the order price, same basis)
   * and compares on 11.600 / 1.16 = 10.000000 = the order's: no approval. Invoice
   * 10 × 11.600 incl. → net 100.000, tax 16.000, total 116.000 → Dr 2104 100.000,
   * Dr 1105 16.000, Cr 2101 116.000; no variance. Z 10 @ 100.000.
   */
  it('P6 a tax-inclusive order: received net of tax, billed at its price, 2104 = 0, no variance', async () => {
    const Z = await newItem('Z');
    await ok(await api().patch('/api/v1/company').set(auth(token)).send({ pricesIncludeTax: true }), 200, 'inclusive on');
    const po = await approvedOrder(Z, '10', '11.600');
    expect([m3(po.netTotal), m3(po.taxTotal), m3(po.grandTotal)]).toEqual(['100.000', '16.000', '116.000']);
    const g = await receiveAndPost(po.id, po.lines[0].id, '10', '2025-03-15');
    expect(new Decimal(g.lines[0].unitCost).toFixed(6)).toBe('10.000000');
    expect(await entryLines(g.journalEntryId)).toEqual([`${code.INVENTORY} Dr 100.000`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 100.000`].sort());
    const billable = (await api().get(`/api/v1/purchase-orders/${po.id}/billable`).set(auth(token))).body;
    expect([m3(billable.lines[0].defaultUnitCost), new Decimal(billable.lines[0].orderNetUnitPrice).toFixed(6)]).toEqual(['11.600', '10.000000']);
    const draft = await ok(
      await act(`purchase-orders/${po.id}/bill`, {
        invoiceDate: '2025-03-16',
        paymentType: 'CREDIT',
        lines: [{ grnLineId: g.lines[0].id, qty: '10', unitCost: '11.600' }],
      }),
      201,
      'bill',
    );
    expect(draft.pricesIncludeTax).toBe(true);
    expect([m3(draft.netTotal), m3(draft.taxTotal), m3(draft.grandTotal)]).toEqual(['100.000', '16.000', '116.000']);
    expect(draft.priceAboveOrderLines).toEqual([]);
    const inv = await ok(await act(`purchase-invoices/${draft.id}/post`), 201, 'post invoice');
    expect(await entryLines(inv.journalEntryId)).toEqual(
      [`${code.GOODS_RECEIVED_NOT_INVOICED} Dr 100.000`, `${code.INPUT_TAX} Dr 16.000`, `${code.SUPPLIERS_CONTROL} Cr 116.000`].sort(),
    );
    expect(await itemCost(Z)).toEqual({ qty: '10', value: '100.000' });
    expect(await balance('2104')).toBe('0.000');
    await ok(await api().patch('/api/v1/company').set(auth(token)).send({ pricesIncludeTax: false }), 200, 'inclusive off');
    await verified();
  });

  /**
   * P7 (review #50) — a value smaller than its units: PO 6 T @ 0.0015 → net
   * round3(0.009) = 0.009, tax round3(0.00144) = 0.001, total 0.010. GRN 6 at
   * round6(0.009 / 6) = 0.001500, value round3(6 × 0.0015) = 0.009 → Dr 1104 0.009 /
   * Cr 2104 0.009. Six bills of 1 @ 0.0015: net round3(0.0015) = 0.002, tax
   * round3(0.00032) = 0.000, total 0.002. Cumulative clearing round3(0.009 × k / 6)
   * = 0.002, 0.003, 0.005, 0.006, 0.008, 0.009, so the bills clear 0.002, 0.001,
   * 0.002, 0.001, 0.002, 0.001 (a per-bill round3 would clear 0.002 five times and
   * overshoot the 0.009). Variance (net − cleared): 0, +0.001, 0, +0.001, 0, +0.001,
   * debited to 5102. 2104 after each: −0.007, −0.006, −0.004, −0.003, −0.001, 0.000.
   */
  it('P7 six bills of a 0.009 receipt: no bill clears more than is left, 2104 exactly 0', async () => {
    const Tt = await newItem('T');
    const po = await approvedOrder(Tt, '6', '0.0015');
    expect([m3(po.netTotal), m3(po.taxTotal), m3(po.grandTotal)]).toEqual(['0.009', '0.001', '0.010']);
    const g = await receiveAndPost(po.id, po.lines[0].id, '6', '2025-03-17');
    expect(new Decimal(g.lines[0].unitCost).toFixed(6)).toBe('0.001500');
    expect(await entryLines(g.journalEntryId)).toEqual([`${code.INVENTORY} Dr 0.009`, `${code.GOODS_RECEIVED_NOT_INVOICED} Cr 0.009`].sort());
    const cleared = ['0.002', '0.001', '0.002', '0.001', '0.002', '0.001'];
    const pending = ['-0.007', '-0.006', '-0.004', '-0.003', '-0.001', '0.000'];
    for (const [i, c] of cleared.entries()) {
      const draft = await ok(
        await act(`purchase-orders/${po.id}/bill`, {
          invoiceDate: '2025-03-18',
          paymentType: 'CREDIT',
          lines: [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '0.0015' }],
        }),
        201,
        `bill ${i + 1}`,
      );
      expect([m3(draft.netTotal), m3(draft.taxTotal), m3(draft.grandTotal)]).toEqual(['0.002', '0.000', '0.002']);
      const inv = await ok(await act(`purchase-invoices/${draft.id}/post`), 201, `post bill ${i + 1}`);
      expect(m3(inv.lines[0].receipts[0].clearedValue)).toBe(c);
      const variance = c === '0.001' ? [`${code.INVENTORY_ADJUSTMENT} Dr 0.001`] : [];
      expect(await entryLines(inv.journalEntryId)).toEqual(
        [`${code.GOODS_RECEIVED_NOT_INVOICED} Dr ${c}`, ...variance, `${code.SUPPLIERS_CONTROL} Cr 0.002`].sort(),
      );
      expect(await balance('2104')).toBe(pending[i]);
      await verified();
    }
    // The projection equals the posted clearing (the integrity check's rule).
    const [l] = (await db.query(
      `SELECT x.billed_qty, x.cleared_value,
              (SELECT SUM(r.cleared_value) FROM purchase_invoice_receipts r WHERE r.tenant_id = x.tenant_id AND r.grn_line_id = x.id) AS links
         FROM goods_note_lines x WHERE x.tenant_id = ? AND x.id = ?`,
      [tenantId, g.lines[0].id],
    )) as { billed_qty: string; cleared_value: string; links: string }[];
    expect([new Decimal(l.billed_qty).toString(), m3(l.cleared_value), m3(l.links)]).toEqual(['6', '0.009', '0.009']);
    expect(await itemCost(Tt)).toEqual({ qty: '6', value: '0.009' });
  });

  it('end after P6 and P7: 1104 = 40.000 + 100.000 + 0.009 = 140.009, 2104 = 0, 5102 = −0.001 + 0.003 = 0.002', async () => {
    expect(await balance(code.INVENTORY)).toBe('140.009');
    expect(await balance('2104')).toBe('0.000');
    expect(await balance('5102')).toBe('0.002');
    await verified();
  });
});
