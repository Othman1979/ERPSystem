/**
 * Trade review wave 2 (TRADE-10/11/15/17/18/23/24/25): item units and
 * deactivation, discount bounds, branch-restricted writes on vouchers and
 * returns, journal source links, race-safe auto-allocation, cash box history
 * and the e-invoice production guard. Tenant B must not reach tenant A's rows.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3623;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `tw2-${RUN}-${Math.random().toString(36).slice(2)}` });

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
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' };
  delete env.EINVOICE_ALLOW_PRODUCTION; // TRADE-24 needs the flag unset
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env,
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

describe('Trade wave 2 — treasury, units, branches', () => {
  let owner = '';
  let tokenB = '';
  let cashier = '';
  let tenantId: bigint;
  let mainId = '';
  let b2Id = '';
  let warehouseId = '';
  let pcs = '';
  let box = '';
  let itemId = '';
  let cashAccountId = '';
  let cashBoxId = '';
  let b2InvoiceId = '';
  let b2ReceiptId = '';
  let b2AllocationId = '';
  let countId = '';
  let customerSeq = 0;

  const count = async (table: string) =>
    Number(((await db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`, [tenantId])) as { n: bigint }[])[0].n);

  async function party(token = owner): Promise<string> {
    customerSeq += 1;
    const res = await api()
      .post('/api/v1/parties')
      .set(auth(token))
      .send({ code: `C${customerSeq}`, nameAr: `C${customerSeq}`, partyType: 'CUSTOMER' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  /** Posted credit invoice of 5 x 2.000 (+ tax); returns its id. */
  async function creditSale(customerId: string, date: string, headers: Record<string, string> = {}) {
    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(owner))
      .set(headers)
      .send({ invoiceDate: date, customerId, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '5', unitPrice: '2.000' }] });
    expect(inv.status).toBe(201);
    const posted = await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(owner)).set(headers).set(idem());
    expect(posted.status).toBe(201);
    return inv.body.id as string;
  }

  const invoice = async (id: string) => (await api().get(`/api/v1/sales-invoices/${id}`).set(auth(owner))).body;
  const receipt = (body: object, token = owner, headers: Record<string, string> = {}) =>
    api().post('/api/v1/receipts').set(auth(token)).set(headers).set(idem()).send(body);

  it('setup: tenants A and B, branches MAIN + B2, restricted cashier, stock, cash box', async () => {
    const name = `TW2A ${RUN}`;
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: name, ownerName: 'Owner', email: `tw2a-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `TW2B ${RUN}`, ownerName: 'Owner B', email: `tw2b-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [name],
    )) as { tenantId: bigint; companyId: bigint }[];
    tenantId = t.tenantId;
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantId])) as { id: bigint }[];
    mainId = String(main.id);
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);

    const email = `tw2-cashier-${RUN}@test.dev`;
    const invite = await api()
      .post('/api/v1/users/invite')
      .set(auth(owner))
      .send({ email, roleCode: 'CASHIER', password: PASS, defaultBranchId: mainId, branchIds: [mainId] });
    expect(invite.status).toBe(201);
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASS });
    expect(login.status).toBe(200);
    cashier = login.body.accessToken;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = (await api().get('/api/v1/units').set(auth(owner))).body as { id: string; code: string }[];
    pcs = units.find((u) => u.code === 'PCS')!.id;
    box = units.find((u) => u.code === 'BOX')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs })).body.id;
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(owner))
      .send({ adjustmentDate: '2025-01-05', adjustmentType: 'OPENING', warehouseId, lines: [{ itemId, qty: '1000', unitCost: '1.000' }] });
    expect(adj.status).toBe(201);
    expect((await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(owner)).set(idem())).status).toBe(201);

    const flat: { id: string; code: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; code: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk((await api().get('/api/v1/accounts').set(auth(owner))).body);
    cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;
    const cb = await api().post('/api/v1/cash-boxes').set(auth(owner)).send({ code: 'CB1', name: 'Main box', accountId: cashAccountId });
    expect(cb.status).toBe(201);
    cashBoxId = cb.body.id;
  }, 60_000);

  it('TRADE-10: tiny factor is rejected; a used unit cannot be removed and ids stay stable', async () => {
    const tiny = await api()
      .put(`/api/v1/items/${itemId}/units`)
      .set(auth(owner))
      .send({ units: [{ unitId: pcs, factorToBase: '0.0000001' }] });
    expect(tiny.status).toBe(400);
    expect(tiny.body.error.code).toBe('VALIDATION');

    const set = (defaultSale: boolean) => ({
      units: [
        { unitId: pcs, factorToBase: '1', isDefaultSale: !defaultSale },
        { unitId: box, factorToBase: '12', isDefaultSale: defaultSale, isDefaultPurchase: defaultSale },
      ],
    });
    const saved = await api().put(`/api/v1/items/${itemId}/units`).set(auth(owner)).send(set(false));
    expect(saved.status).toBe(200);
    const boxRow = (saved.body.units as { id: string; unitId: string }[]).find((u) => u.unitId === box)!;

    const inv = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(owner))
      .send({
        invoiceDate: '2025-01-10',
        customerId: await party(),
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, itemUnitId: boxRow.id, qty: '1', unitPrice: '20.000' }],
      });
    expect(inv.status).toBe(201);
    expect((await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(owner)).set(idem())).status).toBe(201);

    const removed = await api()
      .put(`/api/v1/items/${itemId}/units`)
      .set(auth(owner))
      .send({ units: [{ unitId: pcs, factorToBase: '1', isDefaultSale: true }] });
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('CONFLICT');

    const resaved = await api().put(`/api/v1/items/${itemId}/units`).set(auth(owner)).send(set(true));
    expect(resaved.status).toBe(200);
    const after = (resaved.body.units as { id: string; unitId: string }[]).find((u) => u.unitId === box)!;
    expect(after.id).toBe(boxRow.id);
  });

  it('TRADE-15: an item with stock cannot be deactivated; one without stock can', async () => {
    const blocked = await api().patch(`/api/v1/items/${itemId}`).set(auth(owner)).send({ isActive: false });
    expect(blocked.status).toBe(409);
    const empty = await api().post('/api/v1/items').set(auth(owner)).send({ code: 'Z', nameAr: 'Z', baseUnitId: pcs });
    expect(empty.status).toBe(201);
    const ok = await api().patch(`/api/v1/items/${empty.body.id}`).set(auth(owner)).send({ isActive: false });
    expect(ok.status).toBe(200);
    expect(ok.body.isActive).toBe(false);
  });

  it('TRADE-23: a discount above 100 % is rejected on create', async () => {
    const res = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(owner))
      .send({
        invoiceDate: '2025-02-01',
        customerId: await party(),
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty: '1', unitPrice: '10.000', discountPct: '150' }],
      });
    expect(res.status).toBe(400);
  });

  it('TRADE-11: a MAIN-only member cannot write against a branch-2 invoice, return or allocation', async () => {
    const customer = await party();
    b2InvoiceId = await creditSale(customer, '2025-02-10', { 'X-Branch-Id': b2Id });
    const grand = (await invoice(b2InvoiceId)).grandTotal as string;

    // (a) receipt allocating a branch-2 invoice.
    const receiptsBefore = await count('receipts');
    const allocsBefore = await count('allocations');
    const denied = await receipt(
      {
        receiptDate: '2025-02-11',
        partyType: 'CUSTOMER',
        partyId: customer,
        cashAccountId,
        amount: '1.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: b2InvoiceId, amount: '1.000' }],
      },
      cashier,
    );
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    expect(await count('receipts')).toBe(receiptsBefore);
    expect(await count('allocations')).toBe(allocsBefore);
    expect(new Decimal((await invoice(b2InvoiceId)).outstanding).toFixed(3)).toBe(new Decimal(grand).toFixed(3));

    // (b) return draft on the branch-2 invoice.
    const lineId = (await invoice(b2InvoiceId)).lines[0].id as string;
    const retBody = { returnDate: '2025-02-12', originalInvoiceId: b2InvoiceId, refundType: 'CREDIT', lines: [{ originalLineId: lineId, qty: '1' }] };
    const returnsBefore = await count('sales_returns');
    const retDenied = await api().post('/api/v1/sales-returns').set(auth(cashier)).send(retBody);
    expect(retDenied.status).toBe(403);
    expect(await count('sales_returns')).toBe(returnsBefore);

    // (c) the owner drafts the return; the restricted member may not delete it.
    const draft = await api().post('/api/v1/sales-returns').set(auth(owner)).send(retBody);
    expect(draft.status).toBe(201);
    const del = await api().delete(`/api/v1/sales-returns/${draft.body.id}`).set(auth(cashier));
    expect(del.status).toBe(403);
    expect(await count('sales_returns')).toBe(returnsBefore + 1);

    // (d) cancelling an allocation of the branch-2 invoice.
    const rec = await receipt(
      {
        receiptDate: '2025-02-13',
        partyType: 'CUSTOMER',
        partyId: customer,
        cashAccountId,
        amount: '5.000',
        allocations: [{ documentType: 'SALES_INVOICE', documentId: b2InvoiceId, amount: '5.000' }],
      },
      owner,
      { 'X-Branch-Id': b2Id },
    );
    expect(rec.status).toBe(201);
    b2ReceiptId = rec.body.id;
    b2AllocationId = rec.body.allocations[0].id;
    const cancel = await api().post(`/api/v1/allocations/${b2AllocationId}/cancel`).set(auth(cashier)).set(idem());
    expect(cancel.status).toBe(403);
    expect(cancel.body.error.code).toBe('BRANCH_NOT_ALLOWED');
  });

  it('TRADE-17: receipt and cash transfer entries link back to their source', async () => {
    const entry = async (id: string) => (await api().get(`/api/v1/journal-entries/${id}`).set(auth(owner))).body;
    const rec = (await api().get(`/api/v1/receipts/${b2ReceiptId}`).set(auth(owner))).body;
    const je = await entry(rec.journalEntry?.id ?? rec.journalEntryId);
    expect(je.sourceType).toBe('RECEIPT');
    expect(String(je.sourceId)).toBe(b2ReceiptId);

    const flat: { id: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk((await api().get('/api/v1/accounts').set(auth(owner))).body);
    const bankAccountId = flat.find((a) => a.controlType === 'BANK')!.id;
    expect((await api().post('/api/v1/bank-accounts').set(auth(owner)).send({ bankName: 'Bank 1', accountId: bankAccountId })).status).toBe(201);
    const t = await api()
      .post('/api/v1/cash-transfers')
      .set(auth(owner))
      .set(idem())
      .send({ transferDate: '2025-03-01', fromAccountId: cashAccountId, toAccountId: bankAccountId, amount: '2.000' });
    expect(t.status).toBe(201);
    const tje = await entry(t.body.journalEntry.id);
    expect(tje.sourceType).toBe('CASH_TRANSFER');
    expect(String(tje.sourceId)).toBe(t.body.id);
  });

  it('TRADE-18: auto-allocation is oldest-first, capped, and race-safe', async () => {
    const customer = await party();
    const [i1, i2, i3] = [
      await creditSale(customer, '2025-03-02'),
      await creditSale(customer, '2025-03-03'),
      await creditSale(customer, '2025-03-04'),
    ];
    const grand = (await invoice(i1)).grandTotal as string;
    const base = { partyType: 'CUSTOMER', partyId: customer, cashAccountId };
    const paid = await receipt({
      ...base,
      receiptDate: '2025-03-05',
      amount: grand,
      allocations: [{ documentType: 'SALES_INVOICE', documentId: i1, amount: grand }],
    });
    expect(paid.status).toBe(201);
    const auto = await receipt({ ...base, receiptDate: '2025-03-06', amount: '1000.000', autoAllocate: true });
    expect(auto.status).toBe(201);
    const allocs = auto.body.allocations as { documentId: string; amount: string }[];
    expect(allocs.map((a) => String(a.documentId)).sort()).toEqual([i2, i3].sort());
    for (const a of allocs) expect(new Decimal(a.amount).lte(new Decimal(grand))).toBe(true);
    for (const id of [i1, i2, i3]) expect(new Decimal((await invoice(id)).outstanding).toFixed(3)).toBe('0.000');

    // Race: two auto receipts over two open invoices, 2 x 15 > their total.
    const racer = await party();
    const open = [await creditSale(racer, '2025-03-07'), await creditSale(racer, '2025-03-08')];
    const results = await Promise.all(
      [1, 2].map(() => receipt({ partyType: 'CUSTOMER', partyId: racer, cashAccountId, receiptDate: '2025-03-09', amount: '15.000', autoAllocate: true })),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
    for (const id of open) {
      const inv = await invoice(id);
      const out = new Decimal(inv.outstanding);
      expect(out.gte(0)).toBe(true);
      expect(out.lte(new Decimal(inv.grandTotal))).toBe(true);
      const [row] = (await db.query(
        "SELECT COALESCE(SUM(amount), 0) AS s FROM allocations WHERE tenant_id = ? AND document_type = 'SALES_INVOICE' AND document_id = ? AND cancelled_at IS NULL",
        [tenantId, id],
      )) as { s: string }[];
      expect(new Decimal(row.s).lte(new Decimal(inv.grandTotal))).toBe(true);
    }
  }, 60_000);

  it('TRADE-25: a cash box with GL history cannot be re-linked and is deactivated, not deleted', async () => {
    const created = await api()
      .post('/api/v1/accounts')
      .set(auth(owner))
      .send({ code: '1190', nameAr: 'Cash 2', accountType: 'ASSET', parentId: await parentOf('1101'), isPostable: true, controlType: 'CASH' });
    expect(created.status).toBe(201);
    const relink = await api().put(`/api/v1/cash-boxes/${cashBoxId}`).set(auth(owner)).send({ accountId: created.body.id });
    expect(relink.status).toBe(409);

    const del = await api().delete(`/api/v1/cash-boxes/${cashBoxId}`).set(auth(owner));
    expect(del.status).toBe(200);
    expect(del.body.deactivated).toBe(true);
    const [row] = (await db.query('SELECT is_active FROM cash_boxes WHERE tenant_id = ? AND id = ?', [tenantId, cashBoxId])) as {
      is_active: number | bigint | boolean;
    }[];
    expect(Number(row.is_active)).toBe(0);
  });

  async function parentOf(code: string): Promise<string> {
    const [row] = (await db.query('SELECT parent_id FROM accounts WHERE tenant_id = ? AND code = ?', [tenantId, code])) as {
      parent_id: bigint;
    }[];
    return String(row.parent_id);
  }

  it('TRADE-24: PRODUCTION e-invoicing is refused outside a production server', async () => {
    const res = await api()
      .put('/api/v1/einvoice/settings')
      .set(auth(owner))
      .send({ environment: 'PRODUCTION', track: 'GENERAL_SALES', isEnabled: false });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it("isolation: tenant B cannot reach A's receipt, allocation or stock count", async () => {
    const cnt = await api()
      .post('/api/v1/stock-counts')
      .set(auth(owner))
      .send({ countDate: '2025-04-01', warehouseId, lines: [{ itemId, countedQty: '10' }] });
    expect(cnt.status).toBe(201);
    countId = cnt.body.id;

    expect((await api().get(`/api/v1/receipts/${b2ReceiptId}`).set(auth(tokenB))).status).toBe(404);
    expect((await api().post(`/api/v1/allocations/${b2AllocationId}/cancel`).set(auth(tokenB)).set(idem())).status).toBe(404);
    expect((await api().post(`/api/v1/stock-counts/${countId}/refresh`).set(auth(tokenB))).status).toBe(404);
    // The owner still sees them (nothing was cancelled by B).
    expect((await api().get(`/api/v1/receipts/${b2ReceiptId}`).set(auth(owner))).status).toBe(200);
  });

  it('ledgers stay consistent: stock:verify clean and trial balance balanced', async () => {
    const verify = await api().get('/api/v1/stock/verify').set(auth(owner));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(owner));
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
  });
});
