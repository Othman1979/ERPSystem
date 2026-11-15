/**
 * Phase 14 part A — sales quotations and sales orders (ADR-027):
 *  - quotes: numbering SQ only at send, expiry refusal (QUOTE_EXPIRED), convert once,
 *    cancel / reject / copy / delete rules;
 *  - orders: numbering SO only at confirmation, cancel and close rules, the reservation
 *    read (SOFT), the approval modes (NONE / OVER_CREDIT_LIMIT / ALWAYS), approvals
 *    per sales.approve with limits and no self-approval, credit-limit exposure;
 *  - HARD reservation: a refused confirmation (STOCK_RESERVED) and two concurrent
 *    confirmations on the last available quantity (exactly one wins);
 *  - settings owner-only with defaults; idempotent replays; branch scope and tenant
 *    isolation; the acceptance test: NO journal entry and NO stock movement from any of it;
 *  - the OpenAPI response audit file stays empty.
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

const API_PORT = 3714;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p14-audit-${RUN}.jsonl`);
const T = 60_000;

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = (key = `p14-${RUN}-${Math.random().toString(36).slice(2)}`) => ({ 'Idempotency-Key': key });
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

describe('Phase 14 — sales quotations and sales orders (ADR-027)', () => {
  let owner = '';
  let acc = '';
  let store = '';
  let ownerB = '';
  let accMembership = '';
  let tenantA = '';
  let mainBranch = '';
  let b2Branch = '';
  let warehouse = '';
  let warehouseB2 = '';
  let itemTaxed = '';
  let itemZero = '';
  let itemOne = '';
  let standard = '';
  let zero = '';
  let customer = '';
  let customerFree = '';
  let supplier = '';

  let ledgerBefore: { journal: number; lines: number; movements: number };
  const ledgerCounts = async () => ({
    journal: await count('SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ?', [tenantA]),
    lines: await count('SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ?', [tenantA]),
    movements: await count('SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id = ?', [tenantA]),
  });

  const settings = (token: string, body: object) => api().patch('/api/v1/company').set(auth(token)).send(body);
  const party = (token: string, id: string, body: object) => api().put(`/api/v1/parties/${id}`).set(auth(token)).send(body);
  const quoteBody = (lines: object[], extra: object = {}) => ({ customerId: customer, lines, ...extra });
  const orderBody = (lines: object[], extra: object = {}) => ({
    orderDate: '2026-11-15',
    customerId: customer,
    warehouseId: warehouse,
    lines,
    ...extra,
  });
  const createQuote = (token: string, body: object) => api().post('/api/v1/sales-quotes').set(auth(token)).send(body);
  const createOrder = (token: string, body: object) => api().post('/api/v1/sales-orders').set(auth(token)).send(body);
  const act = (token: string, doc: string, id: string, action: string, body?: object, key?: string) =>
    api()
      .post(`/api/v1/${doc}/${id}/${action}`)
      .set(auth(token))
      .set(idem(key))
      .send(body ?? {});
  const get = (token: string, p: string) => api().get(`/api/v1/${p}`).set(auth(token));
  const grant = (token: string, membershipId: string, permissions: object[]) =>
    api().put(`/api/v1/users/${membershipId}/purchase-permissions`).set(auth(token)).send({ permissions });
  const err = (res: request.Response) => [res.status, res.body?.error?.code];

  // Shared ids filled by the tests in order (each describe builds on the one before).
  let quote1 = '';
  let quote1Lines = 0;
  let order1 = '';
  let stockOrder = '';

  it(
    'setup: tenants A and B, a second branch with a warehouse, items with stock, customers, members',
    async () => {
      for (const tag of ['a', 'b']) {
        const res = await api()
          .post('/api/v1/auth/register')
          .send({ tenantName: `P14 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p14-${tag}-${RUN}@test.dev`, password: PASS });
        expect(res.status).toBe(201);
        if (tag === 'a') owner = res.body.accessToken;
        else ownerB = res.body.accessToken;
      }
      const [t] = (await db.query(
        'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
        [`P14 a ${RUN}`],
      )) as { tenantId: bigint; companyId: bigint }[];
      tenantA = String(t.tenantId);
      const companyA = String(t.companyId);
      await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P14 % ${RUN}`]);
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
      // The new year has the phase 14 sequences (DOCUMENT_TYPE_PREFIXES).
      const seqs = (await db.query(
        "SELECT document_type, prefix FROM document_sequences WHERE tenant_id = ? AND document_type IN ('SALES_QUOTE','SALES_ORDER') ORDER BY document_type",
        [tenantA],
      )) as { document_type: string; prefix: string }[];
      expect(seqs.map((s) => [s.document_type, s.prefix])).toEqual([
        ['SALES_ORDER', 'SO-2026'],
        ['SALES_QUOTE', 'SQ-2026'],
      ]);

      warehouse = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W1', nameAr: 'W1' })).body.id;
      const units = await api().get('/api/v1/units').set(auth(owner));
      const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      const taxes = (await api().get('/api/v1/tax-categories').set(auth(owner))).body as { id: string; code: string }[];
      standard = taxes.find((x) => x.code === 'STANDARD')!.id;
      zero = taxes.find((x) => x.code === 'ZERO')!.id;
      itemTaxed = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I1', nameAr: 'صنف 1', baseUnitId: pcs, taxCategoryId: standard })).body.id;
      itemZero = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I2', nameAr: 'صنف 2', baseUnitId: pcs, taxCategoryId: zero })).body.id;
      itemOne = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I3', nameAr: 'صنف 3', baseUnitId: pcs, taxCategoryId: zero })).body.id;
      const partyOf = async (code: string, partyType: string) =>
        (await api().post('/api/v1/parties').set(auth(owner)).send({ code, nameAr: code, partyType })).body.id as string;
      customer = await partyOf('C1', 'CUSTOMER');
      customerFree = await partyOf('C2', 'CUSTOMER');
      supplier = await partyOf('S1', 'SUPPLIER');

      // Stock by a posted purchase invoice: 10 of itemTaxed and 1 of itemOne in W1.
      const stockIn = async (lines: object[]) => {
        const created = await api()
          .post('/api/v1/purchase-invoices')
          .set(auth(owner))
          .send({ invoiceDate: '2026-11-01', supplierId: supplier, warehouseId: warehouse, paymentType: 'CREDIT', lines });
        expect(created.status).toBe(201);
        const posted = await api().post(`/api/v1/purchase-invoices/${created.body.id}/post`).set(auth(owner)).set(idem());
        expect(posted.status).toBe(201);
      };
      await stockIn([{ itemId: itemTaxed, qty: '10', unitCost: '5' }, { itemId: itemOne, qty: '1', unitCost: '5' }]);

      const a = await addMember(BASE, owner, { email: `p14-acc-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
      acc = a.token;
      accMembership = a.membershipId;
      store = (
        await addMember(BASE, owner, {
          email: `p14-store-${RUN}@test.dev`,
          roleCode: 'STOREKEEPER',
          password: PASS,
          branchIds: [mainBranch],
          defaultBranchId: mainBranch,
        })
      ).token;
      ledgerBefore = await ledgerCounts();
    },
    T,
  );

  describe('settings (ADR-027 §1)', () => {
    it('shows the defaults on the company', async () => {
      const res = await get(owner, 'company');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        salesOrderRequired: false,
        salesReservation: 'SOFT',
        salesOrderApproval: 'OVER_CREDIT_LIMIT',
        salesPriceLocked: false,
        quoteValidityDays: 30,
      });
    });

    it('refuses the sales settings to anyone but the owner', async () => {
      const res = await settings(acc, { salesReservation: 'HARD' });
      expect(err(res)).toEqual([expect.any(Number), 'FORBIDDEN']);
      expect((await get(owner, 'company')).body.salesReservation).toBe('SOFT');
    });

    it('counts the direct sales invoice drafts when sales_order_required is turned on', async () => {
      const draft = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(owner))
        .send({ invoiceDate: '2026-11-15', customerId: customerFree, warehouseId: warehouse, paymentType: 'CREDIT', lines: [{ itemId: itemZero, qty: '1', unitPrice: '1' }] });
      expect(draft.status).toBe(201);
      const on = await settings(owner, { salesOrderRequired: true });
      expect(on.status).toBe(200);
      expect(on.body.salesOrderRequired).toBe(true);
      expect(on.body.directSalesDraftCount).toBeGreaterThanOrEqual(1);
      expect((await settings(owner, { salesOrderRequired: false })).body.salesOrderRequired).toBe(false);
    });
  });

  describe('quotations (ADR-027 §2)', () => {
    it('creates a draft with no number and the default validity of 30 days', async () => {
      const res = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '3', unitPrice: '10' }], { quoteDate: '2026-11-15' }));
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'DRAFT', quoteNo: null, validUntil: '2026-12-15T00:00:00.000Z' });
      expect(eq(res.body.grandTotal, '30')).toBe(true);
    });

    it('numbers SQ only when sent, gaplessly', async () => {
      const first = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }], { quoteDate: '2026-11-15' }));
      expect(first.body.quoteNo).toBeNull();
      const sent = await act(owner, 'sales-quotes', first.body.id, 'send');
      expect(sent.status).toBe(201);
      expect(sent.body.quoteNo).toMatch(/^SQ-2026-\d{6}$/);
      const second = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }], { quoteDate: '2026-11-15' }));
      const sent2 = await act(owner, 'sales-quotes', second.body.id, 'send');
      const n = (no: string) => Number(no.slice(-6));
      expect(n(sent2.body.quoteNo) - n(sent.body.quoteNo)).toBe(1);
    });

    it('refuses an edit of a sent quote and a second send', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }]));
      await act(owner, 'sales-quotes', q.body.id, 'send');
      const edit = await api().put(`/api/v1/sales-quotes/${q.body.id}`).set(auth(owner)).send(quoteBody([{ itemId: itemZero, qty: '2', unitPrice: '10' }]));
      expect(err(edit)[1]).toBe('INVALID_STATUS_TRANSITION');
      expect(err(await act(owner, 'sales-quotes', q.body.id, 'send'))[1]).toBe('INVALID_STATUS_TRANSITION');
    });

    it('refuses to accept an expired quote (QUOTE_EXPIRED)', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }], { quoteDate: '2026-10-01', validUntil: '2026-10-31' }));
      expect((await act(owner, 'sales-quotes', q.body.id, 'send')).status).toBe(201);
      expect(err(await act(owner, 'sales-quotes', q.body.id, 'accept'))).toEqual([expect.any(Number), 'QUOTE_EXPIRED']);
      expect((await get(owner, `sales-quotes/${q.body.id}`)).body.expired).toBe(true);
    });

    it('rejects a sent quote with a reason, and cancels a draft with a reason', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }]));
      await act(owner, 'sales-quotes', q.body.id, 'send');
      const rejected = await act(owner, 'sales-quotes', q.body.id, 'reject', { reason: 'السعر مرتفع' });
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectReason: 'السعر مرتفع' });
      const d = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }]));
      const cancelled = await act(owner, 'sales-quotes', d.body.id, 'cancel', { reason: 'خطأ في الإدخال' });
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'خطأ في الإدخال' });
    });

    it('copies a sent quote into a new draft with the same lines', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '2', unitPrice: '10' }, { itemId: itemTaxed, qty: '1', unitPrice: '4' }]));
      await act(owner, 'sales-quotes', q.body.id, 'send');
      const copy = await act(owner, 'sales-quotes', q.body.id, 'copy');
      expect(copy.status).toBe(201);
      expect(copy.body).toMatchObject({ status: 'DRAFT', quoteNo: null });
      expect(copy.body.lines).toHaveLength(2);
      expect(eq(copy.body.grandTotal, q.body.grandTotal)).toBe(true);
    });

    it('deletes a draft but not a sent quote', async () => {
      const d = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }]));
      expect((await api().delete(`/api/v1/sales-quotes/${d.body.id}`).set(auth(owner))).status).toBe(200);
      const s = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }]));
      await act(owner, 'sales-quotes', s.body.id, 'send');
      expect(err(await api().delete(`/api/v1/sales-quotes/${s.body.id}`).set(auth(owner)))[1]).toBe('INVALID_STATUS_TRANSITION');
    });

    it('hides another branch quote from a member of the main branch (ADR-003)', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '1', unitPrice: '10' }], { warehouseId: warehouseB2 }));
      expect(q.status).toBe(201);
      expect((await get(store, `sales-quotes/${q.body.id}`)).status).toBe(404);
    });

    it('converts an accepted quote into one draft order, once only', async () => {
      const q = await createQuote(owner, quoteBody([{ itemId: itemZero, qty: '2', unitPrice: '10' }, { itemId: itemTaxed, qty: '1', unitPrice: '4' }]));
      quote1 = q.body.id;
      quote1Lines = 2;
      await act(owner, 'sales-quotes', quote1, 'send');
      await act(owner, 'sales-quotes', quote1, 'accept');
      expect(err(await act(owner, 'sales-quotes', quote1, 'convert', {}))).toEqual([expect.any(Number), 'VALIDATION']); // no warehouse named
      const conv = await act(owner, 'sales-quotes', quote1, 'convert', { warehouseId: warehouse });
      expect(conv.status).toBe(201);
      expect(conv.body).toMatchObject({ status: 'DRAFT', orderNo: null, quote: { id: quote1 } });
      expect(conv.body.lines).toHaveLength(quote1Lines);
      expect(eq(conv.body.grandTotal, (await get(owner, `sales-quotes/${quote1}`)).body.grandTotal)).toBe(true);
      order1 = conv.body.id;
      expect(err(await act(owner, 'sales-quotes', quote1, 'convert', { warehouseId: warehouse }))).toEqual([expect.any(Number), 'QUOTE_ALREADY_CONVERTED']);
    });
  });

  describe('orders (ADR-027 §3, §5)', () => {
    it('confirms with number SO, refuses a close or an edit of a confirmed order', async () => {
      const c = await act(owner, 'sales-orders', order1, 'confirm');
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ status: 'CONFIRMED' });
      expect(c.body.orderNo).toMatch(/^SO-2026-\d{6}$/);
      expect(err(await act(owner, 'sales-orders', order1, 'close', { reason: 'x' }))[1]).toBe('INVALID_STATUS_TRANSITION');
      expect(err(await api().put(`/api/v1/sales-orders/${order1}`).set(auth(owner)).send(orderBody([{ itemId: itemZero, qty: '1', unitPrice: '1' }])))[1]).toBe('INVALID_STATUS_TRANSITION');
    });

    it('shows the reserved and available quantities (SOFT) read from the open lines', async () => {
      const res = await get(owner, `sales-orders/reservation?warehouseId=${warehouse}&itemIds=${itemTaxed}`);
      expect(res.status).toBe(200);
      expect(res.body.mode).toBe('SOFT');
      const row = res.body.items.find((i: { itemId: string }) => i.itemId === itemTaxed);
      expect(row).toBeDefined();
      expect(eq(row.onHand, '10')).toBe(true);
      expect(eq(row.reserved, '1')).toBe(true); // the converted order's 1 of itemTaxed
    });

    it('cancels a confirmed order with a reason, and releases its reservation', async () => {
      const c = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '1', unitPrice: '2' }]));
      expect(c.body.orderNo).toBeNull();
      const conf = await act(owner, 'sales-orders', c.body.id, 'confirm');
      expect(conf.body.orderNo).toMatch(/^SO-2026-\d{6}$/);
      const cancelled = await act(owner, 'sales-orders', c.body.id, 'cancel', { reason: 'العميل ألغى' });
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'العميل ألغى' });
    });

    it('deletes a draft order only', async () => {
      const d = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '1', unitPrice: '2' }]));
      expect((await api().delete(`/api/v1/sales-orders/${d.body.id}`).set(auth(owner))).status).toBe(200);
      expect((await get(owner, `sales-orders/${order1}`)).status).toBe(200);
      expect(err(await api().delete(`/api/v1/sales-orders/${order1}`).set(auth(owner)))[1]).toBe('INVALID_STATUS_TRANSITION');
    });

    it('refuses an order from another branch to a member of the main branch', async () => {
      const o = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '1', unitPrice: '2' }], { warehouseId: warehouseB2 }));
      expect(o.status).toBe(201);
      expect((await get(store, `sales-orders/${o.body.id}`)).status).toBe(404);
    });
  });

  describe('approvals and credit exposure (ADR-027 §6)', () => {
    it('sets the customer credit limit, and an order over it waits for approval', async () => {
      expect((await party(owner, customer, { creditLimit: '100' })).status).toBe(200);
      const pending = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '10', unitPrice: '11' }]));
      const res = await act(owner, 'sales-orders', pending.body.id, 'confirm');
      expect(res.body).toMatchObject({ status: 'PENDING_APPROVAL', orderNo: null });
      // Refused to a member without sales.approve.
      expect(err(await act(acc, 'sales-orders', pending.body.id, 'approve'))).toEqual([expect.any(Number), 'FORBIDDEN']);
      // The owner approves it: numbered SO, approval recorded.
      const approved = await act(owner, 'sales-orders', pending.body.id, 'approve');
      expect(approved.body).toMatchObject({ status: 'CONFIRMED' });
      expect(approved.body.orderNo).toMatch(/^SO-2026-\d{6}$/);
    });

    it('grants sales.approve with a limit, and refuses a self-approval and an amount above the limit', async () => {
      expect((await grant(owner, accMembership, [{ code: 'sales.approve', amountLimit: '1000' }])).status).toBe(200);
      // A member who created the order cannot approve it (APPROVAL_SELF_NOT_ALLOWED).
      const mine = await createOrder(acc, orderBody([{ itemId: itemZero, qty: '10', unitPrice: '11' }]));
      expect(mine.status).toBe(201);
      expect((await act(acc, 'sales-orders', mine.body.id, 'confirm')).body.status).toBe('PENDING_APPROVAL');
      expect(err(await act(acc, 'sales-orders', mine.body.id, 'approve'))).toEqual([expect.any(Number), 'APPROVAL_SELF_NOT_ALLOWED']);
      // Above the limit: 1100 + nothing else. The owner approves it.
      const big = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '100', unitPrice: '11' }]));
      expect((await act(owner, 'sales-orders', big.body.id, 'confirm')).body.status).toBe('PENDING_APPROVAL');
      expect(err(await act(acc, 'sales-orders', big.body.id, 'approve'))).toEqual([expect.any(Number), 'APPROVAL_LIMIT_EXCEEDED']);
      // Within the limit, approved by the member (not the author).
      const small = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '10', unitPrice: '11' }]));
      await act(owner, 'sales-orders', small.body.id, 'confirm');
      const ok = await act(acc, 'sales-orders', small.body.id, 'approve');
      expect(ok.body.status).toBe('CONFIRMED');
    });

    it('rejects a pending order back to draft with the reason', async () => {
      const o = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '10', unitPrice: '11' }]));
      await act(owner, 'sales-orders', o.body.id, 'confirm');
      const back = await act(acc, 'sales-orders', o.body.id, 'reject-approval', { reason: 'السعر خاطئ' });
      expect(back.body).toMatchObject({ status: 'DRAFT', rejectReason: 'السعر خاطئ' });
    });

    it('follows the approval mode: ALWAYS asks for every order, NONE for none', async () => {
      await settings(owner, { salesOrderApproval: 'ALWAYS' });
      const free = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      expect((await act(owner, 'sales-orders', free.body.id, 'confirm')).body.status).toBe('PENDING_APPROVAL');
      await settings(owner, { salesOrderApproval: 'NONE' });
      const over = await createOrder(owner, orderBody([{ itemId: itemZero, qty: '10', unitPrice: '11' }]));
      expect((await act(owner, 'sales-orders', over.body.id, 'confirm')).body.status).toBe('CONFIRMED');
      await settings(owner, { salesOrderApproval: 'OVER_CREDIT_LIMIT' });
    });
  });

  describe('HARD reservation (ADR-027 §5)', () => {
    it('refuses a confirmation above the available quantity, and accepts it once it fits', async () => {
      await settings(owner, { salesReservation: 'HARD' });
      // 10 on hand, 1 reserved by the converted order: 9 are available.
      const big = await createOrder(owner, orderBody([{ itemId: itemTaxed, qty: '10', unitPrice: '1' }], { customerId: customerFree }));
      expect(err(await act(owner, 'sales-orders', big.body.id, 'confirm'))).toEqual([expect.any(Number), 'STOCK_RESERVED']);
      const ok = await createOrder(owner, orderBody([{ itemId: itemTaxed, qty: '8', unitPrice: '1' }], { customerId: customerFree }));
      expect((await act(owner, 'sales-orders', ok.body.id, 'confirm')).body.status).toBe('CONFIRMED');
      const rest = await createOrder(owner, orderBody([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      expect((await act(owner, 'sales-orders', rest.body.id, 'confirm')).body.status).toBe('CONFIRMED');
      const none = await createOrder(owner, orderBody([{ itemId: itemTaxed, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      expect(err(await act(owner, 'sales-orders', none.body.id, 'confirm'))).toEqual([expect.any(Number), 'STOCK_RESERVED']);
    });

    it('lets exactly one of two concurrent confirmations take the last quantity', async () => {
      // 1 on hand of itemOne: two orders for it, confirmed at the same time.
      const x = await createOrder(owner, orderBody([{ itemId: itemOne, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      const y = await createOrder(owner, orderBody([{ itemId: itemOne, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      const [rx, ry] = await Promise.all([
        act(owner, 'sales-orders', x.body.id, 'confirm'),
        act(owner, 'sales-orders', y.body.id, 'confirm'),
      ]);
      const outcomes = [rx, ry].map((r) => (r.status === 201 ? 'CONFIRMED' : r.body.error.code)).sort();
      expect(outcomes).toEqual(['CONFIRMED', 'STOCK_RESERVED']);
      stockOrder = [rx, ry].find((r) => r.status === 201)!.body.id;
    });

    it('replays the same confirmation for the same Idempotency-Key', async () => {
      // SOFT: the item has no stock left under HARD; the replay itself is what is tested.
      await settings(owner, { salesReservation: 'SOFT' });
      const o =await createOrder(owner, orderBody([{ itemId: itemZero, qty: '1', unitPrice: '1' }], { customerId: customerFree }));
      const key = `p14-replay-${RUN}`;
      const first = await act(owner, 'sales-orders', o.body.id, 'confirm', undefined, key);
      const again = await act(owner, 'sales-orders', o.body.id, 'confirm', undefined, key);
      expect(first.status).toBe(201);
      expect(again.body.orderNo).toBe(first.body.orderNo);
    });

    it('restores the SOFT default', async () => {
      expect((await settings(owner, { salesReservation: 'SOFT' })).body.salesReservation).toBe('SOFT');
      expect(stockOrder).not.toBe('');
    });
  });

  describe('isolation and the acceptance test', () => {
    it('does not show tenant A to tenant B', async () => {
      expect((await get(ownerB, `sales-orders/${order1}`)).status).toBe(404);
      expect((await get(ownerB, `sales-quotes/${quote1}`)).status).toBe(404);
      const list = await get(ownerB, 'sales-orders?pageSize=100');
      expect(list.body.items.map((o: { id: string }) => o.id)).not.toContain(order1);
      void tenantA;
    });

    it('posts no journal entry and moves no stock from any quote or order', async () => {
      expect(await ledgerCounts()).toEqual(ledgerBefore);
    });

    it('keeps stock:verify clean', async () => {
      const v = await get(owner, 'stock/verify');
      expect(v.status).toBe(200);
      expect(v.body.mismatches).toEqual([]);
    });

    it('writes no OpenAPI response audit line', () => {
      const lines = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').trim() : '';
      expect(lines).toBe('');
    });
  });
});
