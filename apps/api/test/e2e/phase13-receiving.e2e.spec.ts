/**
 * Phase 13 — receiving against purchase orders, invoices from receipts, issues
 * to departments and issue requests (ADR-026):
 *  - GRN against an order: the order's warehouse, supplier and net price (tax
 *    extracted for a tax-inclusive order), received_qty, no receipt above the
 *    order (§4), statuses PARTIALLY_RECEIVED / RECEIVED, close with a reason,
 *    cancel only while nothing is received, the open counter (§6);
 *  - invoice from receipts: receive first, the order's supplier, the three-way
 *    match, billing twice refused, the price above the order and its approval
 *    (no self-approval, an edit clears it), receivedGrnId refused for an order's
 *    GRN, purchase.direct still enforced on direct invoices only (§2, §3, §7);
 *  - GIN to a department: expense account rules (§8);
 *  - issue requests at FULL: approval, IRQ numbering, issued quantities, the
 *    automatic close, stock.issue_without_request, the open counter (§9);
 *  - concurrency on separate connections (two GRNs on one order line, GRN vs
 *    cancel, GRN vs close, two invoices on one GRN line), tenant B and branch
 *    isolation, idempotent replays, stock:verify and the trial balance, the
 *    OpenAPI response audit.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { Decimal } from '../../src/common/decimal/decimal.utils.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3713;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p13-audit-${RUN}.jsonl`);
const T = 60_000;

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = (key = `p13-${RUN}-${Math.random().toString(36).slice(2)}`) => ({ 'Idempotency-Key': key });
const eq = (value: unknown, expected: string) => new Decimal(String(value)).eq(expected);

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
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
      OPENAPI_RESPONSE_AUDIT: AUDIT_FILE,
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
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
  rmSync(AUDIT_FILE, { force: true });
});

describe('Phase 13 — receiving, billing from receipts, issues (ADR-026)', () => {
  let owner = '';
  let acc = '';
  let accMembership = '';
  let store = '';
  let storeMembership = '';
  let appr = '';
  let ownerB = '';
  let tenantA = '';
  let companyA = '';
  let b2Branch = '';
  let W = '';
  let W2 = '';
  let WB = '';
  let item = '';
  let item2 = '';
  let service = '';
  let s1 = '';
  let s2 = '';
  let sB = '';
  let itemB = '';
  let cashAccount = '';
  let cashCode = '';

  const post = (token: string, p: string, body: object = {}, key?: string) =>
    api().post(`/api/v1/${p}`).set(auth(token)).set(idem(key)).send(body);
  const get = (token: string, p: string) => api().get(`/api/v1/${p}`).set(auth(token));
  const setLevel = (procurementLevel: string) => api().patch('/api/v1/company').set(auth(owner)).send({ procurementLevel });
  const grant = (membershipId: string, permissions: object[]) =>
    api().put(`/api/v1/users/${membershipId}/purchase-permissions`).set(auth(owner)).send({ permissions });

  /** An approved order (the owner creates and approves it), in warehouse `warehouseId`. */
  async function approvedOrder(lines: object[], opts: { token?: string; supplierId?: string; warehouseId?: string } = {}) {
    const token = opts.token ?? owner;
    const created = await api()
      .post('/api/v1/purchase-orders')
      .set(auth(token))
      .send({ orderDate: '2026-11-15', supplierId: opts.supplierId ?? s1, warehouseId: opts.warehouseId ?? W, lines });
    expect(created.status).toBe(201);
    expect((await post(token, `purchase-orders/${created.body.id}/submit`)).status).toBe(201);
    const approved = await post(token, `purchase-orders/${created.body.id}/approve`);
    expect(approved.status).toBe(201);
    return approved.body as { id: string; status: string; lines: { id: string; qtyBase: string; receivedQty: string }[] };
  }
  const receive = (orderId: string, lines?: { poLineId: string; qty: string }[], token = owner, key?: string) =>
    post(token, `purchase-orders/${orderId}/receive`, { noteDate: '2026-11-15', ...(lines ? { lines } : {}) }, key);
  const postNote = (id: string, token = owner) => post(token, `goods-notes/${id}/post`);
  async function receivedAndPosted(orderId: string, lines?: { poLineId: string; qty: string }[]) {
    const draft = await receive(orderId, lines);
    expect(draft.status).toBe(201);
    const posted = await postNote(draft.body.id);
    expect(posted.status).toBe(201);
    return posted.body as { id: string; lines: { id: string; qty: string; unitCost: string }[]; journalEntryId: string };
  }
  const bill = (orderId: string, lines: object[], token = owner, key?: string) =>
    post(token, `purchase-orders/${orderId}/bill`, { invoiceDate: '2026-11-15', paymentType: 'CREDIT', lines }, key);
  const orderOf = async (id: string) => (await get(owner, `purchase-orders/${id}`)).body;

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = (await db.query(sql, params)) as { n: bigint }[];
    return Number(row.n);
  }

  /** After posting: stock:verify clean, trial balance balanced (CLAUDE.md). */
  async function verified(token = owner) {
    const v = await get(token, 'stock/verify');
    expect(v.status).toBe(200);
    expect(v.body.mismatches).toEqual([]);
    const tb = await get(token, 'reports/trial-balance');
    expect(tb.body.balanced).toBe(true);
  }

  it(
    'setup: tenants A and B, a second branch, items, suppliers and members, MEDIUM',
    async () => {
      for (const tag of ['a', 'b']) {
        const res = await api()
          .post('/api/v1/auth/register')
          .send({ tenantName: `P13 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p13-${tag}-${RUN}@test.dev`, password: PASS });
        expect(res.status).toBe(201);
        if (tag === 'a') owner = res.body.accessToken;
        else ownerB = res.body.accessToken;
      }
      const [t] = (await db.query(
        'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
        [`P13 a ${RUN}`],
      )) as { tenantId: bigint; companyId: bigint }[];
      tenantA = String(t.tenantId);
      companyA = String(t.companyId);
      await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P13 % ${RUN}`]);
      const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantA])) as { id: bigint }[];
      const now = new Date();
      const b2 = (await db.query(
        'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        [tenantA, companyA, 'B2', 'فرع 2', now, now],
      )) as { insertId: bigint };
      b2Branch = String(b2.insertId);
      const w2 = (await db.query(
        'INSERT INTO warehouses (tenant_id, company_id, branch_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        [tenantA, companyA, b2Branch, 'W2', 'مستودع 2', now, now],
      )) as { insertId: bigint };
      W2 = String(w2.insertId);
      for (const token of [owner, ownerB]) {
        expect((await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' })).status).toBe(201);
      }
      const [irq] = (await db.query("SELECT prefix FROM document_sequences WHERE tenant_id = ? AND document_type = 'ISSUE_REQUEST'", [tenantA])) as {
        prefix: string;
      }[];
      expect(irq.prefix).toBe('IRQ-2026');
      W = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W1', nameAr: 'W1' })).body.id;
      const units = (await get(owner, 'units')).body as { id: string; code: string }[];
      const pcs = units.find((u) => u.code === 'PCS')!.id;
      const taxes = (await get(owner, 'tax-categories')).body as { id: string; code: string }[];
      const standard = taxes.find((x) => x.code === 'STANDARD')!.id;
      const mk = async (token: string, code: string, extra: object = {}) =>
        (await api().post('/api/v1/items').set(auth(token)).send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: standard, ...extra })).body.id as string;
      item = await mk(owner, 'I1');
      item2 = await mk(owner, 'I2');
      service = await mk(owner, 'SV', { itemKind: 'SERVICE' });
      const party = async (token: string, code: string) =>
        (await api().post('/api/v1/parties').set(auth(token)).send({ code, nameAr: code, partyType: 'SUPPLIER' })).body.id as string;
      s1 = await party(owner, 'S1');
      s2 = await party(owner, 'S2');
      const [cash] = (await db.query(
        "SELECT id, code FROM accounts WHERE tenant_id = ? AND control_type = 'CASH' AND is_postable = 1 LIMIT 1",
        [tenantA],
      )) as { id: bigint; code: string }[];
      cashAccount = String(cash.id);
      cashCode = cash.code;

      // Tenant B: its own warehouse, item and supplier.
      WB = (await api().post('/api/v1/warehouses').set(auth(ownerB)).send({ code: 'WB', nameAr: 'WB' })).body.id;
      const unitsB = (await get(ownerB, 'units')).body as { id: string; code: string }[];
      itemB = (await api().post('/api/v1/items').set(auth(ownerB)).send({ code: 'IB', nameAr: 'IB', baseUnitId: unitsB.find((u) => u.code === 'PCS')!.id })).body.id;
      sB = await party(ownerB, 'SB');

      const a = await addMember(BASE, owner, { email: `p13-acc-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
      acc = a.token;
      accMembership = a.membershipId;
      const s = await addMember(BASE, owner, {
        email: `p13-store-${RUN}@test.dev`,
        roleCode: 'STOREKEEPER',
        password: PASS,
        branchIds: [String(main.id)],
        defaultBranchId: String(main.id),
      });
      store = s.token;
      storeMembership = s.membershipId;
      const v = await addMember(BASE, owner, { email: `p13-appr-${RUN}@test.dev`, roleCode: 'VIEWER', password: PASS });
      appr = v.token;
      expect((await grant(accMembership, [{ code: 'purchase.approve' }])).status).toBe(200);
      expect((await grant(v.membershipId, [{ code: 'purchase.approve' }])).status).toBe(200);
      for (const token of [owner, ownerB]) {
        expect((await api().patch('/api/v1/company').set(auth(token)).send({ procurementLevel: 'MEDIUM' })).status).toBe(200);
      }
    },
    T,
  );

  describe('receiving against an order (§4–§6)', () => {
    it('a draft or submitted order is not received; the order warehouse, supplier and net price', async () => {
      const draft = await api()
        .post('/api/v1/purchase-orders')
        .set(auth(owner))
        .send({ orderDate: '2026-11-15', supplierId: s1, warehouseId: W, lines: [{ itemId: item, qty: '2', unitPrice: '3' }] });
      const refused = await receive(draft.body.id);
      expect([refused.status, refused.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);

      const po = await approvedOrder([{ itemId: item, qty: '10', unitPrice: '5.000' }]);
      const line = po.lines[0].id;
      // unitCost is the order's, never the body's; another warehouse is refused.
      const withCost = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W, noteType: 'GRN', purchaseOrderId: po.id, lines: [{ itemId: item, qty: '1', unitCost: '9', poLineId: line }],
      });
      expect([withCost.status, withCost.body.error.code]).toEqual([400, 'VALIDATION']);
      const otherWh = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W2, noteType: 'GRN', purchaseOrderId: po.id, lines: [{ itemId: item, qty: '1', poLineId: line }],
      });
      expect([otherWh.status, otherWh.body.error.code]).toEqual([400, 'VALIDATION']);
      const wrongItem = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W, noteType: 'GRN', purchaseOrderId: po.id, lines: [{ itemId: item2, qty: '1', poLineId: line }],
      });
      expect([wrongItem.status, wrongItem.body.error.code]).toEqual([400, 'VALIDATION']);
      const over = await receive(po.id, [{ poLineId: line, qty: '10.000001' }]);
      expect([over.status, over.body.error.code, over.body.error.details.remaining]).toEqual([409, 'PURCHASE_ORDER_OVER_RECEIPT', '10.000000']);

      const g = await receive(po.id, [{ poLineId: line, qty: '4' }]);
      expect(g.status).toBe(201);
      expect([g.body.noteType, g.body.status, g.body.purchaseOrderId, g.body.supplierId, g.body.warehouseId]).toEqual(['GRN', 'DRAFT', po.id, s1, W]);
      expect(eq(g.body.lines[0].unitCost, '5')).toBe(true);
      // A draft moves nothing and records nothing on the order.
      expect(eq((await orderOf(po.id)).lines[0].receivedQty, '0')).toBe(true);
      const posted = await postNote(g.body.id);
      expect(posted.status).toBe(201);
      const after = await orderOf(po.id);
      expect([after.status, new Decimal(after.lines[0].receivedQty).toString()]).toEqual(['PARTIALLY_RECEIVED', '4']);
      // Without lines: what is left (6).
      const rest = await receive(po.id);
      expect(eq(rest.body.lines[0].qty, '6')).toBe(true);
      expect((await postNote(rest.body.id)).status).toBe(201);
      expect((await orderOf(po.id)).status).toBe('RECEIVED');
      const nothing = await receive(po.id);
      expect([nothing.status, nothing.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      await verified();
    });

    it('a tax-inclusive order is received at its net price (ADR-017)', async () => {
      expect((await api().patch('/api/v1/company').set(auth(owner)).send({ pricesIncludeTax: true })).status).toBe(200);
      const po = await approvedOrder([{ itemId: item, qty: '10', unitPrice: '11.600' }]);
      expect((await api().patch('/api/v1/company').set(auth(owner)).send({ pricesIncludeTax: false })).status).toBe(200);
      const g = await receivedAndPosted(po.id);
      expect(eq(g.lines[0].unitCost, '10')).toBe(true);
      const entry = (await get(owner, `journal-entries/${g.journalEntryId}`)).body;
      expect(entry.lines.map((l: { debit: string; credit: string }) => new Decimal(l.debit).plus(l.credit).toFixed(3))).toEqual(['100.000', '100.000']);
      // Billed at the order price on the company's current (exclusive) basis: 11.600 / 1.16 = 10.000000.
      const billable = (await get(owner, `purchase-orders/${po.id}/billable`)).body;
      expect([billable.lines[0].defaultUnitCost, billable.lines[0].orderNetUnitPrice]).toEqual(['10', '10']);
    });

    it('a second draft posted after the first is refused above the order; cancel only while nothing is received', async () => {
      const po = await approvedOrder([{ itemId: item, qty: '10', unitPrice: '2' }]);
      const line = po.lines[0].id;
      const d1 = await receive(po.id, [{ poLineId: line, qty: '6' }]);
      const d2 = await receive(po.id, [{ poLineId: line, qty: '6' }]);
      expect([d1.status, d2.status]).toEqual([201, 201]);
      expect((await postNote(d1.body.id)).status).toBe(201);
      const second = await postNote(d2.body.id);
      expect([second.status, second.body.error.code]).toEqual([409, 'PURCHASE_ORDER_OVER_RECEIPT']);
      const cancel = await post(owner, `purchase-orders/${po.id}/cancel`, { reason: 'late' });
      expect([cancel.status, cancel.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      // Close with a reason: nothing is received after; the receipt stays billable.
      const noReason = await post(owner, `purchase-orders/${po.id}/close`, {});
      expect(noReason.status).toBe(400);
      const closed = await post(acc, `purchase-orders/${po.id}/close`, { reason: 'supplier stopped' });
      expect([closed.status, closed.body.status, closed.body.closeReason]).toEqual([201, 'CLOSED', 'supplier stopped']);
      const late = await postNote(d2.body.id);
      expect([late.status, late.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect((await get(owner, `purchase-orders/${po.id}/billable`)).body.lines).toHaveLength(1);
      // Cancel of an approved order with nothing received still works.
      const po2 = await approvedOrder([{ itemId: item, qty: '1', unitPrice: '2' }]);
      expect((await post(owner, `purchase-orders/${po2.id}/cancel`, { reason: 'not needed' })).body.status).toBe('CANCELLED');
      await verified();
    });

    it('two GRNs on one order line posted at once: exactly one takes the quantity', async () => {
      const po = await approvedOrder([{ itemId: item, qty: '10', unitPrice: '1' }]);
      const line = po.lines[0].id;
      const d1 = await receive(po.id, [{ poLineId: line, qty: '6' }]);
      const d2 = await receive(po.id, [{ poLineId: line, qty: '6' }]);
      const results = await Promise.all([postNote(d1.body.id), postNote(d2.body.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe('PURCHASE_ORDER_OVER_RECEIPT');
      expect(eq((await orderOf(po.id)).lines[0].receivedQty, '6')).toBe(true);
      await verified();
    });

    it('a GRN racing a cancel or a close: one wins, the order and the stock stay consistent', async () => {
      for (const action of ['cancel', 'close'] as const) {
        const po = await approvedOrder([{ itemId: item, qty: '5', unitPrice: '1' }]);
        const d = await receive(po.id);
        const [grn, other] = await Promise.all([postNote(d.body.id), post(owner, `purchase-orders/${po.id}/${action}`, { reason: 'race' })]);
        const order = await orderOf(po.id);
        const moved = await count('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ? AND source_id = ? AND source_type = ?', [
          tenantA,
          d.body.id,
          'GOODS_RECEIPT',
        ]);
        if (grn.status === 201) {
          expect(other.status).toBe(409);
          expect([order.status, moved]).toEqual(['RECEIVED', 1]);
        } else {
          expect([grn.status, other.status]).toEqual([409, 201]);
          expect([order.status, moved, new Decimal(order.lines[0].receivedQty).toString()]).toEqual([
            action === 'cancel' ? 'CANCELLED' : 'CLOSED',
            0,
            '0',
          ]);
        }
      }
      await verified();
    });

    it('idempotent replay of receive returns the same draft', async () => {
      const po = await approvedOrder([{ itemId: item, qty: '3', unitPrice: '1' }]);
      const key = `p13-${RUN}-replay-receive`;
      const a = await receive(po.id, undefined, owner, key);
      const b = await receive(po.id, undefined, owner, key);
      expect([a.status, b.status, b.body.id]).toEqual([201, 201, a.body.id]);
      expect(await count('SELECT COUNT(*) AS n FROM goods_notes WHERE tenant_id = ? AND purchase_order_id = ?', [tenantA, po.id])).toBe(1);
    });
  });

  describe('invoices from receipts (§2, §3, §7)', () => {
    let po = '';
    let grnLine = '';

    it('receive first; the order supplier and warehouse; the three-way match', async () => {
      const order = await approvedOrder([{ itemId: item, qty: '10', unitPrice: '3' }]);
      po = order.id;
      // Nothing received: no invoice on the order.
      const empty = await api().post('/api/v1/purchase-invoices').set(auth(owner)).send({
        invoiceDate: '2026-11-15', supplierId: s1, warehouseId: W, paymentType: 'CREDIT', purchaseOrderId: po,
        lines: [{ itemId: item, qty: '1', unitCost: '3' }],
      });
      expect([empty.status, empty.body.error.code]).toEqual([400, 'PURCHASE_ORDER_NOT_RECEIVED']);
      const g = await receivedAndPosted(po, [{ poLineId: order.lines[0].id, qty: '8' }]);
      grnLine = g.lines[0].id;
      const otherSupplier = await api().post('/api/v1/purchase-invoices').set(auth(owner)).send({
        invoiceDate: '2026-11-15', supplierId: s2, warehouseId: W, paymentType: 'CREDIT', purchaseOrderId: po,
        lines: [{ itemId: item, qty: '1', unitCost: '3', grnLineId: grnLine }],
      });
      expect([otherSupplier.status, otherSupplier.body.error.code]).toEqual([400, 'VALIDATION']);
      const tooMuch = await bill(po, [{ grnLineId: grnLine, qty: '9', unitCost: '3' }]);
      expect([tooMuch.status, tooMuch.body.error.code]).toEqual([409, 'PURCHASE_BILL_EXCEEDS_RECEIPT']);
      // A legacy invoice cannot bill an order's GRN as a whole.
      const legacy = await api().post('/api/v1/purchase-invoices').set(auth(owner)).send({
        invoiceDate: '2026-11-15', supplierId: s1, warehouseId: W, paymentType: 'CREDIT', receivedGrnId: g.id,
        lines: [{ itemId: item, qty: '1', unitCost: '3' }],
      });
      expect([legacy.status, legacy.body.error.code]).toEqual([400, 'VALIDATION']);
    });

    it('two invoices of the whole GRN line posted at once: one bills it, the other is refused', async () => {
      const a = await bill(po, [{ grnLineId: grnLine, qty: '8', unitCost: '3' }]);
      const b = await bill(po, [{ grnLineId: grnLine, qty: '8', unitCost: '3' }]);
      expect([a.status, b.status]).toEqual([201, 201]);
      const posted = await Promise.all([post(owner, `purchase-invoices/${a.body.id}/post`), post(owner, `purchase-invoices/${b.body.id}/post`)]);
      expect(posted.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(posted.find((r) => r.status === 409)!.body.error.code).toBe('PURCHASE_BILL_EXCEEDS_RECEIPT');
      const [l] = (await db.query('SELECT billed_qty, cleared_value FROM goods_note_lines WHERE tenant_id = ? AND id = ?', [tenantA, grnLine])) as {
        billed_qty: string;
        cleared_value: string;
      }[];
      expect([new Decimal(l.billed_qty).toString(), new Decimal(l.cleared_value).toFixed(3)]).toEqual(['8', '24.000']);
      expect(await count('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ? AND source_type = ?', [tenantA, 'PURCHASE_INVOICE'])).toBe(0);
      await verified();
    });

    it('a price above the order needs approval by someone else; an edit clears it; services and cash', async () => {
      const order = await approvedOrder([{ itemId: item2, qty: '4', unitPrice: '10' }]);
      const g = await receivedAndPosted(order.id);
      // The accountant (no purchase.direct) bills the order: not a direct purchase.
      const draft = await bill(order.id, [{ grnLineId: g.lines[0].id, qty: '4', unitCost: '10.5' }], acc);
      expect(draft.status).toBe(201);
      const refused = await post(acc, `purchase-invoices/${draft.body.id}/post`);
      expect([refused.status, refused.body.error.code]).toEqual([409, 'PURCHASE_PRICE_ABOVE_ORDER']);
      const self = await post(acc, `purchase-invoices/${draft.body.id}/approve-price`);
      expect([self.status, self.body.error.code]).toEqual([403, 'APPROVAL_SELF_NOT_ALLOWED']);
      const noPermission = await post(store, `purchase-invoices/${draft.body.id}/approve-price`);
      expect(noPermission.status).toBe(403);
      const ok = await post(appr, `purchase-invoices/${draft.body.id}/approve-price`);
      expect(ok.status).toBe(201);
      expect(ok.body.priceApprovedAt).not.toBeNull();
      // Edit (adds freight and pays cash): the approval is cleared.
      const full = (await get(acc, `purchase-invoices/${draft.body.id}`)).body;
      const edited = await api().put(`/api/v1/purchase-invoices/${draft.body.id}`).set(auth(acc)).send({
        invoiceDate: '2026-11-15', supplierId: s1, warehouseId: W, paymentType: 'CASH', cashAccountId: cashAccount, purchaseOrderId: order.id,
        lines: [
          { itemId: item2, qty: '4', unitCost: '10.5', grnLineId: g.lines[0].id, taxCategoryId: full.lines[0].taxCategoryId },
          { itemId: service, qty: '1', unitCost: '2' },
        ],
      });
      expect(edited.status).toBe(200);
      expect(edited.body.priceApprovedAt).toBeNull();
      expect((await post(acc, `purchase-invoices/${draft.body.id}/post`)).body.error.code).toBe('PURCHASE_PRICE_ABOVE_ORDER');
      expect((await post(owner, `purchase-invoices/${draft.body.id}/approve-price`)).status).toBe(201);
      const posted = await post(acc, `purchase-invoices/${draft.body.id}/post`);
      expect(posted.status).toBe(201);
      // 4 × 10.5 = 42.000 net stock (2104 40.000 + variance 2.000), freight 2.000, tax 16% of 44.000 = 7.040.
      const entry = (await get(owner, `journal-entries/${posted.body.journalEntryId}`)).body;
      const sides = (entry.lines as { account: { code: string }; debit: string; credit: string }[])
        .map((l) => `${l.account.code} ${new Decimal(l.debit).gt(0) ? `Dr ${new Decimal(l.debit).toFixed(3)}` : `Cr ${new Decimal(l.credit).toFixed(3)}`}`)
        .sort();
      expect(sides).toEqual(['1105 Dr 7.040', '2104 Dr 40.000', '5102 Dr 2.000', '5103 Dr 2.000', `${cashCode} Cr 51.040`].sort());
      // A direct invoice still needs purchase.direct (ADR-025 §4) at MEDIUM.
      const direct = await api().post('/api/v1/purchase-invoices').set(auth(acc)).send({
        invoiceDate: '2026-11-15', supplierId: s1, warehouseId: W, paymentType: 'CREDIT', lines: [{ itemId: item, qty: '1', unitCost: '1' }],
      });
      expect([direct.status, direct.body.error.code]).toEqual([403, 'PURCHASE_DIRECT_REQUIRED']);
      // Nothing above the order: nothing to approve.
      const order2 = await approvedOrder([{ itemId: item2, qty: '1', unitPrice: '10' }]);
      const g2 = await receivedAndPosted(order2.id);
      const fair = await bill(order2.id, [{ grnLineId: g2.lines[0].id, qty: '1', unitCost: '9.999' }]);
      expect((await post(appr, `purchase-invoices/${fair.body.id}/approve-price`)).status).toBe(400);
      expect((await post(owner, `purchase-invoices/${fair.body.id}/post`)).status).toBe(201);
      await verified();
    });

    it('idempotent replay of bill returns the same draft invoice', async () => {
      const order = await approvedOrder([{ itemId: item, qty: '2', unitPrice: '1' }]);
      const g = await receivedAndPosted(order.id);
      const key = `p13-${RUN}-replay-bill`;
      const a = await bill(order.id, [{ grnLineId: g.lines[0].id, qty: '2', unitCost: '1' }], owner, key);
      const b = await bill(order.id, [{ grnLineId: g.lines[0].id, qty: '2', unitCost: '1' }], owner, key);
      expect([a.status, b.status, b.body.id]).toEqual([201, 201, a.body.id]);
      expect(await count('SELECT COUNT(*) AS n FROM purchase_invoices WHERE tenant_id = ? AND purchase_order_id = ?', [tenantA, order.id])).toBe(1);
    });
  });

  describe('goods issue to a department (§8)', () => {
    it('only an active postable expense account; none on a GRN; without one, the old account', async () => {
      const [cashAcc] = (await db.query("SELECT id FROM accounts WHERE tenant_id = ? AND control_type = 'CASH' LIMIT 1", [tenantA])) as { id: bigint }[];
      const notExpense = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W, noteType: 'GIN', expenseAccountId: String(cashAcc.id), lines: [{ itemId: item, qty: '1' }],
      });
      expect([notExpense.status, notExpense.body.error.code]).toEqual([400, 'VALIDATION']);
      const [exp] = (await db.query("SELECT id FROM accounts WHERE tenant_id = ? AND code = '5204'", [tenantA])) as { id: bigint }[];
      const onGrn = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W, noteType: 'GRN', expenseAccountId: String(exp.id), lines: [{ itemId: item, qty: '1', unitCost: '1' }],
      });
      expect([onGrn.status, onGrn.body.error.code]).toEqual([400, 'VALIDATION']);
      const plain = await api().post('/api/v1/goods-notes').set(auth(owner)).send({
        noteDate: '2026-11-15', warehouseId: W, noteType: 'GIN', lines: [{ itemId: item, qty: '1' }],
      });
      const posted = await postNote(plain.body.id);
      expect(posted.status).toBe(201);
      const entry = (await get(owner, `journal-entries/${posted.body.journalEntryId}`)).body;
      expect((entry.lines as { account: { code: string } }[]).map((l) => l.account.code).sort()).toEqual(['1104', '5102']);
      await verified();
    });
  });

  describe('isolation: tenant B and branches', () => {
    it("tenant B never reaches A's orders, notes, invoices or requests", async () => {
      const order = await approvedOrder([{ itemId: item, qty: '2', unitPrice: '1' }]);
      const g = await receivedAndPosted(order.id);
      const inv = await bill(order.id, [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '1' }]);
      for (const res of [
        await post(ownerB, `purchase-orders/${order.id}/receive`, { noteDate: '2026-11-15' }),
        await post(ownerB, `purchase-orders/${order.id}/bill`, { invoiceDate: '2026-11-15', paymentType: 'CREDIT', lines: [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '1' }] }),
        await get(ownerB, `purchase-orders/${order.id}/billable`),
        await post(ownerB, `purchase-orders/${order.id}/close`, { reason: 'x' }),
        await post(ownerB, `purchase-invoices/${inv.body.id}/approve-price`),
        await get(ownerB, `goods-notes/${g.id}`),
      ]) {
        expect(res.status).toBe(404);
      }
      // B bills its own order with A's GRN line id: not one of its receipts.
      const orderB = await approvedOrder([{ itemId: itemB, qty: '1', unitPrice: '1' }], { token: ownerB, supplierId: sB, warehouseId: WB });
      const foreign = await post(ownerB, `purchase-orders/${orderB.id}/bill`, {
        invoiceDate: '2026-11-15', paymentType: 'CREDIT', lines: [{ grnLineId: g.lines[0].id, qty: '1', unitCost: '1' }],
      });
      expect(foreign.status).toBe(404);
      const listB = await get(ownerB, `goods-notes?purchaseOrderId=${order.id}`);
      expect(listB.body.total).toBe(0);
    });

    it('a storekeeper of MAIN cannot receive an order of branch B2', async () => {
      const order = await approvedOrder([{ itemId: item, qty: '1', unitPrice: '1' }], { warehouseId: W2 });
      expect((await receive(order.id, undefined, store)).status).toBe(404);
      expect((await receive(order.id, undefined, owner)).status).toBe(201);
    });
  });

  describe('issue requests at FULL (§9)', () => {
    let irq = '';
    let lineId = '';

    it('need the FULL level; at FULL a GIN without one needs stock.issue_without_request', async () => {
      const early = await api().post('/api/v1/issue-requests').set(auth(store)).send({ requestDate: '2026-11-15', warehouseId: W, lines: [{ itemId: item, qty: '1' }] });
      expect([early.status, early.body.error.code]).toEqual([409, 'PROCUREMENT_LEVEL_REQUIRED']);
      expect((await setLevel('FULL')).status).toBe(200);
      const gin = () =>
        api().post('/api/v1/goods-notes').set(auth(store)).send({ noteDate: '2026-11-15', warehouseId: W, noteType: 'GIN', lines: [{ itemId: item, qty: '1' }] });
      const refused = await gin();
      expect([refused.status, refused.body.error.code]).toEqual([403, 'ISSUE_REQUEST_REQUIRED']);
      // The owner is exempt; a grant lets the storekeeper issue directly; posting reads it again under lock.
      const ownerDraft = await api().post('/api/v1/goods-notes').set(auth(owner)).send({ noteDate: '2026-11-15', warehouseId: W, noteType: 'GIN', lines: [{ itemId: item, qty: '1' }] });
      expect(ownerDraft.status).toBe(201);
      expect((await postNote(ownerDraft.body.id, store)).body.error.code).toBe('ISSUE_REQUEST_REQUIRED');
      expect((await grant(storeMembership, [{ code: 'stock.issue_without_request' }])).status).toBe(200);
      const allowed = await gin();
      expect(allowed.status).toBe(201);
      expect((await grant(storeMembership, [])).status).toBe(200);
      expect((await postNote(allowed.body.id, store)).body.error.code).toBe('ISSUE_REQUEST_REQUIRED');
      expect((await postNote(allowed.body.id, owner)).status).toBe(201);
    });

    it('DRAFT → SUBMITTED → APPROVED (IRQ, not by its author), issued quantities, the automatic close', async () => {
      const created = await api().post('/api/v1/issue-requests').set(auth(store)).send({
        requestDate: '2026-11-15', warehouseId: W, lines: [{ itemId: item, qty: '3', note: 'dept' }],
      });
      expect([created.status, created.body.status, created.body.requestNo]).toEqual([201, 'DRAFT', null]);
      irq = created.body.id;
      lineId = created.body.lines[0].id;
      const notApproved = await post(store, `issue-requests/${irq}/issue`, { noteDate: '2026-11-15' });
      expect([notApproved.status, notApproved.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect((await post(store, `issue-requests/${irq}/submit`)).body.status).toBe('SUBMITTED');
      expect((await post(store, `issue-requests/${irq}/approve`)).status).toBe(403);
      const approved = await post(acc, `issue-requests/${irq}/approve`);
      expect([approved.status, approved.body.status, approved.body.requestNo]).toEqual([201, 'APPROVED', 'IRQ-2026-000001']);
      // Lowering to MEDIUM is refused while the request is open.
      const lower = await setLevel('MEDIUM');
      expect([lower.status, lower.body.error.code]).toEqual([409, 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS']);
      expect(lower.body.error.details.openDocuments.issueRequests).toBe(1);

      const g1 = await post(store, `issue-requests/${irq}/issue`, { noteDate: '2026-11-15', lines: [{ issueRequestLineId: lineId, qty: '2' }] });
      expect([g1.status, g1.body.issueRequestId, g1.body.noteType]).toEqual([201, irq, 'GIN']);
      expect((await postNote(g1.body.id, store)).status).toBe(201);
      expect(eq((await get(owner, `issue-requests/${irq}`)).body.lines[0].issuedQty, '2')).toBe(true);
      const over = await post(store, `issue-requests/${irq}/issue`, { noteDate: '2026-11-15', lines: [{ issueRequestLineId: lineId, qty: '2' }] });
      expect([over.status, over.body.error.code]).toEqual([409, 'ISSUE_REQUEST_QTY_EXCEEDED']);
      const cancel = await post(owner, `issue-requests/${irq}/cancel`, { reason: 'x' });
      expect([cancel.status, cancel.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      const g2 = await post(store, `issue-requests/${irq}/issue`, { noteDate: '2026-11-15' });
      expect(eq(g2.body.lines[0].qty, '1')).toBe(true);
      expect((await postNote(g2.body.id, store)).status).toBe(201);
      expect((await get(owner, `issue-requests/${irq}`)).body.status).toBe('CLOSED');
      await verified();
    });

    it('an issue request is isolated from tenant B', async () => {
      // At FULL too, so the level is not what refuses it.
      expect((await api().patch('/api/v1/company').set(auth(ownerB)).send({ procurementLevel: 'FULL' })).status).toBe(200);
      for (const res of [
        await get(ownerB, `issue-requests/${irq}`),
        await post(ownerB, `issue-requests/${irq}/close`),
        await post(ownerB, `issue-requests/${irq}/issue`, { noteDate: '2026-11-15' }),
      ]) {
        expect(res.status).toBe(404);
      }
      expect((await get(ownerB, 'issue-requests')).body.total).toBe(0);
    });
  });

  describe('the open counter of orders (§6)', () => {
    it('RECEIVED, CLOSED and CANCELLED orders do not block lowering the level', async () => {
      // Tenant B (back at MEDIUM, nothing of FULL open): one order received in full, one closed,
      // one cancelled → SIMPLE is allowed.
      expect((await api().patch('/api/v1/company').set(auth(ownerB)).send({ procurementLevel: 'MEDIUM' })).status).toBe(200);
      const r =await approvedOrder([{ itemId: itemB, qty: '1', unitPrice: '1' }], { token: ownerB, supplierId: sB, warehouseId: WB });
      const g = await receive(r.id, undefined, ownerB);
      const p = await post(ownerB, `goods-notes/${g.body.id}/post`);
      expect(p.status).toBe(201);
      const partial = await approvedOrder([{ itemId: itemB, qty: '2', unitPrice: '1' }], { token: ownerB, supplierId: sB, warehouseId: WB });
      const g2 = await receive(partial.id, [{ poLineId: partial.lines[0].id, qty: '1' }], ownerB);
      expect((await post(ownerB, `goods-notes/${g2.body.id}/post`)).status).toBe(201);
      const lowerB = () => api().patch('/api/v1/company').set(auth(ownerB)).send({ procurementLevel: 'SIMPLE' });
      // The isolation test's order is APPROVED and this one PARTIALLY_RECEIVED: both open.
      const blocked = await lowerB();
      expect([blocked.status, blocked.body.error.details.openDocuments.purchaseOrders]).toEqual([409, 2]);
      expect((await post(ownerB, `purchase-orders/${partial.id}/close`, { reason: 'done' })).status).toBe(201);
      const isolationOrder = (await get(ownerB, 'purchase-orders?status=APPROVED')).body.items[0].id as string;
      expect((await post(ownerB, `purchase-orders/${isolationOrder}/cancel`, { reason: 'done' })).status).toBe(201);
      expect((await lowerB()).status).toBe(200);
      await verified(ownerB);
    });
  });

  it('the integrity check finds the receipt, billing and issue projections equal to the posted documents', async () => {
    const { stdout } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'integrity-check', '--tenant', tenantA], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(), NODE_ENV: 'test' },
    });
    const report = JSON.parse(stdout) as { ok: boolean; checks: { name: string; ok: boolean; count: number }[] };
    for (const name of ['purchase_order_lines.received_qty', 'goods_note_lines.billed_qty', 'issue_request_lines.issued_qty']) {
      expect(report.checks.find((c) => c.name === name)).toMatchObject({ ok: true, count: 0 });
    }
    expect(report.ok).toBe(true);
  }, T);

  it('the OpenAPI response audit found nothing', async () => {
    await verified();
    const findings = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean) : [];
    expect(findings).toEqual([]);
  });
});
