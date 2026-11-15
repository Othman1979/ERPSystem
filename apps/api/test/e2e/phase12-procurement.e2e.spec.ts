/**
 * Phase 12 — purchase requests, requests for quotation and purchase orders (ADR-025):
 *  - the level gate on the server (PROCUREMENT_LEVEL_REQUIRED): orders from MEDIUM,
 *    requests and quotes at FULL; at FULL an order comes from an approved request;
 *  - every transition and its permission; approvals per §2 (purchase.approve, the
 *    limit on the order total, no self-approval except the owner);
 *  - numbering at approval (PRQ, PO) or when sent (RFQ), gapless, never on a draft;
 *  - partial conversion, the comparison and «create orders», remaining quantities,
 *    a cancelled order giving its quantity back, the automatic close;
 *  - the acceptance test: NO journal entry and NO stock movement from any of it;
 *  - lowering the level refused with open documents; purchase.direct enforced on
 *    purchase invoices at MEDIUM / FULL for non-owners (not at SIMPLE) and the
 *    raise-level warning list; party in use; tenant B and branch isolation;
 *    idempotent replays; the OpenAPI response audit.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { Decimal } from '../../src/common/decimal/decimal.utils.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3712;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p12-audit-${RUN}.jsonl`);
const T = 60_000;

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = (key = `p12-${RUN}-${Math.random().toString(36).slice(2)}`) => ({ 'Idempotency-Key': key });
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

async function count(sql: string, params: unknown[]): Promise<number> {
  const [row] = (await db.query(sql, params)) as { n: bigint }[];
  return Number(row.n);
}

describe('Phase 12 — purchase requests, quotes and orders (ADR-025)', () => {
  // Tenant A: owner, accountant (approves up to 1000), storekeeper and cashier (MAIN only), viewer-approver.
  let owner = '';
  let acc = '';
  let store = '';
  let cashier = '';
  let appr2 = '';
  let accMembership = '';
  let cashierMembership = '';
  let ownerB = '';
  let tenantA = '';
  let companyA = '';
  let mainBranch = '';
  let b2Branch = '';
  let warehouse = '';
  let warehouseB2 = '';
  let itemTaxed = '';
  let itemZero = '';
  let s1 = '';
  let s2 = '';
  let customer = '';

  const setLevel = (token: string, procurementLevel: string) =>
    api().patch('/api/v1/company').set(auth(token)).send({ procurementLevel });
  const ledgerCounts = async () => ({
    journal: await count('SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ?', [tenantA]),
    lines: await count('SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ?', [tenantA]),
    movements: await count('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?', [tenantA]),
    balances: await count('SELECT COUNT(*) AS n FROM stock_balances WHERE tenant_id = ?', [tenantA]),
  });
  let ledgerBefore: Awaited<ReturnType<typeof ledgerCounts>>;

  const order = (token: string, body: object) => api().post('/api/v1/purchase-orders').set(auth(token)).send(body);
  const act = (token: string, doc: string, id: string, action: string, body?: object, key?: string) =>
    api()
      .post(`/api/v1/${doc}/${id}/${action}`)
      .set(auth(token))
      .set(idem(key))
      .send(body ?? {});
  const get = (token: string, doc: string, id: string) => api().get(`/api/v1/${doc}/${id}`).set(auth(token));
  const directOrder = (lines: object[], extra: object = {}) => ({
    orderDate: '2026-11-15',
    supplierId: s1,
    warehouseId: warehouse,
    lines,
    ...extra,
  });
  const invoice = (token: string) =>
    api()
      .post('/api/v1/purchase-invoices')
      .set(auth(token))
      .send({
        invoiceDate: '2026-11-15',
        supplierId: s1,
        warehouseId: warehouse,
        paymentType: 'CREDIT',
        lines: [{ itemId: itemTaxed, qty: '1', unitCost: '10' }],
      });
  const grant = (membershipId: string, permissions: object[]) =>
    api().put(`/api/v1/users/${membershipId}/purchase-permissions`).set(auth(owner)).send({ permissions });

  it(
    'setup: tenants A and B, branches, warehouses, items, suppliers and members',
    async () => {
      for (const tag of ['a', 'b']) {
        const res = await api()
          .post('/api/v1/auth/register')
          .send({ tenantName: `P12 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p12-${tag}-${RUN}@test.dev`, password: PASS });
        expect(res.status).toBe(201);
        if (tag === 'a') owner = res.body.accessToken;
        else ownerB = res.body.accessToken;
      }
      const [t] = (await db.query(
        'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
        [`P12 a ${RUN}`],
      )) as { tenantId: bigint; companyId: bigint }[];
      tenantA = String(t.tenantId);
      companyA = String(t.companyId);
      await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P12 % ${RUN}`]);
      const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantA])) as { id: bigint }[];
      mainBranch = String(main.id);
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
      warehouseB2 = String(w2.insertId);

      for (const token of [owner, ownerB]) {
        const fy = await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' });
        expect(fy.status).toBe(201);
      }
      // The new year has the phase 12 sequences (DOCUMENT_TYPE_PREFIXES).
      const seqs = (await db.query(
        "SELECT document_type, prefix FROM document_sequences WHERE tenant_id = ? AND document_type IN ('PURCHASE_REQUEST','PURCHASE_QUOTE','PURCHASE_ORDER') ORDER BY document_type",
        [tenantA],
      )) as { document_type: string; prefix: string }[];
      expect(seqs.map((s) => [s.document_type, s.prefix])).toEqual([
        ['PURCHASE_ORDER', 'PO-2026'],
        ['PURCHASE_QUOTE', 'RFQ-2026'],
        ['PURCHASE_REQUEST', 'PRQ-2026'],
      ]);

      warehouse = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W1', nameAr: 'W1' })).body.id;
      const units = await api().get('/api/v1/units').set(auth(owner));
      const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      const taxes = (await api().get('/api/v1/tax-categories').set(auth(owner))).body as { id: string; code: string }[];
      const standard = taxes.find((x) => x.code === 'STANDARD')!.id;
      const zero = taxes.find((x) => x.code === 'ZERO')!.id;
      itemTaxed = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I1', nameAr: 'صنف 1', baseUnitId: pcs, taxCategoryId: standard })).body.id;
      itemZero = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I2', nameAr: 'صنف 2', baseUnitId: pcs, taxCategoryId: zero })).body.id;
      const party = async (code: string, partyType: string) =>
        (await api().post('/api/v1/parties').set(auth(owner)).send({ code, nameAr: code, partyType })).body.id as string;
      s1 = await party('S1', 'SUPPLIER');
      s2 = await party('S2', 'BOTH');
      customer = await party('C1', 'CUSTOMER');

      const a = await addMember(BASE, owner, { email: `p12-acc-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
      acc = a.token;
      accMembership = a.membershipId;
      store = (
        await addMember(BASE, owner, {
          email: `p12-store-${RUN}@test.dev`,
          roleCode: 'STOREKEEPER',
          password: PASS,
          branchIds: [mainBranch],
          defaultBranchId: mainBranch,
        })
      ).token;
      const c = await addMember(BASE, owner, {
        email: `p12-cash-${RUN}@test.dev`,
        roleCode: 'CASHIER',
        password: PASS,
        branchIds: [mainBranch],
        defaultBranchId: mainBranch,
      });
      cashier = c.token;
      cashierMembership = c.membershipId;
      const v = await addMember(BASE, owner, { email: `p12-appr-${RUN}@test.dev`, roleCode: 'VIEWER', password: PASS });
      appr2 = v.token;
      expect((await grant(accMembership, [{ code: 'purchase.approve', amountLimit: '1000' }])).status).toBe(200);
      expect((await grant(v.membershipId, [{ code: 'purchase.approve', amountLimit: '1000' }])).status).toBe(200);
      ledgerBefore = await ledgerCounts();
    },
    T,
  );

  describe('SIMPLE: nothing of the cycle, purchase invoices as before', () => {
    it('refuses orders, requests and quotes with PROCUREMENT_LEVEL_REQUIRED', async () => {
      const po = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]));
      expect([po.status, po.body.error.code, po.body.error.details]).toEqual([409, 'PROCUREMENT_LEVEL_REQUIRED', { required: 'MEDIUM', current: 'SIMPLE' }]);
      const pr = await api().post('/api/v1/purchase-requests').set(auth(acc)).send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '1' }] });
      expect([pr.status, pr.body.error.code, pr.body.error.details.required]).toEqual([409, 'PROCUREMENT_LEVEL_REQUIRED', 'FULL']);
    });

    it('a cashier without purchase.direct still creates a purchase invoice at SIMPLE', async () => {
      expect((await invoice(cashier)).status).toBe(201);
    });

    it('the raise-level warning lists the members who buy today without purchase.direct (owner only)', async () => {
      const res = await api().get('/api/v1/users/purchase-direct-gaps').set(auth(owner));
      expect(res.status).toBe(200);
      expect((res.body as { membershipId: string; roleCode: string }[]).map((m) => [m.membershipId, m.roleCode])).toEqual([
        [accMembership, 'ACCOUNTANT'],
        [cashierMembership, 'CASHIER'],
      ]);
      expect((await api().get('/api/v1/users/purchase-direct-gaps').set(auth(acc))).status).toBe(403);
      // Nothing is granted by raising the level (checked below: the cashier is refused).
    });
  });

  describe('MEDIUM: direct purchase orders, approvals and limits', () => {
    let po1 = '';
    let po2 = '';
    let po3 = '';

    it('raising to MEDIUM grants nothing: purchase.direct is enforced on invoices for non-owners', async () => {
      expect((await setLevel(owner, 'MEDIUM')).body.procurementLevel).toBe('MEDIUM');
      const refused = await invoice(cashier);
      expect([refused.status, refused.body.error.code]).toEqual([403, 'PURCHASE_DIRECT_REQUIRED']);
      const ownerInvoice = await invoice(owner);
      expect(ownerInvoice.status).toBe(201);
      // Posting needs it too: the accountant (purchase.post, no purchase.direct) cannot post the owner's draft.
      const post = await api().post(`/api/v1/purchase-invoices/${ownerInvoice.body.id}/post`).set(auth(acc)).set(idem());
      expect([post.status, post.body.error.code]).toEqual([403, 'PURCHASE_DIRECT_REQUIRED']);
      expect((await grant(cashierMembership, [{ code: 'purchase.direct' }])).status).toBe(200);
      expect((await invoice(cashier)).status).toBe(201);
      const gaps = (await api().get('/api/v1/users/purchase-direct-gaps').set(auth(owner))).body as { membershipId: string }[];
      expect(gaps.map((m) => m.membershipId)).toEqual([accMembership]);
    });

    it('requests stay FULL-only, and an order cannot name a request at MEDIUM', async () => {
      const pr = await api().get('/api/v1/purchase-requests').set(auth(acc));
      expect(pr.status).toBe(200); // reads stay open (history)
      const res = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }], { requestId: '1' }));
      expect([res.status, res.body.error.code]).toEqual([409, 'PROCUREMENT_LEVEL_REQUIRED']);
    });

    it('creates a draft with server totals, no number, and refuses client totals', async () => {
      const res = await order(acc, directOrder([{ itemId: itemTaxed, qty: '10', unitPrice: '100' }], { expectedDate: '2026-11-30', notes: 'n' }));
      expect(res.status).toBe(201);
      po1 = res.body.id;
      expect([res.body.status, res.body.orderNo, res.body.requestId]).toEqual(['DRAFT', null, null]);
      expect([eq(res.body.netTotal, '1000'), eq(res.body.taxTotal, '160'), eq(res.body.grandTotal, '1160')]).toEqual([true, true, true]);
      expect(eq(res.body.lines[0].taxRate, '16')).toBe(true);
      expect(res.body.branchId).toBeNull(); // W1 has no branch
      const withTotal = await order(acc, { ...directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]), grandTotal: '1' });
      expect([withTotal.status, withTotal.body.error.code]).toEqual([400, 'VALIDATION']);
      const notSupplier = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }], { supplierId: customer }));
      expect([notSupplier.status, notSupplier.body.error.code]).toEqual([400, 'VALIDATION']);
      const badQty = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1.1234567', unitPrice: '1' }]));
      expect(badQty.status).toBe(400);
      // The viewer-approver has no purchase.manage.
      expect((await order(appr2, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]))).status).toBe(403);
    });

    it('edits a draft (totals recomputed), submits it, and replays the submit by its Idempotency-Key', async () => {
      const put = await api()
        .put(`/api/v1/purchase-orders/${po1}`)
        .set(auth(acc))
        .send(directOrder([{ itemId: itemTaxed, qty: '10', unitPrice: '100' }, { itemId: itemZero, qty: '2', unitPrice: '5.5', discountPct: '10' }]));
      expect(put.status).toBe(200);
      // 1000 + 16% and 2 × 5.5 − 10% = 9.9 at 0%.
      expect([eq(put.body.netTotal, '1009.9'), eq(put.body.taxTotal, '160'), eq(put.body.grandTotal, '1169.9')]).toEqual([true, true, true]);
      const noKey = await api().post(`/api/v1/purchase-orders/${po1}/submit`).set(auth(acc)).send({});
      expect(noKey.status).toBe(400);
      const key = `submit-${RUN}`;
      const first = await act(acc, 'purchase-orders', po1, 'submit', undefined, key);
      expect([first.status, first.body.status]).toEqual([201, 'SUBMITTED']);
      const replay = await act(acc, 'purchase-orders', po1, 'submit', undefined, key);
      expect([replay.status, replay.body.status, replay.body.updatedAt]).toEqual([201, 'SUBMITTED', first.body.updatedAt]);
      // A second submit with a new key is a state error, not a silent success.
      const again = await act(acc, 'purchase-orders', po1, 'submit');
      expect([again.status, again.body.error.code]).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      // A submitted order is no longer edited or deleted.
      expect((await api().put(`/api/v1/purchase-orders/${po1}`).set(auth(acc)).send(directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]))).status).toBe(409);
      expect((await api().delete(`/api/v1/purchase-orders/${po1}`).set(auth(acc))).status).toBe(409);
    });

    it('approval: never one’s own order, never above the limit; the owner approves; the number comes now', async () => {
      const self = await act(acc, 'purchase-orders', po1, 'approve');
      expect([self.status, self.body.error.code]).toEqual([403, 'APPROVAL_SELF_NOT_ALLOWED']);
      const over = await act(appr2, 'purchase-orders', po1, 'approve');
      expect([over.status, over.body.error.code, over.body.error.details]).toEqual([403, 'APPROVAL_LIMIT_EXCEEDED', { amount: '1169.900', limit: '1000.000' }]);
      const noRight = await act(cashier, 'purchase-orders', po1, 'approve');
      expect(noRight.status).toBe(403);
      expect((await get(acc, 'purchase-orders', po1)).body.orderNo).toBeNull();
      const key = `approve-${RUN}`;
      const ok = await act(owner, 'purchase-orders', po1, 'approve', undefined, key);
      expect([ok.status, ok.body.status, ok.body.orderNo]).toEqual([201, 'APPROVED', 'PO-2026-000001']);
      const replay = await act(owner, 'purchase-orders', po1, 'approve', undefined, key);
      expect([replay.status, replay.body.orderNo]).toEqual([201, 'PO-2026-000001']);
      // Approved: not edited, not deleted, not approved again.
      expect((await api().put(`/api/v1/purchase-orders/${po1}`).set(auth(acc)).send(directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]))).body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect((await act(owner, 'purchase-orders', po1, 'approve')).status).toBe(409);
    });

    it('a member approves within the limit (equal included); numbers stay gapless', async () => {
      const res = await order(acc, directOrder([{ itemId: itemTaxed, qty: '5', unitPrice: '172.413793' }]));
      // 5 × 172.413793 = 862.068965 → 862.069 net, 137.931 tax: exactly 1000.000.
      expect(eq(res.body.grandTotal, '1000')).toBe(true);
      po2 = res.body.id;
      await act(acc, 'purchase-orders', po2, 'submit');
      const ok = await act(appr2, 'purchase-orders', po2, 'approve');
      expect([ok.status, ok.body.orderNo, ok.body.approvedAt === null]).toEqual([201, 'PO-2026-000002', false]);
    });

    it('a rejection returns the order to DRAFT with the reason; cancel needs a reason and gives no number', async () => {
      po3 = (await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '10' }]))).body.id;
      await act(acc, 'purchase-orders', po3, 'submit');
      expect((await act(appr2, 'purchase-orders', po3, 'reject', {})).status).toBe(400);
      expect((await act(appr2, 'purchase-orders', po3, 'reject', { reason: '   ' })).status).toBe(400);
      const rejected = await act(appr2, 'purchase-orders', po3, 'reject', { reason: 'Price too high' });
      expect([rejected.status, rejected.body.status, rejected.body.rejectReason, rejected.body.orderNo]).toEqual([201, 'DRAFT', 'Price too high', null]);
      // Back to draft: editable, then submitted again and cancelled with a reason.
      expect((await api().put(`/api/v1/purchase-orders/${po3}`).set(auth(acc)).send(directOrder([{ itemId: itemTaxed, qty: '2', unitPrice: '10' }]))).status).toBe(200);
      await act(acc, 'purchase-orders', po3, 'submit');
      expect((await act(acc, 'purchase-orders', po3, 'cancel', {})).status).toBe(400);
      const cancelled = await act(acc, 'purchase-orders', po3, 'cancel', { reason: 'Not needed' });
      expect([cancelled.body.status, cancelled.body.cancelReason, cancelled.body.orderNo]).toEqual(['CANCELLED', 'Not needed', null]);
      // A draft is deleted, not cancelled.
      const draft = (await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '10' }]))).body.id;
      expect((await act(acc, 'purchase-orders', draft, 'cancel', { reason: 'x' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
      expect((await api().delete(`/api/v1/purchase-orders/${draft}`).set(auth(acc))).body).toEqual({ deleted: true });
    });

    it('an approved order is cancelled with a reason and keeps its number', async () => {
      const res = await act(acc, 'purchase-orders', po2, 'cancel', { reason: 'Supplier late' });
      expect([res.body.status, res.body.orderNo]).toEqual(['CANCELLED', 'PO-2026-000002']);
    });

    it('lowering to SIMPLE is refused while an order is open', async () => {
      const res = await setLevel(owner, 'SIMPLE');
      expect([res.status, res.body.error.code]).toEqual([409, 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS']);
      expect(res.body.error.details.openDocuments).toEqual({ purchaseOrders: 1 });
    });

    it('PDF of the approved order', async () => {
      const pdf = await api().get(`/api/v1/purchase-orders/${po1}/pdf`).set(auth(acc)).buffer(true);
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
    });
  });

  describe('FULL: requests, quotes, comparison and orders from requests', () => {
    let r1 = '';
    let r1Lines: { id: string; itemId: string }[] = [];
    let q1 = '';
    let q2 = '';
    let s2Order = '';
    let s1Order = '';
    let direct = '';

    it('raises to FULL; an order now needs an approved request', async () => {
      expect((await setLevel(owner, 'FULL')).body.procurementLevel).toBe('FULL');
      const res = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }]));
      expect([res.status, res.body.error.code]).toEqual([400, 'PURCHASE_REQUEST_REQUIRED']);
      // purchase.direct applies at FULL too.
      expect((await invoice(acc)).body.error.code).toBe('PURCHASE_DIRECT_REQUIRED');
    });

    it('a storekeeper creates and submits a request; it is numbered only at approval', async () => {
      const res = await api()
        .post('/api/v1/purchase-requests')
        .set(auth(store))
        .send({
          requestDate: '2026-11-15',
          neededBy: '2026-12-01',
          notes: 'For the new shop',
          lines: [
            { itemId: itemTaxed, qty: '20', estimatedPrice: '90', note: 'blue' },
            { itemId: itemZero, qty: '5' },
          ],
        });
      expect(res.status).toBe(201);
      r1 = res.body.id;
      r1Lines = (res.body.lines as { id: string; itemId: string }[]).map((l) => ({ id: l.id, itemId: l.itemId }));
      expect([res.body.status, res.body.requestNo, res.body.branchId]).toEqual(['DRAFT', null, mainBranch]);
      expect(res.body.lines.map((l: { remainingQty: string }) => eq(l.remainingQty, l === res.body.lines[0] ? '20' : '5'))).toEqual([true, true]);
      expect((await act(store, 'purchase-requests', r1, 'submit')).body.status).toBe('SUBMITTED');
      // The storekeeper cannot approve (no purchase.approve) nor quote or order.
      expect((await act(store, 'purchase-requests', r1, 'approve')).status).toBe(403);
      expect((await get(store, 'purchase-requests', r1)).body.requestNo).toBeNull();
      const ok = await act(appr2, 'purchase-requests', r1, 'approve');
      expect([ok.status, ok.body.status, ok.body.requestNo]).toEqual([201, 'APPROVED', 'PRQ-2026-000001']);
    });

    it('requests: self-approval refused, rejection, cancellation; a cashier has no request permission', async () => {
      const make = async () =>
        (await api().post('/api/v1/purchase-requests').set(auth(acc)).send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '1' }] })).body.id as string;
      expect((await api().post('/api/v1/purchase-requests').set(auth(cashier)).send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '1' }] })).status).toBe(403);
      const r2 = await make();
      await act(acc, 'purchase-requests', r2, 'submit');
      expect((await act(acc, 'purchase-requests', r2, 'approve')).body.error.code).toBe('APPROVAL_SELF_NOT_ALLOWED');
      const rej = await act(appr2, 'purchase-requests', r2, 'reject', { reason: 'Use stock on hand' });
      expect([rej.body.status, rej.body.rejectReason, rej.body.requestNo]).toEqual(['REJECTED', 'Use stock on hand', null]);
      expect((await act(owner, 'purchase-requests', r2, 'approve')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
      const r3 = await make();
      await act(acc, 'purchase-requests', r3, 'submit');
      const can = await act(acc, 'purchase-requests', r3, 'cancel', { reason: 'Duplicate' });
      expect([can.body.status, can.body.cancelReason, can.body.requestNo]).toEqual(['CANCELLED', 'Duplicate', null]);
      // A draft request is deleted.
      const r4 = await make();
      expect((await api().delete(`/api/v1/purchase-requests/${r4}`).set(auth(acc))).body).toEqual({ deleted: true });
    });

    it('quotes: one per supplier from the request lines; numbered RFQ when sent; prices on receipt', async () => {
      const c1 = await api().post('/api/v1/purchase-quotes').set(auth(acc)).send({ requestId: r1, supplierId: s1, quoteDate: '2026-11-15' });
      expect(c1.status).toBe(201);
      q1 = c1.body.id;
      expect([c1.body.status, c1.body.quoteNo, c1.body.lines.length, c1.body.branchId]).toEqual(['DRAFT', null, 2, mainBranch]);
      const c2 = await api()
        .post('/api/v1/purchase-quotes')
        .set(auth(acc))
        .send({ requestId: r1, supplierId: s2, quoteDate: '2026-11-15', lines: [{ requestLineId: r1Lines[0].id }] });
      q2 = c2.body.id;
      expect(eq(c2.body.lines[0].qty, '20')).toBe(true);
      const draftPdf = await api().get(`/api/v1/purchase-quotes/${q1}/pdf`).set(auth(acc)).buffer(true);
      expect([draftPdf.status, draftPdf.headers['content-type']]).toEqual([200, expect.stringContaining('application/pdf')]);
      // A quote needs an approved request, and lines of that request.
      const other = await api().post('/api/v1/purchase-quotes').set(auth(acc)).send({ requestId: r1, supplierId: s1, quoteDate: '2026-11-15', lines: [{ requestLineId: '999999999' }] });
      expect(other.status).toBe(404);

      expect((await act(acc, 'purchase-quotes', q1, 'receive', { lines: [] })).status).toBe(400);
      const sent1 = await act(acc, 'purchase-quotes', q1, 'send');
      expect([sent1.body.status, sent1.body.quoteNo]).toEqual(['SENT', 'RFQ-2026-000001']);
      expect((await act(acc, 'purchase-quotes', q2, 'send')).body.quoteNo).toBe('RFQ-2026-000002');

      const q1Lines = (await get(acc, 'purchase-quotes', q1)).body.lines as { id: string }[];
      const missing = await act(acc, 'purchase-quotes', q1, 'receive', { lines: [{ lineId: q1Lines[0].id, unitPrice: '95' }] });
      expect([missing.status, missing.body.error.code]).toEqual([400, 'VALIDATION']);
      const rec1 = await act(acc, 'purchase-quotes', q1, 'receive', {
        supplierRef: 'OFFER-77',
        lines: [
          { lineId: q1Lines[0].id, unitPrice: '95' },
          { lineId: q1Lines[1].id, unitPrice: '40' },
        ],
      });
      expect(rec1.body.status).toBe('RECEIVED');
      expect([eq(rec1.body.netTotal, '2100'), eq(rec1.body.taxTotal, '304'), eq(rec1.body.grandTotal, '2404')]).toEqual([true, true, true]);
      const q2Lines = (await get(acc, 'purchase-quotes', q2)).body.lines as { id: string }[];
      expect((await act(acc, 'purchase-quotes', q2, 'receive', { lines: [{ lineId: q2Lines[0].id, unitPrice: '90' }] })).body.status).toBe('RECEIVED');
      expect((await act(acc, 'purchase-quotes', q2, 'send')).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('the comparison shows the received prices per line and marks the lowest', async () => {
      const res = await api().get(`/api/v1/purchase-requests/${r1}/comparison`).set(auth(store));
      expect(res.status).toBe(200);
      const [l1, l2] = res.body.lines as { offers: { supplier: { id: string }; unitTotal: string; lowest: boolean }[] }[];
      expect(l1.offers.map((o) => [o.supplier.id, o.unitTotal, o.lowest])).toEqual([
        [s1, '110.2', false],
        [s2, '104.4', true],
      ]);
      expect(l2.offers.map((o) => [o.supplier.id, o.lowest])).toEqual([[s1, true]]);
    });

    it('«create orders»: one draft per supplier, split lines, within what is left', async () => {
      const cmp = (await api().get(`/api/v1/purchase-requests/${r1}/comparison`).set(auth(acc))).body;
      const offer = (line: number, supplier: string) =>
        (cmp.lines[line].offers as { supplier: { id: string }; quoteLineId: string }[]).find((o) => o.supplier.id === supplier)!.quoteLineId;
      const header = { orderDate: '2026-11-15', warehouseId: warehouse };
      const tooMuch = await act(acc, 'purchase-requests', r1, 'convert', {
        ...header,
        selections: [{ quoteLineId: offer(0, s2), qty: '15' }, { quoteLineId: offer(0, s1), qty: '6' }],
      });
      expect([tooMuch.status, tooMuch.body.error.code, tooMuch.body.error.details.remaining]).toEqual([409, 'PURCHASE_REQUEST_QTY_EXCEEDED', '20.000000']);
      const res = await act(acc, 'purchase-requests', r1, 'convert', {
        ...header,
        selections: [{ quoteLineId: offer(0, s2), qty: '12' }, { quoteLineId: offer(0, s1), qty: '8' }, { quoteLineId: offer(1, s1) }],
      });
      expect(res.status).toBe(201);
      const orders = res.body.orders as { id: string; supplierId: string; status: string; requestId: string; grandTotal: string; lines: unknown[] }[];
      expect(orders.map((o) => [o.supplierId, o.status, o.requestId, o.lines.length])).toEqual([
        [s2, 'DRAFT', r1, 1],
        [s1, 'DRAFT', r1, 2],
      ]);
      s2Order = orders[0].id;
      s1Order = orders[1].id;
      expect(eq(orders[0].grandTotal, '1252.8')).toBe(true); // 12 × 90 + 16%
      expect(eq(orders[1].grandTotal, '1081.6')).toBe(true); // 8 × 95 + 16%, 5 × 40 at 0%
      const req = (await get(acc, 'purchase-requests', r1)).body;
      expect(req.lines.map((l: { remainingQty: string }) => l.remainingQty)).toEqual(['0', '0']);
      const more = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1', requestLineId: r1Lines[0].id }], { requestId: r1 }));
      expect([more.status, more.body.error.code]).toEqual([409, 'PURCHASE_REQUEST_QTY_EXCEEDED']);
    });

    it('deleting a draft gives its quantity back; a direct order from the request takes it', async () => {
      expect((await api().delete(`/api/v1/purchase-orders/${s1Order}`).set(auth(acc))).body).toEqual({ deleted: true });
      const req = (await get(acc, 'purchase-requests', r1)).body;
      expect(req.lines.map((l: { remainingQty: string }) => l.remainingQty)).toEqual(['8', '5']);
      const wrongItem = await order(acc, directOrder([{ itemId: itemZero, qty: '1', unitPrice: '1', requestLineId: r1Lines[0].id }], { requestId: r1 }));
      expect([wrongItem.status, wrongItem.body.error.code]).toEqual([400, 'VALIDATION']);
      const noLine = await order(acc, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }], { requestId: r1 }));
      expect(noLine.body.error.code).toBe('PURCHASE_REQUEST_REQUIRED');
      const res = await order(
        acc,
        directOrder(
          [
            { itemId: itemTaxed, qty: '8', unitPrice: '95', requestLineId: r1Lines[0].id },
            { itemId: itemZero, qty: '5', unitPrice: '40', requestLineId: r1Lines[1].id },
          ],
          { requestId: r1 },
        ),
      );
      expect(res.status).toBe(201);
      direct = res.body.id;
      // Editing a draft gives back what it held before taking again.
      const edit = await api()
        .put(`/api/v1/purchase-orders/${direct}`)
        .set(auth(acc))
        .send(directOrder([
          { itemId: itemTaxed, qty: '8', unitPrice: '95', requestLineId: r1Lines[0].id },
          { itemId: itemZero, qty: '5', unitPrice: '40', requestLineId: r1Lines[1].id },
        ]));
      expect([edit.status, edit.body.requestId]).toEqual([200, r1]);
      expect((await get(acc, 'purchase-requests', r1)).body.lines.map((l: { orderedQty: string }) => l.orderedQty)).toEqual(['20', '5']);
    });

    it('approving the orders closes the fully ordered request and its quotes; numbers continue', async () => {
      await act(acc, 'purchase-orders', direct, 'submit');
      expect((await act(appr2, 'purchase-orders', direct, 'approve')).body.error.code).toBe('APPROVAL_LIMIT_EXCEEDED');
      expect((await act(owner, 'purchase-orders', direct, 'approve')).body.orderNo).toBe('PO-2026-000003');
      expect((await get(acc, 'purchase-requests', r1)).body.status).toBe('APPROVED'); // line 1: 8 of 20 approved
      await act(acc, 'purchase-orders', s2Order, 'submit');
      expect((await act(owner, 'purchase-orders', s2Order, 'approve')).body.orderNo).toBe('PO-2026-000004');
      const req = (await get(acc, 'purchase-requests', r1)).body;
      expect([req.status, req.closedBy]).toEqual(['CLOSED', null]);
      expect(req.quotes.map((q: { status: string }) => q.status)).toEqual(['CLOSED', 'CLOSED']);
      // A closed request takes no new quote or order.
      expect((await api().post('/api/v1/purchase-quotes').set(auth(acc)).send({ requestId: r1, supplierId: s1, quoteDate: '2026-11-15' })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('cancelling an approved order returns its quantity and reopens the automatically closed request', async () => {
      const res = await act(acc, 'purchase-orders', s2Order, 'cancel', { reason: 'Supplier cannot deliver' });
      expect([res.body.status, res.body.orderNo]).toEqual(['CANCELLED', 'PO-2026-000004']);
      const req = (await get(acc, 'purchase-requests', r1)).body;
      expect(req.status).toBe('APPROVED');
      expect(req.lines.map((l: { remainingQty: string }) => l.remainingQty)).toEqual(['12', '0']);
      // An approved request with orders is closed, not cancelled.
      expect((await act(acc, 'purchase-requests', r1, 'cancel', { reason: 'x' })).body.error.details.reason).toBe('HAS_ORDERS');
    });

    it('lowering FULL → MEDIUM is refused while requests, quotes or orders are open', async () => {
      const q3 = await api().post('/api/v1/purchase-quotes').set(auth(acc)).send({ requestId: r1, supplierId: s1, quoteDate: '2026-11-15' });
      expect(q3.status).toBe(201);
      const res = await setLevel(owner, 'MEDIUM');
      expect([res.status, res.body.error.code]).toEqual([409, 'PROCUREMENT_LEVEL_HAS_OPEN_DOCUMENTS']);
      expect(res.body.error.details.openDocuments).toEqual({ purchaseRequests: 1, purchaseQuotes: 1, purchaseOrders: 2 });
    });

    it('concurrent orders for what is left on a request line: one wins, the other is refused (§10.4)', async () => {
      const body = directOrder([{ itemId: itemTaxed, qty: '12', unitPrice: '1', requestLineId: r1Lines[0].id }], { requestId: r1 });
      const results = await Promise.all([order(acc, body), order(owner, body)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).toBe('PURCHASE_REQUEST_QTY_EXCEEDED');
      const winner = results.find((r) => r.status === 201)!.body.id as string;
      expect((await api().delete(`/api/v1/purchase-orders/${winner}`).set(auth(owner))).body).toEqual({ deleted: true });
      expect((await get(acc, 'purchase-requests', r1)).body.lines[0].remainingQty).toBe('12');
    });

    it('the ordered quantities match the order lines (integrity)', async () => {
      const off = await count(
        `SELECT COUNT(*) AS n FROM purchase_request_lines x WHERE x.tenant_id = ? AND x.ordered_qty <> COALESCE((
           SELECT SUM(ol.qty) FROM purchase_order_lines ol JOIN purchase_orders o ON o.tenant_id = ol.tenant_id AND o.id = ol.order_id
            WHERE ol.tenant_id = x.tenant_id AND ol.request_line_id = x.id AND o.status <> 'CANCELLED'), 0)`,
        [tenantA],
      );
      expect(off).toBe(0);
    });

    it('numbers: gapless, only approved (or sent) documents carry one', async () => {
      const rows = (await db.query(
        `SELECT 'PO' AS k, order_no AS no, status FROM purchase_orders WHERE tenant_id = ? AND order_no IS NOT NULL
         UNION ALL SELECT 'PRQ', request_no, status FROM purchase_requests WHERE tenant_id = ? AND request_no IS NOT NULL
         UNION ALL SELECT 'RFQ', quote_no, status FROM purchase_quotes WHERE tenant_id = ? AND quote_no IS NOT NULL ORDER BY 2`,
        [tenantA, tenantA, tenantA],
      )) as { k: string; no: string }[];
      expect(rows.map((r) => r.no)).toEqual([
        'PO-2026-000001',
        'PO-2026-000002',
        'PO-2026-000003',
        'PO-2026-000004',
        'PRQ-2026-000001',
        'RFQ-2026-000001',
        'RFQ-2026-000002',
      ]);
      const drafts = await count(
        "SELECT COUNT(*) AS n FROM purchase_orders WHERE tenant_id = ? AND status IN ('DRAFT', 'SUBMITTED') AND order_no IS NOT NULL",
        [tenantA],
      );
      expect(drafts).toBe(0);
    });
  });

  describe('branches (ADR-003) and tenant B isolation', () => {
    let rB2 = '';
    let poB2 = '';
    let poMain = '';

    it('a request in branch B2: the owner approves their own; MAIN-only members cannot see or touch it', async () => {
      const res = await api()
        .post('/api/v1/purchase-requests')
        .set(auth(owner))
        .set('X-Branch-Id', b2Branch)
        .send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '3' }] });
      expect([res.status, res.body.branchId]).toEqual([201, b2Branch]);
      rB2 = res.body.id;
      await act(owner, 'purchase-requests', rB2, 'submit');
      expect((await act(owner, 'purchase-requests', rB2, 'approve')).body.requestNo).toBe('PRQ-2026-000002'); // owner: own document allowed
      expect((await get(store, 'purchase-requests', rB2)).status).toBe(404);
      const list = (await api().get('/api/v1/purchase-requests').set(auth(store))).body.items as { id: string }[];
      expect(list.map((r) => r.id)).not.toContain(rB2);
      expect((await api().get(`/api/v1/purchase-requests/${rB2}/comparison`).set(auth(store))).status).toBe(404);
      expect((await act(store, 'purchase-requests', rB2, 'close')).status).toBe(403); // no purchase.manage either way
      const poFromB2 = await order(acc, directOrder([{ itemId: itemTaxed, qty: '3', unitPrice: '10', requestLineId: (await get(acc, 'purchase-requests', rB2)).body.lines[0].id }], { requestId: rB2, warehouseId: warehouseB2 }));
      expect([poFromB2.status, poFromB2.body.branchId]).toEqual([201, b2Branch]);
      poB2 = poFromB2.body.id;
    });

    it('a MAIN-only cashier: no B2 order in reads, no write on it, no order into the B2 warehouse', async () => {
      expect((await get(cashier, 'purchase-orders', poB2)).status).toBe(404);
      expect((await act(cashier, 'purchase-orders', poB2, 'submit')).status).toBe(404);
      expect((await api().delete(`/api/v1/purchase-orders/${poB2}`).set(auth(cashier))).status).toBe(404);
      const items = (await api().get('/api/v1/purchase-orders').set(auth(cashier))).body.items as { id: string }[];
      expect(items.map((o) => o.id)).not.toContain(poB2);
      const r1 = (await api().get('/api/v1/purchase-requests?status=APPROVED').set(auth(cashier))).body.items as { id: string }[];
      const mainReq = r1.find((r) => r.id !== rB2)!.id;
      const line = (await get(cashier, 'purchase-requests', mainReq)).body.lines[0].id;
      const intoB2 = await order(cashier, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1', requestLineId: line }], { requestId: mainReq, warehouseId: warehouseB2 }));
      expect([intoB2.status, intoB2.body.error.code]).toEqual([403, 'BRANCH_NOT_ALLOWED']);
      const ok = await order(cashier, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1', requestLineId: line }], { requestId: mainReq }));
      expect(ok.status).toBe(201);
      poMain = ok.body.id;
      // The B2 request is out of the cashier's reach for orders too.
      const fromB2 = await order(cashier, directOrder([{ itemId: itemTaxed, qty: '1', unitPrice: '1', requestLineId: '1' }], { requestId: rB2 }));
      expect(fromB2.status).toBe(403);
    });

    it('tenant B sees none of A and changes none of it, at any level', async () => {
      expect((await setLevel(ownerB, 'FULL')).status).toBe(200);
      for (const [doc, id] of [
        ['purchase-orders', poMain],
        ['purchase-requests', rB2],
      ] as const) {
        expect([doc, (await get(ownerB, doc, id)).status]).toEqual([doc, 404]);
      }
      const quotes = (await api().get('/api/v1/purchase-quotes').set(auth(ownerA()))).body.items as { id: string }[];
      expect((await get(ownerB, 'purchase-quotes', quotes[0].id)).status).toBe(404);
      expect((await api().get(`/api/v1/purchase-quotes/${quotes[0].id}/pdf`).set(auth(ownerB))).status).toBe(404);
      expect((await api().get(`/api/v1/purchase-orders/${poMain}/pdf`).set(auth(ownerB))).status).toBe(404);
      expect((await api().get(`/api/v1/purchase-requests/${rB2}/comparison`).set(auth(ownerB))).status).toBe(404);
      for (const path of ['purchase-orders', 'purchase-requests', 'purchase-quotes']) {
        expect([path, (await api().get(`/api/v1/${path}`).set(auth(ownerB))).body.total]).toEqual([path, 0]);
      }
      expect((await act(ownerB, 'purchase-orders', poMain, 'submit')).status).toBe(404);
      expect((await act(ownerB, 'purchase-orders', poMain, 'cancel', { reason: 'x' })).status).toBe(404);
      expect((await act(ownerB, 'purchase-requests', rB2, 'close')).status).toBe(404);
      expect((await act(ownerB, 'purchase-requests', rB2, 'convert', { orderDate: '2026-11-15', warehouseId: warehouse, selections: [{ quoteLineId: '1' }] })).status).toBe(404);
      expect((await api().put(`/api/v1/purchase-requests/${rB2}`).set(auth(ownerB)).send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '1' }] })).status).toBe(404);
      expect((await api().delete(`/api/v1/purchase-quotes/${quotes[0].id}`).set(auth(ownerB))).status).toBe(404);
      // A's supplier, item and warehouse are not B's.
      const withA = await api().post('/api/v1/purchase-requests').set(auth(ownerB)).send({ requestDate: '2026-11-15', lines: [{ itemId: itemTaxed, qty: '1' }] });
      expect(withA.status).toBe(404);
      // B's level is B's: A's open documents do not hold it.
      expect((await setLevel(ownerB, 'SIMPLE')).status).toBe(200);
      expect((await get(owner, 'purchase-orders', poMain)).status).toBe(200);
    });

    // The owner of A, by token (kept in a function so the table above reads plainly).
    function ownerA() {
      return owner;
    }
  });

  describe('suppliers in use (ADR-021) and the acceptance rule', () => {
    it('a supplier on a quote or an order is deactivated, never deleted', async () => {
      const res = await api().patch(`/api/v1/parties/${s2}/deactivate`).set(auth(owner));
      expect([res.status, res.body]).toEqual([200, { deactivated: true }]);
      const s3 = (await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'S3', nameAr: 'S3', partyType: 'SUPPLIER' })).body.id;
      // The approved MAIN request still has something left to quote (the B2 one is fully ordered).
      const approved = (await api().get('/api/v1/purchase-requests?status=APPROVED').set(auth(cashier))).body.items as { id: string }[];
      const draftOnly = await api()
        .post('/api/v1/purchase-quotes')
        .set(auth(acc))
        .send({ requestId: approved[0].id, supplierId: s3, quoteDate: '2026-11-15' });
      expect(draftOnly.status).toBe(201);
      expect((await api().patch(`/api/v1/parties/${s3}/deactivate`).set(auth(owner))).body).toEqual({ deactivated: true });
      const s4 = (await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'S4', nameAr: 'S4', partyType: 'SUPPLIER' })).body.id;
      expect((await api().patch(`/api/v1/parties/${s4}/deactivate`).set(auth(owner))).body).toEqual({ deleted: true });
      // An inactive supplier takes no new order.
      const inactive = await api().post('/api/v1/purchase-quotes').set(auth(acc)).send({ requestId: draftOnly.body.requestId, supplierId: s2, quoteDate: '2026-11-15' });
      expect([inactive.status, inactive.body.error.code]).toEqual([400, 'VALIDATION']);
    });

    it('ACCEPTANCE: no journal entry and no stock movement from any phase 12 document', async () => {
      expect(await ledgerCounts()).toEqual(ledgerBefore);
      expect(ledgerBefore).toEqual({ journal: 0, lines: 0, movements: 0, balances: 0 });
      const approved = await count("SELECT COUNT(*) AS n FROM purchase_orders WHERE tenant_id = ? AND status = 'APPROVED'", [tenantA]);
      expect(approved).toBeGreaterThanOrEqual(2);
      const fromCycle = await count(
        "SELECT COUNT(*) AS n FROM journal_entries WHERE source_type IN ('PURCHASE_ORDER', 'PURCHASE_REQUEST', 'PURCHASE_QUOTE')",
        [],
      );
      expect(fromCycle).toBe(0);
    });

    it('every transition was audited', async () => {
      const actions = (await db.query(
        "SELECT DISTINCT action FROM audit_logs WHERE tenant_id = ? AND (action LIKE 'purchase\\_order.%' OR action LIKE 'purchase\\_request.%' OR action LIKE 'purchase\\_quote.%') ORDER BY action",
        [tenantA],
      )) as { action: string }[];
      expect(actions.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'purchase_order.approve',
          'purchase_order.cancel',
          'purchase_order.create',
          'purchase_order.delete',
          'purchase_order.reject',
          'purchase_order.submit',
          'purchase_order.update',
          'purchase_quote.create',
          'purchase_quote.receive',
          'purchase_quote.send',
          'purchase_request.approve',
          'purchase_request.cancel',
          'purchase_request.close',
          'purchase_request.reject',
          'purchase_request.submit',
        ]),
      );
    });
  });

  it('response audit: every documented answer matched its schema (ADR-023)', () => {
    const findings = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').split('\n').filter(Boolean) : [];
    expect(findings).toEqual([]);
  });
});
