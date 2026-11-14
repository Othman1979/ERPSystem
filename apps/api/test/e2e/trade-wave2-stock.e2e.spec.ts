/**
 * Trade review fixes, stock and documents (docs/reviews 2026-11-13,
 * review-trade.md + review-database.md; decisions.md; ADR-016, ADR-018):
 *  - TRADE-02  a purchase invoice billing a posted GRN clears 2104, moves no stock,
 *              books the price difference to INVENTORY_ADJUSTMENT, and bills it once;
 *  - TRADE-03  a purchase return leaves at the original line cost;
 *  - DB-04/05  transfer and adjustment reversals mirror the original costs;
 *  - TRADE-19  a reversal cannot be reversed;
 *  - TRADE-09  unit costs keep 6 decimals;
 *  - TRADE-01  two return drafts at once cannot exceed the invoice line;
 *  - TRADE-12  a CREDIT return only against a CREDIT invoice; it may exceed what is owed;
 *  - TRADE-13  a return line stores the quantity in the invoice line's unit;
 *  - TRADE-22  returns that take a line in parts add up to it exactly;
 *  - TRADE-07  a stale count is refused; approval is atomic and keyed;
 *  - DB-19     negative stock: the value resets at the incoming cost (ADR-018);
 *  - TRADE-20  stock:verify finds a value difference and a GL difference.
 * Every scenario ends with stock:verify clean (quantities, value and the GL
 * inventory account) and a balanced trial balance. Tenant B sees none of A.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { webPayloads } from './support/web-payloads.js';

const API_PORT = 3621;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const key = () => `t2-${RUN}-${Math.random().toString(36).slice(2)}`;
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

describe('Trade review fixes — stock and documents', () => {
  let token = '';
  let tokenB = '';
  let tenantId: bigint;
  let companyId: bigint;
  let W1 = '';
  let W2 = '';
  let pcs = '';
  let box = '';
  let customerId = '';
  let supplierId = '';
  let cashAccountId = '';

  async function register(label: string) {
    const name = `T2${label} ${RUN}`;
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: name, ownerName: 'Owner', email: `t2${label.toLowerCase()}-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [name],
    )) as { tenantId: bigint; companyId: bigint }[];
    return { token: reg.body.accessToken as string, tenantId: t.tenantId, companyId: t.companyId };
  }

  async function create(kind: string, body: object) {
    const res = await api().post(`/api/v1/${kind}`).set(auth(token)).send(body);
    if (res.status !== 201) throw new Error(`create ${kind} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; lines?: { id: string; qty: string; unitPrice?: string; netAmount: string; taxAmount: string }[] };
  }
  async function post(kind: string, id: string) {
    return api().post(`/api/v1/${kind}/${id}/post`).set(auth(token)).set('Idempotency-Key', key());
  }
  async function createAndPost(kind: string, body: object) {
    const doc = await create(kind, body);
    const res = await post(kind, doc.id);
    if (res.status !== 201) throw new Error(`post ${kind} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; lines: { id: string }[]; journalEntryId?: string };
  }
  async function item(code: string, extra: object = {}) {
    const res = await api().post('/api/v1/items').set(auth(token)).send({ code, nameAr: code, baseUnitId: pcs, ...extra });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  async function cost(itemId: string) {
    const [r] = (await db.query('SELECT total_qty AS q, total_value AS v, avg_cost AS a FROM item_costs WHERE tenant_id = ? AND item_id = ?', [
      tenantId,
      itemId,
    ])) as { q: string; v: string; a: string }[];
    return { qty: new Decimal(r.q).toString(), value: m3(r.v), avg: new Decimal(r.a).toString() };
  }
  async function onHand(itemId: string, warehouseId: string) {
    const [r] = (await db.query('SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?', [
      tenantId,
      itemId,
      warehouseId,
    ])) as { q: string }[];
    return new Decimal(r?.q ?? 0).toString();
  }
  /** Net debit − credit of an account by code, from the trial balance. */
  async function balance(code: string) {
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    const row = (tb.body.rows as { code: string; totalDebit: string; totalCredit: string }[]).find((r) => r.code === code);
    return m3(row ? new Decimal(row.totalDebit).minus(row.totalCredit) : 0);
  }
  async function mappedCode(mappingKey: string) {
    const [r] = (await db.query(
      'SELECT a.code FROM account_mappings m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? AND m.mapping_key = ?',
      [tenantId, mappingKey],
    )) as { code: string }[];
    return r.code;
  }
  /** stock:verify clean (quantities, value, GL) and the trial balance balanced. */
  async function assertConsistent() {
    const verify = await api().get('/api/v1/stock/verify').set(auth(token));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    expect(verify.body.inventoryAccountBalance).toBe(verify.body.stockValue);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.body.balanced).toBe(true);
  }
  const buy = (itemId: string, qty: string, unitCost: string, date: string, warehouseId = W1) =>
    createAndPost('purchase-invoices', {
      invoiceDate: date,
      supplierId,
      warehouseId,
      paymentType: 'CREDIT',
      lines: [{ itemId, qty, unitCost }],
    });

  it('setup: tenants A and B, two warehouses, parties, cash account', async () => {
    ({ token, tenantId, companyId } = await register('A'));
    ({ token: tokenB } = await register('B'));
    const fy = await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    W1 = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W1', nameAr: 'W1' })).body.id;
    // The trial plan allows one warehouse: add W2 directly, as the golden suite does.
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, companyId, 'W2', 'W2', now, now],
    )) as { insertId: bigint };
    W2 = String(ins.insertId);
    const units = (await api().get('/api/v1/units').set(auth(token))).body as { id: string; code: string }[];
    pcs = units.find((u) => u.code === 'PCS')!.id;
    box = units.find((u) => u.code === 'BOX')!.id;
    customerId = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })).body.id;
    supplierId = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' })).body.id;
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

  it('TRADE-02: an invoice billing a GRN clears 2104, moves no stock, and bills the GRN once', async () => {
    const G = await item('G');
    const grn = await createAndPost('goods-notes', {
      noteDate: '2025-01-05',
      noteType: 'GRN',
      warehouseId: W1,
      lines: [{ itemId: G, qty: '50', unitCost: '4' }],
    });
    expect(await balance('2104')).toBe('-200.000');

    // More than received: refused.
    const over = await api().post('/api/v1/purchase-invoices').set(auth(token)).send({
      invoiceDate: '2025-01-06', supplierId, warehouseId: W1, paymentType: 'CREDIT', receivedGrnId: grn.id,
      lines: [{ itemId: G, qty: '51', unitCost: '4.2' }],
    });
    expect(over.status).toBe(400);

    const inv = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-06', supplierId, warehouseId: W1, paymentType: 'CREDIT', receivedGrnId: grn.id,
      lines: [{ itemId: G, qty: '50', unitCost: '4.2' }],
    });
    expect(await onHand(G, W1)).toBe('50'); // not 100
    expect(await cost(G)).toMatchObject({ qty: '50', value: '200.000' });
    expect(await balance('2104')).toBe('0.000');
    expect(await balance(await mappedCode('INVENTORY_ADJUSTMENT'))).toBe('10.000'); // 50 × (4.2 − 4)
    const je = await api().get(`/api/v1/journal-entries/${inv.journalEntryId}`).set(auth(token));
    expect(je.status).toBe(200);

    // A second invoice for the same GRN: refused at draft and at posting.
    const again = await api().post('/api/v1/purchase-invoices').set(auth(token)).send({
      invoiceDate: '2025-01-07', supplierId, warehouseId: W1, paymentType: 'CREDIT', receivedGrnId: grn.id,
      lines: [{ itemId: G, qty: '1', unitCost: '4' }],
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('GRN_ALREADY_INVOICED');
    // Tenant B cannot bill A's GRN.
    const supplierB = (await api().post('/api/v1/parties').set(auth(tokenB)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' })).body.id;
    const unitsB = (await api().get('/api/v1/units').set(auth(tokenB))).body as { id: string; code: string }[];
    const serviceB = await api().post('/api/v1/items').set(auth(tokenB)).send({
      code: 'SV', nameAr: 'SV', baseUnitId: unitsB.find((u) => u.code === 'PCS')!.id, itemKind: 'SERVICE',
    });
    expect(serviceB.status).toBe(201);
    const cross = await api().post('/api/v1/purchase-invoices').set(auth(tokenB)).send({
      invoiceDate: '2025-01-07', supplierId: supplierB, paymentType: 'CREDIT', receivedGrnId: grn.id,
      lines: [{ itemId: serviceB.body.id, qty: '1', unitCost: '1' }],
    });
    expect(cross.status).toBe(404);
    await assertConsistent();
  });

  it('TRADE-02 races: saving and posting a GRN-linked draft at once; drafts for two GRNs at once', async () => {
    const R = await item('GR');
    const grn = async () =>
      createAndPost('goods-notes', { noteDate: '2025-01-07', noteType: 'GRN', warehouseId: W1, lines: [{ itemId: R, qty: '10', unitCost: '4' }] });
    const body = (grnId: string, description: string) => ({
      invoiceDate: '2025-01-07', supplierId, warehouseId: W1, paymentType: 'CREDIT', receivedGrnId: grnId, description,
      lines: [{ itemId: R, qty: '10', unitCost: '4.5' }],
    });
    for (let i = 0; i < 3; i += 1) {
      // Save (PUT) and post of the same draft on separate connections: they
      // queue on the invoice row in one order, so no deadlock, no 500, and a
      // posted invoice is never rewritten.
      const g = await grn();
      const draft = await create('purchase-invoices', body(g.id, 'draft'));
      const [put, posted] = await Promise.all([
        api().put(`/api/v1/purchase-invoices/${draft.id}`).set(auth(token)).send(body(g.id, 'saved')),
        post('purchase-invoices', draft.id),
      ]);
      expect([200, 409]).toContain(put.status);
      expect(posted.status).toBe(201);
      const after = await api().get(`/api/v1/purchase-invoices/${draft.id}`).set(auth(token));
      expect(after.body.status).toBe('POSTED');
      expect(after.body.lines).toHaveLength(1);
      if (put.status === 409) expect(after.body.description).toBe('draft');

      // Two drafts billing two different GRNs, saved at once: no gap-lock deadlock.
      const [g1, g2] = [await grn(), await grn()];
      const both = await Promise.all([
        api().post('/api/v1/purchase-invoices').set(auth(token)).send(body(g1.id, 'a')),
        api().post('/api/v1/purchase-invoices').set(auth(token)).send(body(g2.id, 'b')),
      ]);
      expect(both.map((r) => r.status)).toEqual([201, 201]);
    }
    await assertConsistent();
  });

  it('TRADE-02/03: a return of a GRN-billed invoice leaves at the received cost and reverses the price difference', async () => {
    // Hand-computed (ADR-016 §2–3):
    //  GRN 10 @ 5            → item 10 / 50.000, 2104 Cr 50
    //  invoice bills it @ 6  → 2104 cleared, INVENTORY_ADJUSTMENT Dr 10.000
    //  purchase 10 @ 5       → item 20 / 100.000
    //  return the 10 billed  → OUT at 5 = 50.000 (not 60): item 10 / 50.000, avg 5;
    //                          INVENTORY_ADJUSTMENT Cr 10.000 (back to where it was)
    const RG = await item('RG');
    const adjCode = await mappedCode('INVENTORY_ADJUSTMENT');
    const adjStart = new Decimal(await balance(adjCode));
    const grniStart = new Decimal(await balance('2104'));
    const g = await createAndPost('goods-notes', {
      noteDate: '2025-01-08', noteType: 'GRN', warehouseId: W1, lines: [{ itemId: RG, qty: '10', unitCost: '5' }],
    });
    const billed = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-08', supplierId, warehouseId: W1, paymentType: 'CREDIT', receivedGrnId: g.id,
      lines: [{ itemId: RG, qty: '10', unitCost: '6' }],
    });
    expect(m3(new Decimal(await balance(adjCode)).minus(adjStart))).toBe('10.000');
    await buy(RG, '10', '5', '2025-01-08');
    expect(await cost(RG)).toMatchObject({ qty: '20', value: '100.000' });
    const inv = await api().get(`/api/v1/purchase-invoices/${billed.id}`).set(auth(token));
    await createAndPost('purchase-returns', {
      returnDate: '2025-01-09', originalInvoiceId: billed.id, warehouseId: W1, refundType: 'CREDIT',
      lines: [{ originalLineId: inv.body.lines[0].id, qty: '10' }],
    });
    expect(await cost(RG)).toMatchObject({ qty: '10', value: '50.000', avg: '5' });
    expect(m3(new Decimal(await balance(adjCode)).minus(adjStart))).toBe('0.000');
    expect(m3(new Decimal(await balance('2104')).minus(grniStart))).toBe('0.000');
    await assertConsistent();
  });

  it('TRADE-03: a purchase return leaves at the original line cost, stock = GL', async () => {
    const P = await item('P');
    const first = await buy(P, '10', '5', '2025-01-08');
    await buy(P, '10', '15', '2025-01-08');
    expect(await cost(P)).toMatchObject({ qty: '20', value: '200.000' });
    const firstInv = await api().get(`/api/v1/purchase-invoices/${first.id}`).set(auth(token));
    await createAndPost('purchase-returns', {
      returnDate: '2025-01-09', originalInvoiceId: first.id, warehouseId: W1, refundType: 'CREDIT',
      lines: [{ originalLineId: firstInv.body.lines[0].id, qty: '5' }],
    });
    expect(await cost(P)).toMatchObject({ qty: '15', value: '175.000' }); // 200 − 5 × 5, not − 5 × 10
    await assertConsistent();
  });

  it("ADR-016 §5: a purchase return leaves from the original invoice's warehouse only", async () => {
    const web = await webPayloads();
    const Q = await item('Q');
    // Q is in both warehouses, so only the rule (not a stock shortage) can refuse W2.
    await buy(Q, '5', '2', '2025-01-08', W2);
    const inv = await buy(Q, '10', '3', '2025-01-08', W1);
    const invoice = (await api().get(`/api/v1/purchase-invoices/${inv.id}`).set(auth(token))).body as {
      id: string;
      warehouseId: string | null;
      lines: { id: string }[];
    };
    const line = invoice.lines[0].id;
    // The return form's own body (apps/web/src/pages/purchases/returnPayload.ts).
    const formBody = (qty: string) =>
      web.purchaseReturnBody(invoice, { returnDate: '2025-01-09', refundType: 'CREDIT', qtyByLine: { [line]: qty } });
    const returnsOf = async () =>
      ((await db.query('SELECT COUNT(*) AS n FROM purchase_returns WHERE tenant_id = ? AND original_invoice_id = ?', [tenantId, inv.id])) as { n: bigint }[])[0].n;
    expect(formBody('2').warehouseId).toBe(W1);

    // Another warehouse of the company (a client other than the form): refused, nothing saved.
    const other = await api().post('/api/v1/purchase-returns').set(auth(token)).send({ ...formBody('2'), warehouseId: W2 });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('RETURN_WAREHOUSE_MISMATCH');
    expect(other.body.error.details).toEqual({ warehouseId: W2, invoiceWarehouseId: W1 });
    expect(await returnsOf()).toBe(0n);

    // A draft that names another warehouse (saved before the rule) is refused at posting, and moves nothing.
    const draft = await create('purchase-returns', formBody('2'));
    await db.query('UPDATE purchase_returns SET warehouse_id = ? WHERE tenant_id = ? AND id = ?', [W2, tenantId, draft.id]);
    const posted = await post('purchase-returns', draft.id);
    expect(posted.status).toBe(400);
    expect(posted.body.error.code).toBe('RETURN_WAREHOUSE_MISMATCH');
    expect(await onHand(Q, W2)).toBe('5');
    await db.query('UPDATE purchase_returns SET warehouse_id = ? WHERE tenant_id = ? AND id = ?', [W1, tenantId, draft.id]);
    expect((await post('purchase-returns', draft.id)).status).toBe(201);
    expect(await onHand(Q, W1)).toBe('8');

    // No warehouse in the body: the invoice's is taken.
    const { warehouseId: _omit, ...withoutWarehouse } = formBody('1');
    const defaulted = await create('purchase-returns', withoutWarehouse);
    const [{ wh }] = (await db.query('SELECT warehouse_id AS wh FROM purchase_returns WHERE tenant_id = ? AND id = ?', [tenantId, defaulted.id])) as { wh: bigint }[];
    expect(String(wh)).toBe(W1);

    // A services-only invoice has no warehouse: the form sends none, and the API says why it cannot record the return.
    const svc = await item('SVC', { itemKind: 'SERVICE' });
    const svcInv = await createAndPost('purchase-invoices', {
      invoiceDate: '2025-01-08', supplierId, paymentType: 'CREDIT', lines: [{ itemId: svc, qty: '1', unitCost: '10' }],
    });
    const svcInvoice = (await api().get(`/api/v1/purchase-invoices/${svcInv.id}`).set(auth(token))).body as typeof invoice;
    expect(svcInvoice.warehouseId).toBeNull();
    const svcBody = web.purchaseReturnBody(svcInvoice, { returnDate: '2025-01-09', refundType: 'CREDIT', qtyByLine: { [svcInvoice.lines[0].id]: '1' } });
    const required = await api().post('/api/v1/purchase-returns').set(auth(token)).send(svcBody);
    expect(required.status).toBe(400);
    expect(required.body.error.code).toBe('RETURN_WAREHOUSE_REQUIRED');

    // Tenant B: A's invoice is not found, with B's own warehouse or with A's.
    const WB = (await api().post('/api/v1/warehouses').set(auth(tokenB)).send({ code: 'WB', nameAr: 'WB' })).body.id as string;
    const withOwn = await api().post('/api/v1/purchase-returns').set(auth(tokenB)).send({ ...formBody('1'), warehouseId: WB });
    expect(withOwn.status).toBe(404);
    const withA = await api().post('/api/v1/purchase-returns').set(auth(tokenB)).send(formBody('1'));
    expect(withA.status).toBe(404);
    expect(await returnsOf()).toBe(2n);
    await assertConsistent();
  });

  it('DB-04 / TRADE-19: a transfer reversal mirrors the original cost; a reversal cannot be reversed', async () => {
    const T = await item('T');
    await buy(T, '10', '7', '2025-01-10');
    const tr = await createAndPost('stock-transfers', {
      transferDate: '2025-01-10', fromWarehouseId: W1, toWarehouseId: W2, lines: [{ itemId: T, qty: '4' }],
    });
    await buy(T, '5', '9', '2025-01-11');
    const before = await cost(T);
    const rev = await api().post(`/api/v1/stock-transfers/${tr.id}/reverse`).set(auth(token)).set('Idempotency-Key', key()).send({ reversalDate: '2025-01-12' });
    expect(rev.status).toBe(201);
    expect(await cost(T)).toEqual(before); // value 115, unchanged by the transfer and its reversal
    expect(await onHand(T, W1)).toBe('15');
    expect(await onHand(T, W2)).toBe('0');
    const again = await api().post(`/api/v1/stock-transfers/${rev.body.id}/reverse`).set(auth(token)).set('Idempotency-Key', key()).send({ reversalDate: '2025-01-12' });
    expect(again.status).toBe(409);
    await assertConsistent();
  });

  it('DB-05 / TRADE-19: reversing an opening adjustment after a dearer purchase takes out the opening cost', async () => {
    const O = await item('O');
    const opening = await createAndPost('stock-adjustments', {
      adjustmentDate: '2025-01-13', adjustmentType: 'OPENING', warehouseId: W1, lines: [{ itemId: O, qty: '10', unitCost: '1' }],
    });
    await buy(O, '10', '3', '2025-01-13');
    const equity = await mappedCode('OPENING_BALANCE_EQUITY');
    const equityBefore = new Decimal(await balance(equity));
    const rev = await api().post(`/api/v1/stock-adjustments/${opening.id}/reverse`).set(auth(token)).set('Idempotency-Key', key()).send({ reversalDate: '2025-01-14' });
    expect(rev.status).toBe(201);
    expect(await cost(O)).toMatchObject({ qty: '10', value: '30.000', avg: '3' });
    // The opening's 10 credit to equity is reversed exactly: nothing stays behind.
    expect(m3(new Decimal(await balance(equity)).minus(equityBefore))).toBe('10.000');
    const again = await api().post(`/api/v1/stock-adjustments/${rev.body.id}/reverse`).set(auth(token)).set('Idempotency-Key', key()).send({ reversalDate: '2025-01-14' });
    expect(again.status).toBe(409);
    await assertConsistent();
  });

  it('TRADE-09: unit cost keeps 6 decimals', async () => {
    const U = await item('U');
    const adj = await createAndPost('stock-adjustments', {
      adjustmentDate: '2025-01-15', adjustmentType: 'IN', warehouseId: W1, lines: [{ itemId: U, qty: '12', unitCost: '0.833333' }],
    });
    const [m] = (await db.query(
      "SELECT unit_cost AS u, total_cost AS t FROM stock_movements WHERE tenant_id = ? AND source_type = 'STOCK_ADJUSTMENT' AND source_id = ?",
      [tenantId, adj.id],
    )) as { u: string; t: string }[];
    expect([new Decimal(m.u).toString(), m3(m.t)]).toEqual(['0.833333', '10.000']);
    await assertConsistent();
  });

  describe('returns', () => {
    let S = '';
    let invoiceId = '';
    let lineId = '';

    it('setup: 100 of S, a credit sale of 30', async () => {
      S = await item('S');
      await buy(S, '100', '2', '2025-01-16');
      const inv = await createAndPost('sales-invoices', {
        invoiceDate: '2025-01-16', customerId, warehouseId: W1, paymentType: 'CREDIT', lines: [{ itemId: S, qty: '30', unitPrice: '5' }],
      });
      invoiceId = inv.id;
      lineId = inv.lines[0].id;
    });

    it('TRADE-01: two return drafts of 20 at once — one is refused', async () => {
      const draft = () =>
        api().post('/api/v1/sales-returns').set(auth(token)).send({
          returnDate: '2025-01-17', originalInvoiceId: invoiceId, refundType: 'CREDIT', reason: 'r',
          lines: [{ originalLineId: lineId, qty: '20' }],
        });
      const [a, b] = await Promise.all([draft(), draft()]);
      expect([a.status, b.status].sort()).toEqual([201, 400]);
      const ok = a.status === 201 ? a : b;
      expect((await post('sales-returns', ok.body.id)).status).toBe(201);
      expect(await onHand(S, W1)).toBe('90'); // 100 − 30 + 20, never 110
      await assertConsistent();
    });

    it('TRADE-12: no CREDIT return on a CASH invoice; a credit return may exceed what is owed', async () => {
      const cash = await createAndPost('sales-invoices', {
        invoiceDate: '2025-01-17', customerId, warehouseId: W1, paymentType: 'CASH', cashAccountId, lines: [{ itemId: S, qty: '2', unitPrice: '5' }],
      });
      const credit = await api().post('/api/v1/sales-returns').set(auth(token)).send({
        returnDate: '2025-01-17', originalInvoiceId: cash.id, refundType: 'CREDIT', reason: 'r', lines: [{ originalLineId: cash.lines[0].id, qty: '1' }],
      });
      expect(credit.status).toBe(400);
      // Pay the rest of the 30-piece invoice, then return its last 10 on credit.
      const owed = (await api().get(`/api/v1/sales-invoices/${invoiceId}`).set(auth(token))).body.outstanding as string;
      const rc = await api().post('/api/v1/receipts').set(auth(token)).set('Idempotency-Key', key()).send({
        receiptDate: '2025-01-17', partyType: 'CUSTOMER', partyId: customerId, cashAccountId, amount: owed,
        allocations: [{ documentType: 'SALES_INVOICE', documentId: invoiceId, amount: owed }],
      });
      expect(rc.status).toBe(201);
      await createAndPost('sales-returns', {
        returnDate: '2025-01-18', originalInvoiceId: invoiceId, refundType: 'CREDIT', reason: 'r', lines: [{ originalLineId: lineId, qty: '10' }],
      });
      const after = await api().get(`/api/v1/sales-invoices/${invoiceId}`).set(auth(token));
      expect(new Decimal(after.body.outstanding).lt(0)).toBe(true); // a credit balance for the customer
      await assertConsistent();
    });

    it('TRADE-13 / TRADE-22: box lines return in boxes; parts add up to the line', async () => {
      const B = await item('B', { units: [{ unitId: box, factorToBase: '12' }] });
      const detail = await api().get(`/api/v1/items/${B}`).set(auth(token));
      const boxUnit = (detail.body.units as { id: string; unitId: string }[]).find((u) => u.unitId === box)!;
      await buy(B, '36', '1', '2025-01-18');
      const inv = await createAndPost('sales-invoices', {
        invoiceDate: '2025-01-18', customerId, warehouseId: W1, paymentType: 'CREDIT',
        lines: [{ itemId: B, itemUnitId: boxUnit.id, qty: '3', unitPrice: '33.333' }],
      });
      const full = await api().get(`/api/v1/sales-invoices/${inv.id}`).set(auth(token));
      const line = full.body.lines[0] as { id: string; netAmount: string; taxAmount: string };
      const parts: { qty: string; unitPrice: string; netAmount: string; taxAmount: string }[] = [];
      for (const date of ['2025-01-19', '2025-01-19', '2025-01-19']) {
        const r = await createAndPost('sales-returns', {
          returnDate: date, originalInvoiceId: inv.id, refundType: 'CREDIT', reason: 'r', lines: [{ originalLineId: line.id, qty: '12' }],
        });
        const got = await api().get(`/api/v1/sales-returns/${r.id}`).set(auth(token));
        parts.push(got.body.lines[0]);
      }
      expect(parts.map((p) => [new Decimal(p.qty).toString(), m3(p.unitPrice!)])).toEqual([
        ['1', '33.333'],
        ['1', '33.333'],
        ['1', '33.333'],
      ]);
      expect(m3(parts.reduce((a, p) => a.plus(p.netAmount), new Decimal(0)))).toBe(m3(line.netAmount));
      expect(m3(parts.reduce((a, p) => a.plus(p.taxAmount), new Decimal(0)))).toBe(m3(line.taxAmount));
      await assertConsistent();
    });
  });

  it('TRADE-07: a stale count is refused; refresh, then approve once, keyed', async () => {
    const C = await item('CNT');
    await buy(C, '88', '1', '2025-01-20');
    const count = await api().post('/api/v1/stock-counts').set(auth(token)).send({
      warehouseId: W1, countDate: '2025-01-21', lines: [{ itemId: C, countedQty: '50' }],
    });
    expect(count.status).toBe(201);
    await createAndPost('stock-adjustments', {
      adjustmentDate: '2025-01-21', adjustmentType: 'OUT', warehouseId: W1, lines: [{ itemId: C, qty: '5' }],
    });
    const noKey = await api().post(`/api/v1/stock-counts/${count.body.id}/approve`).set(auth(token));
    expect(noKey.status).toBe(400);
    const stale = await api().post(`/api/v1/stock-counts/${count.body.id}/approve`).set(auth(token)).set('Idempotency-Key', key());
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STOCK_COUNT_STALE');
    expect(await onHand(C, W1)).toBe('83'); // nothing posted
    // Tenant B can neither refresh nor approve A's count.
    expect((await api().post(`/api/v1/stock-counts/${count.body.id}/refresh`).set(auth(tokenB))).status).toBe(404);
    const refreshed = await api().post(`/api/v1/stock-counts/${count.body.id}/refresh`).set(auth(token));
    expect(refreshed.status).toBe(201);
    expect(new Decimal(refreshed.body.lines[0].systemQty).toString()).toBe('83');
    const approve = () => api().post(`/api/v1/stock-counts/${count.body.id}/approve`).set(auth(token)).set('Idempotency-Key', key());
    const [x, y] = await Promise.all([approve(), approve()]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect(await onHand(C, W1)).toBe('50'); // as counted
    await assertConsistent();
  });

  it('DB-19 (ADR-018): negative stock resets the value at the incoming cost; the residue is booked', async () => {
    await db.query('UPDATE companies SET allow_negative_stock = 1 WHERE tenant_id = ? AND id = ?', [tenantId, companyId]);
    try {
      const N = await item('N');
      await buy(N, '2', '5', '2025-01-22');
      await createAndPost('sales-invoices', {
        invoiceDate: '2025-01-22', customerId, warehouseId: W1, paymentType: 'CREDIT', lines: [{ itemId: N, qty: '4', unitPrice: '9' }],
      });
      expect(await cost(N)).toMatchObject({ qty: '-2', value: '-10.000', avg: '5' }); // sold short at the last cost
      const adjCode = await mappedCode('INVENTORY_ADJUSTMENT');
      const adjBefore = new Decimal(await balance(adjCode));
      await buy(N, '5', '6', '2025-01-23');
      expect(await cost(N)).toMatchObject({ qty: '3', value: '18.000', avg: '6' });
      expect(m3(new Decimal(await balance(adjCode)).minus(adjBefore))).toBe('2.000'); // 2 short × (6 − 5)
      await assertConsistent();
    } finally {
      await db.query('UPDATE companies SET allow_negative_stock = 0 WHERE tenant_id = ? AND id = ?', [tenantId, companyId]);
    }
  });

  it('TRADE-20: stock:verify reports a value difference and a GL difference', async () => {
    const V = await item('V');
    await buy(V, '1', '10', '2025-01-24');
    await db.query('UPDATE item_costs SET total_value = total_value + 1 WHERE tenant_id = ? AND item_id = ?', [tenantId, V]);
    try {
      const verify = await api().get('/api/v1/stock/verify').set(auth(token));
      const kinds = (verify.body.mismatches as { kind: string; itemId?: string }[]).map((m) => m.kind).sort();
      expect(kinds).toEqual(['COST_VALUE', 'GL_INVENTORY']);
    } finally {
      await db.query('UPDATE item_costs SET total_value = total_value - 1 WHERE tenant_id = ? AND item_id = ?', [tenantId, V]);
    }
    await assertConsistent();
  });

  it('isolation: tenant B reads none of A', async () => {
    const list = await api().get('/api/v1/stock/verify').set(auth(tokenB));
    expect(list.status).toBe(200);
    expect(list.body.checked).toBe(0);
    const [{ id }] = (await db.query("SELECT id FROM goods_notes WHERE tenant_id = ? AND note_type = 'GRN' LIMIT 1", [tenantId])) as { id: bigint }[];
    expect((await api().get(`/api/v1/goods-notes/${id}`).set(auth(tokenB))).status).toBe(404);
  });
});
