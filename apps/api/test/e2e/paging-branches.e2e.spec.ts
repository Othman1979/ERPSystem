/**
 * Paging and branch-scoped reads (ADR-022, ADR-003 update 2026-11-14).
 * Template for every converted list: one describe block per endpoint covering
 *  - numbered pages: page, total, filters, search, sort stability, a page past
 *    the end, and bad paging parameters (400 VALIDATION);
 *  - branch scope: an ACCOUNTANT limited to MAIN sees only MAIN's documents in
 *    the list, and another branch's document answers 404 on GET and /pdf;
 *  - tenant isolation: tenant B sees none of A's documents.
 * Tenant A has branches MAIN and B2, one warehouse on each, and 25 sales
 * invoices (15 on MAIN, 10 on B2) over five dates, so equal dates test the
 * id tie-break. Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3231;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `pg-${RUN}-${Math.random().toString(36).slice(2)}` });

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
    database: TEST_DB_NAME,
  });
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
});

interface InvoiceRow {
  id: string;
  invoiceNo: string | null;
  invoiceDate: string;
  branchId: string | null;
  customerId: string;
  status: string;
  grandTotal: string;
  outstanding: string;
}
interface PageBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

const INVOICES = 25;
const ON_MAIN = 15;
const POSTED = [0, 1, 2, 15, 16]; // three on MAIN, two on B2

describe('Paging and branch-scoped reads (ADR-022, ADR-003)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let alphaId = '';
  const invoiceIds: string[] = [];
  const branchOf = new Map<string, string>();

  const list = async (token: string, query = '') => {
    const res = await api().get(`/api/v1/sales-invoices${query}`).set(auth(token));
    if (res.status !== 200) throw new Error(`list ${query}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as PageBody<InvoiceRow>;
  };
  /** Every page of a query, `size` rows at a time. */
  const allPages = async (token: string, query: string, size: number) => {
    const rows: InvoiceRow[] = [];
    for (let page = 1; ; page += 1) {
      const body = await list(token, `?${query}&pageSize=${size}&page=${page}`);
      rows.push(...body.items);
      if (body.items.length < size) return { rows, total: body.total };
    }
  };

  it('setup: tenant A with MAIN and B2, 25 invoices, an ACCOUNTANT on MAIN only, tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Paging ${RUN}`, ownerName: 'Owner', email: `paging-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Paging B ${RUN}`, ownerName: 'Owner B', email: `paging-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Paging ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch; add B2 directly (as branch-access.e2e does).
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);
    // Two warehouses (one per branch) need the BASIC plan; TRIAL allows one.
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'BASIC') WHERE id = ?", [t.tenantId]);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    const wh = async (code: string, branchId: string) => {
      const res = await api().post('/api/v1/warehouses').set(auth(owner)).send({ code, nameAr: code, branchId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    const w1 = await wh('W1', mainId);
    const w2 = await wh('W2', b2Id);
    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs }))
      .body.id as string;
    const customer = async (code: string, nameAr: string) =>
      (await api().post('/api/v1/parties').set(auth(owner)).send({ code, nameAr, partyType: 'CUSTOMER' })).body
        .id as string;
    alphaId = await customer('CA', `Alpha ${RUN}`);
    const betaId = await customer('CB', `Beta ${RUN}`);
    for (const [warehouseId, branch] of [
      [w1, mainId],
      [w2, b2Id],
    ]) {
      const adj = await api()
        .post('/api/v1/stock-adjustments')
        .set(auth(owner))
        .set('X-Branch-Id', branch)
        .send({ adjustmentDate: '2025-02-01', adjustmentType: 'OPENING', warehouseId, lines: [{ itemId, qty: '100', unitCost: '4.000' }] });
      expect(adj.status).toBe(201);
      expect((await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(owner)).set(idem())).status).toBe(201);
    }

    for (let i = 0; i < INVOICES; i += 1) {
      const onMain = i < ON_MAIN;
      const res = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(owner))
        .set('X-Branch-Id', onMain ? mainId : b2Id)
        .send({
          invoiceDate: `2025-03-0${1 + (i % 5)}`,
          customerId: i % 2 === 0 ? alphaId : betaId,
          warehouseId: onMain ? w1 : w2,
          paymentType: 'CREDIT',
          lines: [{ itemId, qty: '1', unitPrice: `${10 + i}.000` }],
        });
      expect(res.status).toBe(201);
      invoiceIds.push(res.body.id);
      branchOf.set(res.body.id, onMain ? mainId : b2Id);
    }
    // Post in date order: a stock posting dated before the item's last movement is refused.
    for (const i of [...POSTED].sort((a, b) => (a % 5) - (b % 5) || a - b)) {
      const res = await api().post(`/api/v1/sales-invoices/${invoiceIds[i]}/post`).set(auth(owner)).set(idem());
      if (res.status !== 201) throw new Error(`post ${i}: ${res.status} ${JSON.stringify(res.body)}`);
    }

    const member = await addMember(BASE, owner, {
      email: `paging-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 120_000);

  it('/me says who has every branch (ADR-003 §14)', async () => {
    const me = async (token: string) => (await api().get('/api/v1/me').set(auth(token))).body.currentMembership;
    expect((await me(owner)).allBranches).toBe(true);
    expect((await me(accountant)).allBranches).toBe(false);
  });

  describe('GET /sales-invoices', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await list(owner, '?pageSize=10');
      expect(first).toMatchObject({ page: 1, pageSize: 10, total: INVOICES });
      expect(first.items).toHaveLength(10);
      const last = await list(owner, '?pageSize=10&page=3');
      expect(last.items).toHaveLength(5);
      expect(last.total).toBe(INVOICES);
      const past = await list(owner, '?pageSize=10&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: INVOICES });
      const defaults = await list(owner);
      expect(defaults).toMatchObject({ page: 1, pageSize: 20, total: INVOICES });
    });

    it('filters and search narrow the total', async () => {
      expect((await list(owner, '?status=POSTED')).total).toBe(POSTED.length);
      expect((await list(owner, '?status=DRAFT')).total).toBe(INVOICES - POSTED.length);
      expect((await list(owner, '?paymentType=CASH')).total).toBe(0);
      expect((await list(owner, `?customerId=${alphaId}`)).total).toBe(13);
      expect((await list(owner, '?from=2025-03-02&to=2025-03-03')).total).toBe(10);
      expect((await list(owner, '?open=true')).total).toBe(POSTED.length);
      // Search: customer name, then one posted invoice's number.
      const alpha = await list(owner, `?q=${encodeURIComponent(`Alpha ${RUN}`)}&pageSize=100`);
      expect(alpha.total).toBe(13);
      expect(alpha.items.every((r) => r.customerId === alphaId)).toBe(true);
      const posted = (await api().get(`/api/v1/sales-invoices/${invoiceIds[1]}`).set(auth(owner))).body as InvoiceRow;
      const byNo = await list(owner, `?q=${encodeURIComponent(posted.invoiceNo!)}`);
      expect(byNo.items.map((r) => r.id)).toEqual([posted.id]);
      expect((await list(owner, '?q=%20%20')).total).toBe(INVOICES); // blank search = no search
    });

    it('sort is stable: pages of 7 read the same rows in the same order as one page', async () => {
      for (const sort of ['-invoiceDate', 'invoiceDate', 'grandTotal', '-invoiceNo']) {
        const one = (await list(owner, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages(owner, `sort=${sort}`, 7);
        expect(paged.total).toBe(INVOICES);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(INVOICES);
      }
      // Newest first by default; equal dates by id, newest id first.
      const rows = (await list(owner, '?pageSize=100')).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        expect(a.invoiceDate >= b.invoiceDate).toBe(true);
        if (a.invoiceDate === b.invoiceDate) expect(BigInt(a.id) > BigInt(b.id)).toBe(true);
      }
      const byTotal = (await list(owner, '?sort=grandTotal&pageSize=100')).items.map((r) => Number(r.grandTotal));
      expect(byTotal).toEqual([...byTotal].sort((x, y) => x - y));
    });

    it.each([
      ['page=0'],
      ['page=-1'],
      ['page=1.5'],
      ['page=abc'],
      ['page=10001'],
      ['pageSize=0'],
      ['pageSize=101'],
      ['sort=customer'],
      ['sort=--invoiceDate'],
      [`q=${'x'.repeat(101)}`],
      ['status=VOID'],
      ['customerId=abc'],
      ['from=2025-3-1'],
      ['open=yes'],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/sales-invoices?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get('/api/v1/sales-invoices?from=2025-03-05&to=2025-03-01').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists MAIN's invoices only, total included", async () => {
      const all = await allPages(accountant, 'sort=-invoiceDate', 6);
      expect(all.total).toBe(ON_MAIN);
      expect(all.rows).toHaveLength(ON_MAIN);
      expect(all.rows.every((r) => r.branchId === mainId)).toBe(true);
      expect((await list(accountant, '?status=POSTED')).total).toBe(3);
      expect((await list(accountant, '?open=true')).total).toBe(3);
      expect((await list(accountant, `?q=${encodeURIComponent(`Alpha ${RUN}`)}`)).total).toBe(8);
      // The owner (every branch) still sees both branches.
      expect((await list(owner, '?pageSize=100')).items.some((r) => r.branchId === b2Id)).toBe(true);
    });

    it("tenant B sees none of A's invoices, even filtered by A's customer", async () => {
      expect(await list(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await list(tenantB, `?customerId=${alphaId}`)).total).toBe(0);
      expect((await list(tenantB, `?q=${encodeURIComponent(`Alpha ${RUN}`)}`)).total).toBe(0);
    });
  });

  describe('GET /sales-invoices/:id and /:id/pdf', () => {
    const b2Invoice = () => invoiceIds[POSTED[3]];
    const mainInvoice = () => invoiceIds[POSTED[0]];

    it("another branch's invoice answers 404 to a MAIN-only accountant, like another tenant's", async () => {
      expect(branchOf.get(b2Invoice())).toBe(b2Id);
      for (const suffix of ['', '/pdf']) {
        const res = await api().get(`/api/v1/sales-invoices/${b2Invoice()}${suffix}`).set(auth(accountant));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it("the accountant opens and prints MAIN's invoice; the owner opens B2's", async () => {
      const view = await api().get(`/api/v1/sales-invoices/${mainInvoice()}`).set(auth(accountant));
      expect(view.status).toBe(200);
      expect(view.body.branchId).toBe(mainId);
      const pdf = await api().get(`/api/v1/sales-invoices/${mainInvoice()}/pdf`).set(auth(accountant));
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((await api().get(`/api/v1/sales-invoices/${b2Invoice()}`).set(auth(owner))).status).toBe(200);
      expect((await api().get(`/api/v1/sales-invoices/${b2Invoice()}/pdf`).set(auth(owner))).status).toBe(200);
    });

    it("tenant B gets 404 for A's invoice and its PDF", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await api().get(`/api/v1/sales-invoices/${mainInvoice()}${suffix}`).set(auth(tenantB));
        expect(res.status).toBe(404);
      }
    });
  });

  it('books stay consistent after the postings', async () => {
    const verify = await api().get('/api/v1/stock/verify').set(auth(owner));
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    expect(verify.body.inventoryAccountBalance).toBe(verify.body.stockValue);
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(owner));
    expect(tb.body.balanced).toBe(true);
  });
});
