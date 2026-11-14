/**
 * Paging and branch-scoped reads of the trade documents (ADR-022, ADR-003 §10–§12):
 * purchase invoices, sales returns and purchase returns, and the sales and
 * purchases summaries that the branch scope filters.
 * Tenant A has branches MAIN and B2, one warehouse on each, posted and draft
 * documents on both, and an ACCOUNTANT limited to MAIN. Tenant B sees none of it.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3232;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `pt-${RUN}-${Math.random().toString(36).slice(2)}` });

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

interface PageBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface PurchaseInvoiceRow {
  id: string;
  invoiceNo: string | null;
  branchId: string | null;
  supplierId: string;
  status: string;
  paymentType: string;
  invoiceDate: string;
  grandTotal: string;
}
interface SalesReturnRow {
  id: string;
  returnNo: string | null;
  status: string;
  customerId: string;
  returnDate: string;
  grandTotal: string;
}
interface PurchaseReturnRow {
  id: string;
  returnNo: string | null;
  status: string;
  supplierId: string;
  returnDate: string;
  grandTotal: string;
}
interface Posted {
  id: string;
  grand: number;
  no: string | null;
}
interface TradeSummaryTotals {
  invoiceCount: number;
  returnCount: number;
  grand: string;
}

describe('Paging and branch-scoped trade documents (ADR-022, ADR-003)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let alphaId = '';
  let betaId = '';
  let supplierAlphaId = '';
  let supplierBetaId = '';
  let itemId = '';
  let w1 = '';
  let w2 = '';
  let supplierInvoiceNoB1 = '';
  const names = { alpha: '', beta: '', supplierAlpha: '', supplierBeta: '' };

  // Posted documents by key, and drafts by key.
  const posted: Record<string, Posted> = {};
  const drafts: Record<string, string> = {};

  const listOf = async <T>(token: string, resource: string, query = ''): Promise<PageBody<T>> => {
    const res = await api().get(`/api/v1/${resource}${query}`).set(auth(token));
    if (res.status !== 200) throw new Error(`list ${resource}${query}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as PageBody<T>;
  };
  /** Every page of a query, `size` rows at a time. */
  const allPages = async <T extends { id: string }>(token: string, resource: string, query: string, size: number) => {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const body = await listOf<T>(token, resource, `?${query}&pageSize=${size}&page=${page}`);
      rows.push(...body.items);
      if (body.items.length < size) return { rows, total: body.total };
    }
  };
  const getDoc = (token: string, resource: string, id: string, suffix = '') =>
    api().get(`/api/v1/${resource}/${id}${suffix}`).set(auth(token));
  const create = async (resource: string, body: object, branch?: string) => {
    const req = api().post(`/api/v1/${resource}`).set(auth(owner));
    if (branch) req.set('X-Branch-Id', branch);
    const res = await req.send(body);
    if (res.status !== 201) throw new Error(`create ${resource}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; grandTotal: string; invoiceNo?: string; returnNo?: string };
  };
  const postDoc = async (resource: string, id: string) => {
    const res = await api().post(`/api/v1/${resource}/${id}/post`).set(auth(owner)).set(idem());
    if (res.status !== 201) throw new Error(`post ${resource}/${id}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; grandTotal: string; invoiceNo?: string; returnNo?: string };
  };
  const createAndPost = async (key: string, resource: string, body: object, branch?: string) => {
    const doc = await create(resource, body, branch);
    const done = await postDoc(resource, doc.id);
    posted[key] = { id: done.id, grand: Number(done.grandTotal), no: done.invoiceNo ?? done.returnNo ?? null };
    return done;
  };
  const firstLineId = async (resource: string, id: string) => {
    const res = await getDoc(owner, resource, id);
    return (res.body.lines as { id: string }[])[0].id;
  };
  const purchaseInvoice = (key: string, branch: string, supplierId: string, warehouseId: string, date: string, extra = {}) =>
    createAndPost(
      key,
      'purchase-invoices',
      {
        invoiceDate: date,
        supplierId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty: '10', unitCost: '4.000' }],
        ...extra,
      },
      branch,
    );
  const salesInvoice = (key: string, branch: string, customerId: string, warehouseId: string, date: string) =>
    createAndPost(
      key,
      'sales-invoices',
      {
        invoiceDate: date,
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty: '1', unitPrice: '20.000' }],
      },
      branch,
    );

  it('setup: tenant A with MAIN and B2, documents on both, an ACCOUNTANT on MAIN only, tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PagingTrade ${RUN}`, ownerName: 'Owner', email: `paging-trade-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PagingTrade B ${RUN}`, ownerName: 'Owner B', email: `paging-trade-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`PagingTrade ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch; add B2 directly (as paging-branches.e2e does).
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
    w1 = await wh('W1', mainId);
    w2 = await wh('W2', b2Id);
    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs })).body
      .id as string;
    const party = async (code: string, nameAr: string, partyType: 'CUSTOMER' | 'SUPPLIER') =>
      (await api().post('/api/v1/parties').set(auth(owner)).send({ code, nameAr, partyType })).body.id as string;
    names.alpha = `Alpha ${RUN}`;
    names.beta = `Beta ${RUN}`;
    names.supplierAlpha = `Supplier Alpha ${RUN}`;
    names.supplierBeta = `Supplier Beta ${RUN}`;
    alphaId = await party('CA', names.alpha, 'CUSTOMER');
    betaId = await party('CB', names.beta, 'CUSTOMER');
    supplierAlphaId = await party('SA', names.supplierAlpha, 'SUPPLIER');
    supplierBetaId = await party('SB', names.supplierBeta, 'SUPPLIER');

    // Purchases bring stock in first, in date order: a stock posting dated before an
    // item's last movement is refused. Invoices: MAIN (W1) and B2 (W2), plus a MAIN draft.
    await purchaseInvoice('pi.m1', mainId, supplierAlphaId, w1, '2025-02-03', {
      supplierInvoiceNo: `SA-M1-${RUN}`,
    });
    supplierInvoiceNoB1 = `SB-B1-${RUN}`;
    await purchaseInvoice('pi.b1', b2Id, supplierBetaId, w2, '2025-02-04', { supplierInvoiceNo: supplierInvoiceNoB1 });
    await purchaseInvoice('pi.m2', mainId, supplierAlphaId, w1, '2025-03-01');
    await purchaseInvoice('pi.b2', b2Id, supplierBetaId, w2, '2025-03-02');
    drafts['pi.d'] = (
      await create(
        'purchase-invoices',
        {
          invoiceDate: '2025-03-03',
          supplierId: supplierAlphaId,
          warehouseId: w1,
          paymentType: 'CREDIT',
          lines: [{ itemId, qty: '5', unitCost: '4.000' }],
        },
        mainId,
      )
    ).id;

    // Sales in date order, then their returns (posted after the sales they return).
    await salesInvoice('si.m1', mainId, alphaId, w1, '2025-03-05');
    await salesInvoice('si.b1', b2Id, alphaId, w2, '2025-03-05');
    await salesInvoice('si.m2', mainId, betaId, w1, '2025-03-06');
    await salesInvoice('si.m3', mainId, alphaId, w1, '2025-03-07');
    await salesInvoice('si.b2', b2Id, betaId, w2, '2025-03-08');

    await createAndPost('sr.m1', 'sales-returns', {
      returnDate: '2025-03-10',
      originalInvoiceId: posted['si.m1'].id,
      refundType: 'CREDIT',
      lines: [{ originalLineId: await firstLineId('sales-invoices', posted['si.m1'].id), qty: '1' }],
    });
    await createAndPost('sr.b1', 'sales-returns', {
      returnDate: '2025-03-10',
      originalInvoiceId: posted['si.b1'].id,
      refundType: 'CREDIT',
      lines: [{ originalLineId: await firstLineId('sales-invoices', posted['si.b1'].id), qty: '1' }],
    });
    drafts['sr.d'] = (
      await create('sales-returns', {
        returnDate: '2025-03-12',
        originalInvoiceId: posted['si.m2'].id,
        refundType: 'CREDIT',
        lines: [{ originalLineId: await firstLineId('sales-invoices', posted['si.m2'].id), qty: '1' }],
      })
    ).id;

    // Purchase returns after the sales returns; the B2 draft is never posted.
    await createAndPost('pr.m1', 'purchase-returns', {
      returnDate: '2025-03-11',
      originalInvoiceId: posted['pi.m1'].id,
      warehouseId: w1,
      refundType: 'CREDIT',
      lines: [{ originalLineId: await firstLineId('purchase-invoices', posted['pi.m1'].id), qty: '1' }],
    });
    await createAndPost('pr.b1', 'purchase-returns', {
      returnDate: '2025-03-11',
      originalInvoiceId: posted['pi.b1'].id,
      warehouseId: w2,
      refundType: 'CREDIT',
      lines: [{ originalLineId: await firstLineId('purchase-invoices', posted['pi.b1'].id), qty: '1' }],
    });
    drafts['pr.d'] = (
      await create('purchase-returns', {
        returnDate: '2025-03-12',
        originalInvoiceId: posted['pi.b2'].id,
        warehouseId: w2,
        refundType: 'CREDIT',
        lines: [{ originalLineId: await firstLineId('purchase-invoices', posted['pi.b2'].id), qty: '1' }],
      })
    ).id;

    const member = await addMember(BASE, owner, {
      email: `paging-trade-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 180_000);

  describe('GET /purchase-invoices', () => {
    const list = (token: string, query = '') => listOf<PurchaseInvoiceRow>(token, 'purchase-invoices', query);
    const enc = (s: string) => encodeURIComponent(s);

    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await list(owner, '?pageSize=2');
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 5 });
      expect(first.items).toHaveLength(2);
      const last = await list(owner, '?pageSize=2&page=3');
      expect(last.items).toHaveLength(1);
      expect(last.total).toBe(5);
      const past = await list(owner, '?pageSize=2&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: 5 });
      expect(await list(owner)).toMatchObject({ page: 1, pageSize: 20, total: 5 });
    });

    it('filters narrow the total, for the owner and for the MAIN accountant', async () => {
      expect((await list(owner, '?status=POSTED')).total).toBe(4);
      expect((await list(owner, '?status=DRAFT')).total).toBe(1);
      expect((await list(accountant, '?status=POSTED')).total).toBe(2);
      expect((await list(owner, '?paymentType=CASH')).total).toBe(0);
      expect((await list(owner, '?paymentType=CREDIT')).total).toBe(5);
      expect((await list(owner, `?supplierId=${supplierAlphaId}`)).total).toBe(3);
      expect((await list(owner, `?supplierId=${supplierBetaId}`)).total).toBe(2);
      expect((await list(accountant, `?supplierId=${supplierBetaId}`)).total).toBe(0);
      expect((await list(owner, '?from=2025-03-01&to=2025-03-02')).total).toBe(2);
      expect((await list(accountant, '?from=2025-03-01&to=2025-03-02')).total).toBe(1);
      expect((await list(owner, '?open=true')).total).toBe(4);
      expect((await list(accountant, '?open=true')).total).toBe(2);
    });

    it('search matches the invoice number, the supplier invoice number and the supplier name', async () => {
      expect((await list(owner, `?q=${enc(names.supplierBeta)}&pageSize=100`)).total).toBe(2);
      expect((await list(accountant, `?q=${enc(names.supplierBeta)}`)).total).toBe(0);
      const byInvoiceNo = await list(owner, `?q=${enc(supplierInvoiceNoB1)}`);
      expect(byInvoiceNo.items.map((r) => r.id)).toEqual([posted['pi.b1'].id]);
      const byNo = await list(owner, `?q=${enc(posted['pi.m2'].no!)}`);
      expect(byNo.items.map((r) => r.id)).toEqual([posted['pi.m2'].id]);
      expect((await list(accountant, `?q=${enc(posted['pi.b1'].no ?? supplierInvoiceNoB1)}`)).total).toBe(0);
      expect((await list(owner, '?q=%20%20')).total).toBe(5); // blank search = no search
    });

    it('sort is stable: pages of 2 read the same rows in the same order as one page', async () => {
      for (const sort of ['-invoiceDate', 'invoiceDate', 'grandTotal', '-grandTotal', 'invoiceNo', '-invoiceNo']) {
        const one = (await list(owner, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages<PurchaseInvoiceRow>(owner, 'purchase-invoices', `sort=${sort}`, 2);
        expect(paged.total).toBe(5);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(5);
      }
      const rows = (await list(owner, '?pageSize=100')).items;
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].invoiceDate >= rows[i].invoiceDate).toBe(true);
      }
    });

    it.each([
      ['page=0'],
      ['page=-1'],
      ['page=1.5'],
      ['page=abc'],
      ['page=10001'],
      ['pageSize=0'],
      ['pageSize=101'],
      ['sort=supplier'],
      ['sort=--invoiceDate'],
      [`q=${'x'.repeat(101)}`],
      ['status=VOID'],
      ['paymentType=CARD'],
      ['supplierId=abc'],
      ['from=2025-3-1'],
      ['open=yes'],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/purchase-invoices?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get('/api/v1/purchase-invoices?from=2025-03-05&to=2025-03-01').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists MAIN's invoices only, total included", async () => {
      const all = await allPages<PurchaseInvoiceRow>(accountant, 'purchase-invoices', 'sort=-invoiceDate', 2);
      expect(all.total).toBe(3);
      expect(all.rows.map((r) => r.id).sort()).toEqual([posted['pi.m1'].id, posted['pi.m2'].id, drafts['pi.d']].sort());
      expect(all.rows.every((r) => r.branchId === mainId)).toBe(true);
      // The owner (every branch) still sees B2's invoices.
      expect((await list(owner, '?pageSize=100')).items.some((r) => r.branchId === b2Id)).toBe(true);
    });

    it("tenant B sees none of A's invoices, even filtered by A's supplier", async () => {
      expect(await list(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await list(tenantB, `?supplierId=${supplierAlphaId}`)).total).toBe(0);
      expect((await list(tenantB, `?q=${encodeURIComponent(names.supplierAlpha)}`)).total).toBe(0);
    });
  });

  describe('GET /purchase-invoices/:id and /:id/pdf', () => {
    it("another branch's invoice answers 404 to a MAIN-only accountant, on GET and /pdf", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await getDoc(accountant, 'purchase-invoices', posted['pi.b1'].id, suffix);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it("the accountant opens and prints MAIN's invoice; the owner opens B2's", async () => {
      const view = await getDoc(accountant, 'purchase-invoices', posted['pi.m1'].id);
      expect(view.status).toBe(200);
      expect(view.body.branchId).toBe(mainId);
      const pdf = await getDoc(accountant, 'purchase-invoices', posted['pi.m1'].id, '/pdf');
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((await getDoc(owner, 'purchase-invoices', posted['pi.b1'].id)).status).toBe(200);
      expect((await getDoc(owner, 'purchase-invoices', posted['pi.b1'].id, '/pdf')).status).toBe(200);
    });

    it("tenant B gets 404 for A's invoice and its PDF", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await getDoc(tenantB, 'purchase-invoices', posted['pi.m1'].id, suffix);
        expect(res.status).toBe(404);
      }
    });
  });

  describe('GET /sales-returns', () => {
    const list = (token: string, query = '') => listOf<SalesReturnRow>(token, 'sales-returns', query);
    const enc = (s: string) => encodeURIComponent(s);

    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await list(owner, '?pageSize=2');
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });
      expect(first.items).toHaveLength(2);
      const last = await list(owner, '?pageSize=2&page=2');
      expect(last.items).toHaveLength(1);
      expect(await list(owner, '?pageSize=2&page=3')).toMatchObject({ items: [], page: 3, total: 3 });
      expect(await list(owner)).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    });

    it('filters narrow the total, for the owner and for the MAIN accountant', async () => {
      expect((await list(owner, '?status=POSTED')).total).toBe(2);
      expect((await list(owner, '?status=DRAFT')).total).toBe(1);
      expect((await list(accountant, '?status=POSTED')).total).toBe(1);
      expect((await list(owner, `?customerId=${alphaId}`)).total).toBe(2);
      expect((await list(accountant, `?customerId=${alphaId}`)).total).toBe(1);
      expect((await list(owner, '?from=2025-03-10&to=2025-03-10')).total).toBe(2);
      expect((await list(accountant, '?from=2025-03-10&to=2025-03-10')).total).toBe(1);
      expect((await list(accountant, '?from=2025-03-11')).total).toBe(1); // only the draft, dated 03-12
    });

    it('search matches the return number, the original invoice number and the customer', async () => {
      const byNo = await list(owner, `?q=${enc(posted['sr.m1'].no!)}`);
      expect(byNo.items.map((r) => r.id)).toEqual([posted['sr.m1'].id]);
      expect((await list(accountant, `?q=${enc(posted['sr.m1'].no!)}`)).total).toBe(1);
      expect((await list(owner, `?q=${enc(names.beta)}&pageSize=100`)).total).toBe(1); // the draft, on a Beta invoice
      // Matching by the original invoice number: si.b1 belongs to B2.
      const invoiceB1 = (await getDoc(owner, 'sales-invoices', posted['si.b1'].id)).body.invoiceNo as string;
      expect((await list(owner, `?q=${enc(invoiceB1)}`)).total).toBe(1);
      expect((await list(accountant, `?q=${enc(invoiceB1)}`)).total).toBe(0);
      expect((await list(owner, '?q=%20%20')).total).toBe(3); // blank search = no search
    });

    it('sort is stable: pages of 1 read the same rows in the same order as one page', async () => {
      for (const sort of ['-returnDate', 'returnDate', 'returnNo', '-returnNo', 'grandTotal', '-grandTotal']) {
        const one = (await list(owner, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages<SalesReturnRow>(owner, 'sales-returns', `sort=${sort}`, 1);
        expect(paged.total).toBe(3);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(3);
      }
      const rows = (await list(owner, '?pageSize=100')).items;
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1].returnDate >= rows[i].returnDate).toBe(true);
      }
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=-invoiceDate'],
      ['status=VOID'],
      ['customerId=abc'],
      ['from=2025-3-1'],
      ['open=true'], // not a parameter of returns
      ['branchId=1'],
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/sales-returns?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get('/api/v1/sales-returns?from=2025-03-12&to=2025-03-01').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists returns of MAIN's invoices only, total included", async () => {
      const all = await allPages<SalesReturnRow>(accountant, 'sales-returns', 'sort=-returnDate', 1);
      expect(all.total).toBe(2);
      expect(all.rows.map((r) => r.id).sort()).toEqual([posted['sr.m1'].id, drafts['sr.d']].sort());
      expect((await list(owner, '?pageSize=100')).items.some((r) => r.id === posted['sr.b1'].id)).toBe(true);
    });

    it("tenant B sees none of A's returns, even filtered by A's customer", async () => {
      expect(await list(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await list(tenantB, `?customerId=${alphaId}`)).total).toBe(0);
      expect((await list(tenantB, `?q=${encodeURIComponent(names.alpha)}`)).total).toBe(0);
    });
  });

  describe('GET /sales-returns/:id and /:id/pdf', () => {
    it("another branch's return answers 404 to a MAIN-only accountant, on GET and /pdf", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await getDoc(accountant, 'sales-returns', posted['sr.b1'].id, suffix);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it("the accountant opens and prints MAIN's return; the owner opens B2's", async () => {
      const view = await getDoc(accountant, 'sales-returns', posted['sr.m1'].id);
      expect(view.status).toBe(200);
      const pdf = await getDoc(accountant, 'sales-returns', posted['sr.m1'].id, '/pdf');
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((await getDoc(owner, 'sales-returns', posted['sr.b1'].id)).status).toBe(200);
    });

    it("tenant B gets 404 for A's return and its PDF", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await getDoc(tenantB, 'sales-returns', posted['sr.m1'].id, suffix);
        expect(res.status).toBe(404);
      }
    });
  });

  describe('GET /purchase-returns', () => {
    const list = (token: string, query = '') => listOf<PurchaseReturnRow>(token, 'purchase-returns', query);
    const enc = (s: string) => encodeURIComponent(s);

    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await list(owner, '?pageSize=2');
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: 3 });
      expect(first.items).toHaveLength(2);
      const last = await list(owner, '?pageSize=2&page=2');
      expect(last.items).toHaveLength(1);
      expect(await list(owner, '?pageSize=2&page=3')).toMatchObject({ items: [], page: 3, total: 3 });
      expect(await list(owner)).toMatchObject({ page: 1, pageSize: 20, total: 3 });
    });

    it('filters narrow the total, for the owner and for the MAIN accountant', async () => {
      expect((await list(owner, '?status=POSTED')).total).toBe(2);
      expect((await list(owner, '?status=DRAFT')).total).toBe(1);
      expect((await list(accountant, '?status=POSTED')).total).toBe(1);
      expect((await list(accountant, '?status=DRAFT')).total).toBe(0);
      expect((await list(owner, `?supplierId=${supplierAlphaId}`)).total).toBe(1);
      expect((await list(owner, `?supplierId=${supplierBetaId}`)).total).toBe(2);
      expect((await list(accountant, `?supplierId=${supplierBetaId}`)).total).toBe(0);
      expect((await list(owner, '?from=2025-03-11&to=2025-03-11')).total).toBe(2);
      expect((await list(accountant, '?from=2025-03-11&to=2025-03-11')).total).toBe(1);
    });

    it('search matches the return number, the original invoice number and the supplier', async () => {
      const byNo = await list(owner, `?q=${enc(posted['pr.b1'].no!)}`);
      expect(byNo.items.map((r) => r.id)).toEqual([posted['pr.b1'].id]);
      expect((await list(accountant, `?q=${enc(posted['pr.b1'].no!)}`)).total).toBe(0);
      const invoiceM1 = (await getDoc(owner, 'purchase-invoices', posted['pi.m1'].id)).body.invoiceNo as string;
      expect((await list(owner, `?q=${enc(invoiceM1)}`)).total).toBe(1);
      expect((await list(accountant, `?q=${enc(invoiceM1)}`)).total).toBe(1);
      expect((await list(owner, `?q=${enc(names.supplierBeta)}&pageSize=100`)).total).toBe(2);
      expect((await list(accountant, `?q=${enc(names.supplierBeta)}`)).total).toBe(0);
    });

    it('sort is stable: pages of 1 read the same rows in the same order as one page', async () => {
      for (const sort of ['-returnDate', 'returnDate', 'returnNo', '-returnNo', 'grandTotal', '-grandTotal']) {
        const one = (await list(owner, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages<PurchaseReturnRow>(owner, 'purchase-returns', `sort=${sort}`, 1);
        expect(paged.total).toBe(3);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(3);
      }
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=invoiceDate'], // a sort key of invoices, not of returns
      ['status=VOID'],
      ['supplierId=abc'],
      ['from=2025-3-1'],
      ['open=true'], // not a parameter of returns
      ['branchId=1'],
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/purchase-returns?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get('/api/v1/purchase-returns?from=2025-03-12&to=2025-03-01').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists returns of MAIN's invoices only, total included", async () => {
      const all = await allPages<PurchaseReturnRow>(accountant, 'purchase-returns', 'sort=-returnDate', 1);
      expect(all.total).toBe(1);
      expect(all.rows.map((r) => r.id)).toEqual([posted['pr.m1'].id]);
    });

    it("tenant B sees none of A's returns, even filtered by A's supplier", async () => {
      expect(await list(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await list(tenantB, `?supplierId=${supplierBetaId}`)).total).toBe(0);
      expect((await list(tenantB, `?q=${encodeURIComponent(names.supplierBeta)}`)).total).toBe(0);
    });
  });

  describe('GET /purchase-returns/:id', () => {
    it("another branch's return answers 404 to a MAIN-only accountant", async () => {
      const res = await getDoc(accountant, 'purchase-returns', posted['pr.b1'].id);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await getDoc(accountant, 'purchase-returns', posted['pr.m1'].id)).status).toBe(200);
      expect((await getDoc(owner, 'purchase-returns', posted['pr.b1'].id)).status).toBe(200);
    });

    it("tenant B gets 404 for A's return", async () => {
      expect((await getDoc(tenantB, 'purchase-returns', posted['pr.m1'].id)).status).toBe(404);
    });
  });

  describe('trade summaries are branch-scoped (ADR-003 §12)', () => {
    const summary = async (token: string, kind: 'sales-summary' | 'purchases-summary') => {
      const res = await api()
        .get(`/api/v1/reports/${kind}?from=2025-01-01&to=2025-12-31&groupBy=month`)
        .set(auth(token));
      expect(res.status).toBe(200);
      return res.body.totals as TradeSummaryTotals;
    };
    /** Net grand total of documents: invoices minus returns (the summary's sign). */
    const netOf = (invoiceKeys: string[], returnKeys: string[]) =>
      invoiceKeys.reduce((t, k) => t + posted[k].grand, 0) - returnKeys.reduce((t, k) => t + posted[k].grand, 0);

    it('the owner sees both branches in the sales summary', async () => {
      const totals = await summary(owner, 'sales-summary');
      expect(totals.invoiceCount).toBe(5);
      expect(totals.returnCount).toBe(2);
      expect(Number(totals.grand)).toBeCloseTo(netOf(['si.m1', 'si.b1', 'si.m2', 'si.m3', 'si.b2'], ['sr.m1', 'sr.b1']), 2);
    });

    it('the MAIN accountant gets only MAIN in the sales summary', async () => {
      const totals = await summary(accountant, 'sales-summary');
      expect(totals.invoiceCount).toBe(3);
      expect(totals.returnCount).toBe(1);
      expect(Number(totals.grand)).toBeCloseTo(netOf(['si.m1', 'si.m2', 'si.m3'], ['sr.m1']), 2);
    });

    it('the owner sees both branches in the purchases summary', async () => {
      const totals = await summary(owner, 'purchases-summary');
      expect(totals.invoiceCount).toBe(4);
      expect(totals.returnCount).toBe(2);
      expect(Number(totals.grand)).toBeCloseTo(netOf(['pi.m1', 'pi.b1', 'pi.m2', 'pi.b2'], ['pr.m1', 'pr.b1']), 2);
    });

    it('the MAIN accountant gets only MAIN in the purchases summary', async () => {
      const totals = await summary(accountant, 'purchases-summary');
      expect(totals.invoiceCount).toBe(2);
      expect(totals.returnCount).toBe(1);
      expect(Number(totals.grand)).toBeCloseTo(netOf(['pi.m1', 'pi.m2'], ['pr.m1']), 2);
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
