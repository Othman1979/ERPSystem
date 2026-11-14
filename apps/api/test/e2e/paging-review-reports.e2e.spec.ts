/**
 * Wave 3E review fixes (ADR-003 §12–§14): the money reports and the journal
 * entries of stock documents respect the caller's branches, and a member with
 * assigned branches (even every current branch) is refused the company-wide
 * reports and exports with 403 ALL_BRANCHES_REQUIRED.
 * Tenant A has branches MAIN and B2, one warehouse on each, a taxed item, an
 * opening stock adjustment, a purchase invoice and a sales invoice per branch.
 * Expected figures are derived from the posted documents, not hard-coded.
 * Tenant B sees none of it. Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';

const API_PORT = 3239;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

// Stock and prices posted per branch (strings, as the API takes them).
const OPENING_QTY = '100';
const OPENING_COST = '4.000';
const PURCHASE_MAIN = { qty: '10', unitCost: '4.000' };
const PURCHASE_B2 = { qty: '6', unitCost: '5.000' };
const SALE_MAIN = { qty: '2', unitPrice: '20.000' };
const SALE_B2 = { qty: '3', unitPrice: '25.000' };
const SALES_MONTH = '2025-03-31'; // dashboard date: both sales fall in its month
const AS_OF = '2025-03-31'; // aging date: every posted document is before it
const PERIOD = 'from=2025-01-01&to=2025-12-31';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `prv-${RUN}-${Math.random().toString(36).slice(2)}` });

/** Collects a binary body (PDF / XLSX) into a Buffer; an error body arrives the same way. */
function binary(res: unknown, cb: (err: Error | null, body: Buffer) => void) {
  const stream = res as NodeJS.ReadableStream; // superagent hands the raw response stream
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
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

/** A posted invoice as GET returns it (money fields are strings). */
interface Doc {
  id: string;
  branchId: string | null;
  netTotal: string;
  taxTotal: string;
  grandTotal: string;
}
interface PageBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface AgingBody {
  partyType: string;
  rows: { partyId: string; balance: string }[];
  totals: { balance: string };
}
type TaxBody = { rows: unknown[]; totals: Record<string, string> };
interface DashboardBody {
  salesToday: { count: number; grand: string };
  salesMonth: { count: number; grand: string };
  receivables: { total: string };
}
interface ValuationBody {
  rows: { itemId: string; qty: string; avgCost: string; value: string }[];
  totalValue: string;
}

/** A money or quantity value with its scale fixed, for exact comparison. */
const money = (v: string | Decimal) => new Decimal(v).toFixed(3);
/** The sum of one money field over documents. */
const total = (list: Doc[], field: 'netTotal' | 'taxTotal' | 'grandTotal') =>
  list.reduce((acc, d) => acc.plus(d[field]), new Decimal(0));
/** The error code of a JSON error body that may arrive as a Buffer. */
const errorCode = (body: unknown): string => {
  const json = Buffer.isBuffer(body) ? (JSON.parse(body.toString('utf8')) as unknown) : body;
  return (json as { error: { code: string } }).error.code;
};

describe('Review fixes: branch scope of the reports, exports and stock journal entries (ADR-003 §12–§14)', () => {
  let owner = '';
  let accountant = ''; // MAIN only
  let tenantB = '';
  let tenantId = '';
  let mainId = '';
  let b2Id = '';
  let warehouseMain = '';
  let warehouseB2 = '';
  let itemId = '';
  let customerId = '';
  let supplierId = '';
  let accountId = '';
  const adjustments: { main: string; b2: string } = { main: '', b2: '' };
  const sales: { main: Doc; b2: Doc } = { main: undefined as unknown as Doc, b2: undefined as unknown as Doc };
  const purchases: { main: Doc; b2: Doc } = { main: undefined as unknown as Doc, b2: undefined as unknown as Doc };

  const getJson = async <T,>(token: string, url: string): Promise<T> => {
    const res = await api().get(url).set(auth(token));
    if (res.status !== 200) throw new Error(`GET ${url}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  };
  const postDoc = async (resource: string, id: string) => {
    const res = await api().post(`/api/v1/${resource}/${id}/post`).set(auth(owner)).set(idem());
    if (res.status !== 201) throw new Error(`post ${resource}/${id}: ${res.status} ${JSON.stringify(res.body)}`);
  };
  /** Creates a draft on a branch, posts it, and reads the posted document back. */
  const createAndPost = async (resource: string, body: object, branchId: string): Promise<Doc> => {
    const created = await api().post(`/api/v1/${resource}`).set(auth(owner)).set('X-Branch-Id', branchId).send(body);
    if (created.status !== 201) throw new Error(`create ${resource}: ${created.status} ${JSON.stringify(created.body)}`);
    await postDoc(resource, created.body.id as string);
    return getJson<Doc>(owner, `/api/v1/${resource}/${created.body.id as string}`);
  };
  const openingOn = async (warehouseId: string, branchId: string): Promise<string> => {
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(owner))
      .set('X-Branch-Id', branchId)
      .send({
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId, qty: OPENING_QTY, unitCost: OPENING_COST }],
      });
    expect(adj.status).toBe(201);
    await postDoc('stock-adjustments', adj.body.id as string);
    return adj.body.id as string;
  };

  it('setup: tenant A with MAIN and B2, a taxed item, documents on both branches, an ACCOUNTANT on MAIN only, tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Review ${RUN}`, ownerName: 'Owner', email: `review-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Review B ${RUN}`, ownerName: 'Owner B', email: `review-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Review ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    tenantId = String(t.tenantId);
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
    // Two warehouses (one per branch) need the BASIC plan (5 users); TRIAL allows one branch and three users.
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'BASIC') WHERE id = ?", [t.tenantId]);

    expect(
      (await api().post('/api/v1/fiscal-years').set(auth(owner)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' }))
        .status,
    ).toBe(201);
    const warehouse = async (code: string, branchId: string) => {
      const res = await api().post('/api/v1/warehouses').set(auth(owner)).send({ code, nameAr: code, branchId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    warehouseMain = await warehouse('W1', mainId);
    warehouseB2 = await warehouse('W2', b2Id);

    const units = await getJson<{ id: string; code: string }[]>(owner, '/api/v1/units');
    const pcs = units.find((u) => u.code === 'PCS')!.id;
    // A taxed item, so the tax summary has tax to compare (any category with a rate above zero).
    const taxes = await getJson<{ id: string; rate: string }[]>(owner, '/api/v1/tax-categories');
    const taxed = taxes.find((x) => new Decimal(x.rate).gt(0));
    expect(taxed).toBeDefined();
    itemId = (
      await api()
        .post('/api/v1/items')
        .set(auth(owner))
        .send({ code: 'I', nameAr: 'I', baseUnitId: pcs, taxCategoryId: taxed!.id })
    ).body.id as string;
    customerId = (
      await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'CUST', nameAr: `Customer ${RUN}`, partyType: 'CUSTOMER' })
    ).body.id as string;
    supplierId = (
      await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'SUPP', nameAr: `Supplier ${RUN}`, partyType: 'SUPPLIER' })
    ).body.id as string;
    accountId = (await getJson<{ id: string }[]>(owner, '/api/v1/accounts'))[0].id;

    // Date order: opening (1 Feb), purchases (3 and 4 Feb), sales (5 and 6 Mar).
    adjustments.main = await openingOn(warehouseMain, mainId);
    adjustments.b2 = await openingOn(warehouseB2, b2Id);
    purchases.main = await createAndPost(
      'purchase-invoices',
      { invoiceDate: '2025-02-03', supplierId, warehouseId: warehouseMain, paymentType: 'CREDIT', lines: [{ itemId, ...PURCHASE_MAIN }] },
      mainId,
    );
    purchases.b2 = await createAndPost(
      'purchase-invoices',
      { invoiceDate: '2025-02-04', supplierId, warehouseId: warehouseB2, paymentType: 'CREDIT', lines: [{ itemId, ...PURCHASE_B2 }] },
      b2Id,
    );
    sales.main = await createAndPost(
      'sales-invoices',
      { invoiceDate: '2025-03-05', customerId, warehouseId: warehouseMain, paymentType: 'CREDIT', lines: [{ itemId, ...SALE_MAIN }] },
      mainId,
    );
    sales.b2 = await createAndPost(
      'sales-invoices',
      { invoiceDate: '2025-03-06', customerId, warehouseId: warehouseB2, paymentType: 'CREDIT', lines: [{ itemId, ...SALE_B2 }] },
      b2Id,
    );
    expect(sales.main.branchId).toBe(mainId);
    expect(sales.b2.branchId).toBe(b2Id);
    expect(purchases.main.branchId).toBe(mainId);
    expect(purchases.b2.branchId).toBe(b2Id);

    const member = await addMember(BASE, owner, {
      email: `review-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 120_000);

  describe('GET /reports/aging (ADR-003 §12)', () => {
    it.each(['CUSTOMER', 'SUPPLIER'] as const)(
      '%s: the accountant sees MAIN\'s documents only; the owner sees both branches',
      async (partyType) => {
        const docs = partyType === 'CUSTOMER' ? sales : purchases;
        const url = `/api/v1/reports/aging?partyType=${partyType}&asOf=${AS_OF}`;
        const mine = await getJson<AgingBody>(accountant, url);
        const all = await getJson<AgingBody>(owner, url);

        expect(mine.rows).toHaveLength(1);
        expect(money(mine.totals.balance)).toBe(money(total([docs.main], 'grandTotal')));
        expect(money(mine.rows[0].balance)).toBe(money(total([docs.main], 'grandTotal')));
        expect(all.rows).toHaveLength(1);
        expect(money(all.totals.balance)).toBe(money(total([docs.main, docs.b2], 'grandTotal')));
        expect(money(all.rows[0].balance)).toBe(money(total([docs.main, docs.b2], 'grandTotal')));
      },
    );
  });

  describe('GET /reports/tax-summary (ADR-003 §12)', () => {
    it("the accountant's sales and purchase base and tax are MAIN's invoices only; the owner's are both", async () => {
      const url = `/api/v1/reports/tax-summary?${PERIOD}`;
      const mine = await getJson<TaxBody>(accountant, url);
      const all = await getJson<TaxBody>(owner, url);

      expect(money(mine.totals.salesBase)).toBe(money(sales.main.netTotal));
      expect(money(mine.totals.salesTax)).toBe(money(sales.main.taxTotal));
      expect(money(mine.totals.purchasesBase)).toBe(money(purchases.main.netTotal));
      expect(money(mine.totals.purchasesTax)).toBe(money(purchases.main.taxTotal));

      expect(money(all.totals.salesBase)).toBe(money(total([sales.main, sales.b2], 'netTotal')));
      expect(money(all.totals.salesTax)).toBe(money(total([sales.main, sales.b2], 'taxTotal')));
      expect(money(all.totals.purchasesBase)).toBe(money(total([purchases.main, purchases.b2], 'netTotal')));
      expect(money(all.totals.purchasesTax)).toBe(money(total([purchases.main, purchases.b2], 'taxTotal')));
    });
  });

  describe('GET /dashboard/summary (ADR-003 §12)', () => {
    it('sales of the month and receivables follow the caller\'s branches', async () => {
      const url = `/api/v1/dashboard/summary?date=${SALES_MONTH}`;
      const mine = await getJson<DashboardBody>(accountant, url);
      const all = await getJson<DashboardBody>(owner, url);

      expect(mine.salesMonth.count).toBe(1);
      expect(money(mine.salesMonth.grand)).toBe(money(sales.main.grandTotal));
      expect(money(mine.receivables.total)).toBe(money(sales.main.grandTotal));
      expect(mine.salesToday.count).toBe(0); // no sale on the dashboard day

      expect(all.salesMonth.count).toBe(2);
      expect(money(all.salesMonth.grand)).toBe(money(total([sales.main, sales.b2], 'grandTotal')));
      expect(money(all.receivables.total)).toBe(money(total([sales.main, sales.b2], 'grandTotal')));
    });
  });

  describe('GET /stock/valuation (ADR-003 §12)', () => {
    it('the accountant sees W1 quantities and their value; the owner sees both warehouses', async () => {
      const mine = await getJson<ValuationBody>(accountant, '/api/v1/stock/valuation');
      const all = await getJson<ValuationBody>(owner, '/api/v1/stock/valuation');
      const rowOf = (body: ValuationBody) => body.rows.find((r) => r.itemId === itemId)!;

      const mainQty = new Decimal(OPENING_QTY).plus(PURCHASE_MAIN.qty).minus(SALE_MAIN.qty);
      const b2Qty = new Decimal(OPENING_QTY).plus(PURCHASE_B2.qty).minus(SALE_B2.qty);
      const myRow = rowOf(mine);
      expect(new Decimal(myRow.qty).eq(mainQty)).toBe(true);
      expect(money(myRow.value)).toBe(new Decimal(myRow.qty).times(myRow.avgCost).toFixed(3));
      expect(money(mine.totalValue)).toBe(money(myRow.value));

      const allRow = rowOf(all);
      expect(new Decimal(allRow.qty).eq(mainQty.plus(b2Qty))).toBe(true);
      expect(new Decimal(allRow.avgCost).eq(myRow.avgCost)).toBe(true); // one company-wide average cost
    });
  });

  describe('journal entries of stock documents (S1, ADR-003 §11)', () => {
    let mainEntryId = '';
    let b2EntryId = '';

    it("an adjustment's entry carries its warehouse's branch, on the entry and on every line", async () => {
      const entryOf = async (adjustmentId: string) =>
        (await getJson<{ journalEntry: { id: string } | null }>(owner, `/api/v1/stock-adjustments/${adjustmentId}`)).journalEntry;
      const mainEntry = await entryOf(adjustments.main);
      const b2Entry = await entryOf(adjustments.b2);
      expect(mainEntry).not.toBeNull();
      expect(b2Entry).not.toBeNull();
      mainEntryId = mainEntry!.id;
      b2EntryId = b2Entry!.id;

      for (const [entryId, branch] of [
        [mainEntryId, mainId],
        [b2EntryId, b2Id],
      ] as const) {
        const [entry] = (await db.query('SELECT branch_id AS branchId FROM journal_entries WHERE tenant_id = ? AND id = ?', [
          tenantId,
          entryId,
        ])) as { branchId: bigint | null }[];
        expect(String(entry.branchId)).toBe(branch);
        const lines = (await db.query(
          'SELECT DISTINCT branch_id AS branchId FROM journal_lines WHERE tenant_id = ? AND journal_entry_id = ?',
          [tenantId, entryId],
        )) as { branchId: bigint | null }[];
        expect(lines.map((l) => String(l.branchId))).toEqual([branch]);
      }
    });

    it("the accountant does not list B2's entry, and its detail answers 404; the owner sees and opens it", async () => {
      const mine = await getJson<PageBody<{ id: string }>>(accountant, '/api/v1/journal-entries?pageSize=100');
      const mineIds = mine.items.map((r) => r.id);
      expect(mineIds).toContain(mainEntryId);
      expect(mineIds).not.toContain(b2EntryId);

      const all = await getJson<PageBody<{ id: string }>>(owner, '/api/v1/journal-entries?pageSize=100');
      expect(all.items.map((r) => r.id)).toContain(b2EntryId);

      const hidden = await api().get(`/api/v1/journal-entries/${b2EntryId}`).set(auth(accountant));
      expect(hidden.status).toBe(404);
      expect(hidden.body.error.code).toBe('NOT_FOUND');
      expect((await api().get(`/api/v1/journal-entries/${b2EntryId}`).set(auth(owner))).status).toBe(200);
      expect((await api().get(`/api/v1/journal-entries/${mainEntryId}`).set(auth(accountant))).status).toBe(200);
    });
  });

  describe('a member assigned every branch is still restricted (ADR-003 §13–§14)', () => {
    it('allBranches is false and the trial balance answers 403 ALL_BRANCHES_REQUIRED', async () => {
      const both = await addMember(BASE, owner, {
        email: `review-both-${RUN}@test.dev`,
        roleCode: 'ACCOUNTANT',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId, b2Id],
      });
      const me = async (token: string) => (await api().get('/api/v1/me').set(auth(token))).body.currentMembership;
      expect((await me(owner)).allBranches).toBe(true);
      expect((await me(both.token)).allBranches).toBe(false);

      const refused = await api().get('/api/v1/reports/trial-balance').set(auth(both.token));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
      expect((await api().get('/api/v1/reports/trial-balance').set(auth(owner))).status).toBe(200);
    });
  });

  describe('exports of the all-branches reports (ADR-003 §13)', () => {
    /** Binary-safe GET: a PDF or XLSX arrives as a Buffer, and so does an error body. */
    const exportGet = (url: string) => api().get(url).set(auth(accountant)).buffer(true).parse(binary);

    it.each(['pdf', 'xlsx'] as const)(
      'format=%s: trial-balance, general-ledger, income-statement and balance-sheet are refused with ALL_BRANCHES_REQUIRED',
      async (format) => {
        const urls = [
          `/api/v1/reports/trial-balance?format=${format}&lang=en`,
          `/api/v1/reports/general-ledger?accountId=${accountId}&${PERIOD}&format=${format}&lang=en`,
          `/api/v1/reports/income-statement?${PERIOD}&format=${format}&lang=en`,
          `/api/v1/reports/balance-sheet?asOf=2025-12-31&format=${format}&lang=en`,
        ];
        for (const url of urls) {
          const res = await exportGet(url);
          expect(res.status).toBe(403);
          expect(errorCode(res.body)).toBe('ALL_BRANCHES_REQUIRED');
        }
      },
    );

    it('/export/tenant-data is refused to the accountant with ALL_BRANCHES_REQUIRED', async () => {
      const res = await exportGet('/api/v1/export/tenant-data');
      expect(res.status).toBe(403);
      expect(errorCode(res.body)).toBe('ALL_BRANCHES_REQUIRED');
    });
  });

  describe('tenant isolation (every endpoint of this file)', () => {
    it("tenant B sees none of A's aging, tax, dashboard or valuation figures", async () => {
      // Tenant B needs a fiscal year for the period-based report.
      expect(
        (await api().post('/api/v1/fiscal-years').set(auth(tenantB)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' }))
          .status,
      ).toBe(201);

      for (const partyType of ['CUSTOMER', 'SUPPLIER'] as const) {
        const aging = await getJson<AgingBody>(tenantB, `/api/v1/reports/aging?partyType=${partyType}&asOf=${AS_OF}`);
        expect(aging.rows).toEqual([]);
        expect(money(aging.totals.balance)).toBe('0.000');
      }

      const tax = await getJson<TaxBody>(tenantB, `/api/v1/reports/tax-summary?${PERIOD}`);
      expect(tax.rows).toEqual([]);
      expect(money(tax.totals.salesBase)).toBe('0.000');
      expect(money(tax.totals.purchasesBase)).toBe('0.000');

      const dash = await getJson<DashboardBody>(tenantB, `/api/v1/dashboard/summary?date=${SALES_MONTH}`);
      expect(dash.salesMonth.count).toBe(0);
      expect(money(dash.receivables.total)).toBe('0.000');

      const valuation = await getJson<ValuationBody>(tenantB, '/api/v1/stock/valuation');
      expect(valuation.rows).toEqual([]);
      expect(money(valuation.totalValue)).toBe('0.000');
    });
  });
});
