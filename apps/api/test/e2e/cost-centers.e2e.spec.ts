/**
 * Phase 11A — cost centres (ADR-013 §3, ADR-024 §1), against a real MariaDB:
 *  - CC1 the tree: create, group / leaf, duplicate code, tenant B sees and reaches nothing of A's;
 *  - CC2 the account flag: refused on a balance-sheet account;
 *  - CC3 posting checks: required centre, centre on a balance-sheet line, group,
 *    inactive and another tenant's centre;
 *  - CC4 the golden scenario: manual lines, a sales invoice and a payment with a
 *    header centre (copied onto the income-statement lines only), a reversal that
 *    keeps the centre; the income statement by centre, hand-checked, adds up to
 *    the income statement;
 *  - CC5 the cost-centre statement: opening zero, paged = whole, PDF / XLSX, cursor kind;
 *  - CC6 in use: delete and regrouping refused, deactivate and reactivate;
 *  - CC7 switched off: nothing required, posted lines keep their centres;
 *  - CC8 job:integrity-check finds an orphan centre on a journal line;
 *  - final: trial balance balanced, stock:verify clean.
 *
 * Real MariaDB (E2E_DB_NAME) + built API on :3741. Run `pnpm build` first.
 */
import 'dotenv/config';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { promisify } from 'node:util';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { statementBody } from './support/statements.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3741;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const T = 60_000;

let server: ChildProcess;
let db: Connection;
let databaseUrl = '';

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `cc-${RUN}-${Math.random().toString(36).slice(2)}` });

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
  databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: API_DIR,
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
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => undefined);
  }
  await db?.end();
});

interface Tenant {
  token: string;
  tenantId: string;
  acc: Record<string, string>;
}
const A: Tenant = { token: '', tenantId: '', acc: {} };
const B: Tenant = { token: '', tenantId: '', acc: {} };
/** A's centres by code. */
const cc: Record<string, string> = {};
let customerId = '';
let warehouseId = '';
let itemId = '';

async function register(t: Tenant, tag: string) {
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: `CC ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `cc-${tag}-${RUN}@test.dev`, password: PASS });
  expect(res.status).toBe(201);
  t.token = res.body.accessToken;
  t.tenantId = String((await api().get('/api/v1/me').set(auth(t.token))).body.currentTenant.tenantId);
  const fy = await api()
    .post('/api/v1/fiscal-years')
    .set(auth(t.token))
    .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
  expect(fy.status).toBe(201);
  const accounts = (await api().get('/api/v1/accounts').set(auth(t.token))).body as { id: string; code: string }[];
  for (const a of accounts) t.acc[a.code] = a.id;
}

const as = (t: Tenant) => ({
  get: (url: string) => api().get(`/api/v1${url}`).set(auth(t.token)),
  post: (url: string, body: object = {}) => api().post(`/api/v1${url}`).set(auth(t.token)).set(idem()).send(body),
  patch: (url: string, body: object) => api().patch(`/api/v1${url}`).set(auth(t.token)).send(body),
  del: (url: string) => api().delete(`/api/v1${url}`).set(auth(t.token)),
});

/** Expects a refusal with this status and error code. */
function refused(res: request.Response, status: number, code: string) {
  expect({ status: res.status, code: res.body?.error?.code ?? res.body?.code }).toEqual({ status, code });
}

async function centre(t: Tenant, code: string, parentCode?: string): Promise<string> {
  const res = await as(t).post('/cost-centers', {
    code,
    nameAr: `مركز ${code}`,
    nameEn: `Centre ${code}`,
    ...(parentCode ? { parentId: cc[parentCode] } : {}),
  });
  expect(res.status).toBe(201);
  return String(res.body.id);
}

type Line = { accountId: string; debit?: string; credit?: string; costCenterId?: string };

/** Creates and posts a manual journal; returns the post response. */
async function journal(t: Tenant, entryDate: string, lines: Line[]) {
  const draft = await as(t).post('/journal-entries', { entryDate, description: `cc ${RUN}`, lines });
  expect(draft.status).toBe(201);
  return { draft: String(draft.body.id), post: await as(t).post(`/journal-entries/${draft.body.id}/post`) };
}

/** Lines of a posted entry: account code → cost centre id (null when none). */
async function centresOf(t: Tenant, entryId: string): Promise<Record<string, string | null>> {
  const res = await as(t).get(`/journal-entries/${entryId}`);
  expect(res.status).toBe(200);
  const codes = Object.fromEntries(Object.entries(t.acc).map(([code, id]) => [id, code]));
  return Object.fromEntries(
    (res.body.lines as { accountId: string; costCenterId: string | null }[]).map((l) => [codes[l.accountId], l.costCenterId]),
  );
}

describe('cost centres (ADR-024 §1)', () => {
  it('setup: tenants A and B, centres on for A, stock to sell', async () => {
    await register(A, 'a');
    await register(B, 'b');
    const on = await as(A).patch('/company', { costCentersEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.costCentersEnabled).toBe(true);
    expect((await as(B).get('/company')).body.costCentersEnabled).toBe(false);

    const units = (await as(A).get('/units')).body as { id: string; code: string }[];
    warehouseId = String((await as(A).post('/warehouses', { code: 'W', nameAr: 'مستودع' })).body.id);
    itemId = String(
      (await as(A).post('/items', { code: 'I1', nameAr: 'صنف', baseUnitId: units.find((u) => u.code === 'PCS')!.id, itemKind: 'STOCK' }))
        .body.id,
    );
    customerId = String((await as(A).post('/parties', { code: 'C1', nameAr: 'عميل', partyType: 'CUSTOMER' })).body.id);
    const adj = await as(A).post('/stock-adjustments', {
      adjustmentDate: '2025-01-01',
      adjustmentType: 'OPENING',
      warehouseId,
      lines: [{ itemId, qty: '10', unitCost: '4.000' }],
    });
    expect(adj.status).toBe(201);
    expect((await as(A).post(`/stock-adjustments/${adj.body.id}/post`)).status).toBe(201);
  }, T);

  it('CC1 the tree: groups, leaves, duplicate code, tenant B isolation', async () => {
    cc.ADM = await centre(A, 'ADM');
    cc['ADM-HQ'] = await centre(A, 'ADM-HQ', 'ADM');
    cc.SALES = await centre(A, 'SALES');
    cc.OLD = await centre(A, 'OLD');

    const list = (await as(A).get('/cost-centers')).body as { id: string; code: string; parentId: string | null; isPostable: boolean }[];
    expect(list.map((c) => c.code)).toEqual(['ADM', 'ADM-HQ', 'OLD', 'SALES']);
    expect(list.find((c) => c.code === 'ADM')).toMatchObject({ parentId: null, isPostable: false });
    expect(list.find((c) => c.code === 'ADM-HQ')).toMatchObject({ parentId: cc.ADM, isPostable: true });

    refused(await as(A).post('/cost-centers', { code: 'SALES', nameAr: 'مكرر' }), 409, 'DUPLICATE_CODE');
    refused(await as(A).post('/cost-centers', { code: 'X', nameAr: 'x', tenantId: B.tenantId }), 400, 'VALIDATION');

    // Tenant B: none of A's centres, by any route.
    expect((await as(B).get('/cost-centers')).body).toEqual([]);
    refused(await as(B).patch(`/cost-centers/${cc.SALES}`, { nameAr: 'B' }), 404, 'NOT_FOUND');
    refused(await as(B).patch(`/cost-centers/${cc.SALES}`, { isActive: false }), 404, 'NOT_FOUND');
    refused(await as(B).del(`/cost-centers/${cc.SALES}`), 404, 'NOT_FOUND');
    refused(await as(B).post('/cost-centers', { code: 'BX', nameAr: 'b', parentId: cc.ADM }), 404, 'NOT_FOUND');
    refused(await as(B).get(`/reports/cost-center-statement?costCenterId=${cc.SALES}`), 404, 'NOT_FOUND');
    // B's own centre on a line or a document: A's ids are not found.
    const bDraft = await as(B).post('/journal-entries', {
      entryDate: '2025-02-01',
      lines: [
        { accountId: B.acc['5204'], debit: '1', costCenterId: cc.SALES },
        { accountId: B.acc['1101'], credit: '1' },
      ],
    });
    refused(bDraft, 404, 'NOT_FOUND');
    const bPay = await as(B).post('/payments', {
      paymentDate: '2025-02-01',
      expenseAccountId: B.acc['5204'],
      cashAccountId: B.acc['1101'],
      amount: '1.000',
      costCenterId: cc.SALES,
    });
    refused(bPay, 404, 'NOT_FOUND');
    // A's tree is unchanged.
    expect(((await as(A).get('/cost-centers')).body as unknown[]).length).toBe(4);
  }, T);

  it('CC2 the "centre required" flag is for income-statement accounts only', async () => {
    refused(await as(A).patch(`/accounts/${A.acc['1101']}`, { costCenterRequired: true }), 400, 'COST_CENTER_NOT_ALLOWED');
    refused(
      await as(A).post('/accounts', { code: '1199', nameAr: 'أصل', accountType: 'ASSET', costCenterRequired: true }),
      400,
      'COST_CENTER_NOT_ALLOWED',
    );
    const flagged = await as(A).patch(`/accounts/${A.acc['5202']}`, { costCenterRequired: true });
    expect(flagged.status).toBe(200);
    expect(flagged.body.costCenterRequired).toBe(true);
  }, T);

  it('CC3 posting refuses a missing, misplaced, group, inactive or foreign centre', async () => {
    // 5202 is flagged: a line without a centre is refused at posting.
    const missing = await journal(A, '2025-02-01', [
      { accountId: A.acc['5202'], debit: '10' },
      { accountId: A.acc['1101'], credit: '10' },
    ]);
    refused(missing.post, 400, 'COST_CENTER_REQUIRED');
    expect(missing.post.body.error?.details ?? missing.post.body.details).toMatchObject({ line: 1 });
    expect((await as(A).del(`/journal-entries/${missing.draft}`)).status).toBe(200);

    const onCash = await journal(A, '2025-02-01', [
      { accountId: A.acc['5204'], debit: '10' },
      { accountId: A.acc['1101'], credit: '10', costCenterId: cc.SALES },
    ]);
    refused(onCash.post, 400, 'COST_CENTER_NOT_ALLOWED');
    expect((await as(A).del(`/journal-entries/${onCash.draft}`)).status).toBe(200);

    const group = await journal(A, '2025-02-01', [
      { accountId: A.acc['5204'], debit: '10', costCenterId: cc.ADM },
      { accountId: A.acc['1101'], credit: '10' },
    ]);
    refused(group.post, 400, 'COST_CENTER_NOT_POSTABLE');
    expect((await as(A).del(`/journal-entries/${group.draft}`)).status).toBe(200);

    // Inactive: refused at posting, and on a document header already at save.
    expect((await as(A).patch(`/cost-centers/${cc.OLD}`, { isActive: false })).status).toBe(200);
    const inactive = await journal(A, '2025-02-01', [
      { accountId: A.acc['5204'], debit: '10', costCenterId: cc.OLD },
      { accountId: A.acc['1101'], credit: '10' },
    ]);
    refused(inactive.post, 400, 'COST_CENTER_INACTIVE');
    expect((await as(A).del(`/journal-entries/${inactive.draft}`)).status).toBe(200);
    refused(
      await as(A).post('/sales-invoices', {
        invoiceDate: '2025-03-01',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        costCenterId: cc.OLD,
        lines: [{ itemId, qty: '1', unitPrice: '10.000' }],
      }),
      400,
      'COST_CENTER_INACTIVE',
    );
    // An opening entry posts at once: a group centre is refused there too.
    refused(
      await as(A).post('/journal-entries/opening', {
        entryDate: '2025-01-01',
        lines: [{ accountId: A.acc['5204'], debit: '5', costCenterId: cc.ADM }],
      }),
      400,
      'COST_CENTER_NOT_POSTABLE',
    );
    // Nothing above reached the books.
    const tb = await as(A).get('/reports/trial-balance?from=2025-01-01&to=2025-12-31');
    expect((tb.body.rows as { code: string }[]).some((r) => r.code === '5204' || r.code === '5202')).toBe(false);
  }, T);

  let invoiceEntry = '';
  let reversed = '';
  let reversal = '';

  it('CC4 golden: lines, a document header centre and a reversal; by centre = the income statement', async () => {
    // 1. Manual: rent 300 on ADM-HQ (required, given), G&A 50 without a centre.
    const rent = await journal(A, '2025-02-01', [
      { accountId: A.acc['5202'], debit: '300', costCenterId: cc['ADM-HQ'] },
      { accountId: A.acc['5204'], debit: '50' },
      { accountId: A.acc['1101'], credit: '350' },
    ]);
    expect(rent.post.status).toBe(201);
    expect(await centresOf(A, rent.draft)).toEqual({ '5202': cc['ADM-HQ'], '5204': null, '1101': null });

    // 2. Sales invoice with a header centre: 2 x 10.000, COGS 2 x 4.000.
    const inv = await as(A).post('/sales-invoices', {
      invoiceDate: '2025-03-01',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      costCenterId: cc.SALES,
      lines: [{ itemId, qty: '2', unitPrice: '10.000' }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.costCenterId).toBe(cc.SALES);
    const posted = await as(A).post(`/sales-invoices/${inv.body.id}/post`);
    expect(posted.status).toBe(201);
    invoiceEntry = String(posted.body.journalEntryId);
    const lines = await centresOf(A, invoiceEntry);
    // Revenue and cost of sales carry the centre; receivable, tax and inventory do not.
    expect(lines['4101']).toBe(cc.SALES);
    expect(lines['5101']).toBe(cc.SALES);
    expect(lines['1103']).toBeNull();
    expect(lines['1104']).toBeNull();
    if ('2102' in lines) expect(lines['2102']).toBeNull();

    // 3. Payment of an expense with a header centre: the expense line only.
    const pay = await as(A).post('/payments', {
      paymentDate: '2025-03-05',
      expenseAccountId: A.acc['5203'],
      cashAccountId: A.acc['1101'],
      amount: '40.000',
      costCenterId: cc['ADM-HQ'],
    });
    expect(pay.status).toBe(201);
    expect(await centresOf(A, String(pay.body.journalEntryId))).toEqual({ '5203': cc['ADM-HQ'], '1101': null });

    // 4. Other revenue 100 on ADM-HQ, then reversed: the reversal keeps the centre.
    const other = await journal(A, '2025-04-01', [
      { accountId: A.acc['1101'], debit: '100' },
      { accountId: A.acc['4201'], credit: '100', costCenterId: cc['ADM-HQ'] },
    ]);
    expect(other.post.status).toBe(201);
    reversed = other.draft;
    const rev = await as(A).post(`/journal-entries/${other.draft}/reverse`, { reversalDate: '2025-04-02' });
    expect(rev.status).toBe(201);
    reversal = String(rev.body.id);
    expect(await centresOf(A, reversal)).toEqual({ '1101': null, '4201': cc['ADM-HQ'] });

    // The income statement by centre, hand-checked (columns ADM-HQ, SALES, no centre):
    //   revenue  4101  0 | 20 | 0 = 20 ; 4201  100 − 100 = 0
    //   expenses 5101  0 |  8 | 0 = 8 ; 5202 300 ; 5203 40 ; 5204 no centre 50
    //   net      −340 | 12 | −50 = −378
    const q = '?from=2025-01-01&to=2025-05-31';
    const by = await as(A).get(`/reports/income-statement-by-cost-center${q}`);
    expect(by.status).toBe(200);
    expect(by.body.columns.map((c: { costCenterId: string | null; code: string | null }) => [c.costCenterId, c.code])).toEqual([
      [cc['ADM-HQ'], 'ADM-HQ'],
      [cc.SALES, 'SALES'],
      [null, null],
    ]);
    const rows = (section: { rows: { code: string; amounts: string[]; total: string }[] }) =>
      Object.fromEntries(section.rows.map((r) => [r.code, [...r.amounts, r.total]]));
    expect(rows(by.body.revenue)).toEqual({
      '4101': ['0.000', '20.000', '0.000', '20.000'],
      '4201': ['0.000', '0.000', '0.000', '0.000'],
    });
    expect(rows(by.body.expenses)).toEqual({
      '5101': ['0.000', '8.000', '0.000', '8.000'],
      '5202': ['300.000', '0.000', '0.000', '300.000'],
      '5203': ['40.000', '0.000', '0.000', '40.000'],
      '5204': ['0.000', '0.000', '50.000', '50.000'],
    });
    expect(by.body.revenue.totals).toEqual(['0.000', '20.000', '0.000']);
    expect(by.body.expenses.totals).toEqual(['340.000', '8.000', '50.000']);
    expect(by.body.netProfit).toEqual({ amounts: ['-340.000', '12.000', '-50.000'], total: '-378.000' });

    // ... and it adds up to the income statement of the same period.
    const whole = await as(A).get(`/reports/income-statement${q}`);
    expect(whole.status).toBe(200);
    expect(whole.body.netProfit).toBe('-378.000');
    expect(by.body.revenue.total).toBe(whole.body.revenue.total);

    // Exports follow the table pattern.
    const pdf = await as(A).get(`/reports/income-statement-by-cost-center${q}&format=pdf&lang=ar`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xlsx = await as(A).get(`/reports/income-statement-by-cost-center${q}&format=xlsx&lang=en`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  }, T);

  it('CC5 the cost-centre statement: opening zero, paged = whole, own cursor kind', async () => {
    const q = `costCenterId=${cc['ADM-HQ']}&from=2025-01-01&to=2025-05-31`;
    const first = await as(A).get(`/reports/cost-center-statement?${q}&limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.costCenter).toMatchObject({ id: cc['ADM-HQ'], code: 'ADM-HQ' });
    expect(first.body.summary).toMatchObject({
      openingBalance: '0.000',
      totalDebit: '440.000',
      totalCredit: '100.000',
      closingBalance: '340.000',
    });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    // Page by page (limit 1) gives the same lines and balances as one read.
    const paged: { lineId: string; balance: string }[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: request.Response = await as(A).get(
        `/reports/cost-center-statement?${q}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(res.status).toBe(200);
      if (pages > 0) expect(res.body.summary).toBeNull();
      paged.push(...res.body.items);
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    const whole = await statementBody(BASE, `/api/v1/reports/cost-center-statement?${q}`, A.token);
    expect(pages).toBe(4);
    expect(paged).toEqual(whole.rows);
    expect(whole.rows.map((r: { accountCode: string; debit: string; credit: string; balance: string }) => [r.accountCode, r.debit, r.credit, r.balance])).toEqual([
      ['5202', '300.000', '0.000', '300.000'],
      ['5203', '40.000', '0.000', '340.000'],
      ['4201', '0.000', '100.000', '240.000'],
      ['4201', '100.000', '0.000', '340.000'],
    ]);
    // The statement closes at minus the centre's net profit column (−340).
    expect(whole.closingBalance).toBe('340.000');

    // A cursor belongs to its read: another centre's filters, or another report kind, refuse it.
    const other = await as(A).get(
      `/reports/cost-center-statement?costCenterId=${cc.SALES}&from=2025-01-01&to=2025-05-31&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    refused(other, 400, 'CURSOR_INVALID');
    const asLedger = await as(A).get(
      `/reports/general-ledger?accountId=${A.acc['5202']}&cursor=${encodeURIComponent(first.body.nextCursor)}`,
    );
    refused(asLedger, 400, 'CURSOR_INVALID');

    const pdf = await as(A).get(`/reports/cost-center-statement?${q}&format=pdf&lang=en`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const xlsx = await as(A).get(`/reports/cost-center-statement?${q}&format=xlsx&lang=ar`);
    expect(xlsx.status).toBe(200);
  }, T);

  it('CC6 a used centre is deactivated, not deleted, and gets no sub-centre', async () => {
    refused(await as(A).del(`/cost-centers/${cc['ADM-HQ']}`), 409, 'COST_CENTER_IN_USE');
    refused(await as(A).del(`/cost-centers/${cc.ADM}`), 409, 'COST_CENTER_HAS_CHILDREN');
    // The sales invoice header is a use too (sales module), and so is the payment (treasury).
    refused(await as(A).del(`/cost-centers/${cc.SALES}`), 409, 'COST_CENTER_IN_USE');
    refused(await as(A).post('/cost-centers', { code: 'SALES-1', nameAr: 'فرعي', parentId: cc.SALES }), 409, 'COST_CENTER_IN_USE');
    // A group is deactivated after its active sub-centres.
    refused(await as(A).patch(`/cost-centers/${cc.ADM}`, { isActive: false }), 409, 'COST_CENTER_HAS_CHILDREN');

    const tmp = await centre(A, 'TMP');
    const leaf = await centre(A, 'TMP-1', 'TMP');
    expect((await as(A).del(`/cost-centers/${leaf}`)).body).toEqual({ deleted: true });
    // The parent left without children takes lines again.
    const list = (await as(A).get('/cost-centers')).body as { id: string; isPostable: boolean }[];
    expect(list.find((c) => c.id === tmp)?.isPostable).toBe(true);
    expect((await as(A).del(`/cost-centers/${tmp}`)).status).toBe(200);

    const off = await as(A).patch(`/cost-centers/${cc['ADM-HQ']}`, { isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.isActive).toBe(false);
    expect((await as(A).patch(`/cost-centers/${cc['ADM-HQ']}`, { isActive: true })).body.isActive).toBe(true);
  }, T);

  it('CC7 switched off: nothing is required, posted lines and flags stay', async () => {
    expect((await as(A).patch('/company', { costCentersEnabled: false })).status).toBe(200);
    // 5202 is still flagged, but no centre is required while centres are off.
    const free = await journal(A, '2025-06-10', [
      { accountId: A.acc['5202'], debit: '5' },
      { accountId: A.acc['1101'], credit: '5' },
    ]);
    expect(free.post.status).toBe(201);
    expect((await as(A).get('/accounts')).body.find((a: { id: string }) => a.id === A.acc['5202']).costCenterRequired).toBe(true);
    expect((await centresOf(A, invoiceEntry))['4101']).toBe(cc.SALES);

    // Back on: required again, and a document without a header centre is refused when a line needs one.
    expect((await as(A).patch('/company', { costCentersEnabled: true })).status).toBe(200);
    expect((await as(A).patch(`/accounts/${A.acc['4101']}`, { costCenterRequired: true })).status).toBe(200);
    const inv = await as(A).post('/sales-invoices', {
      invoiceDate: '2025-06-11',
      customerId,
      warehouseId,
      paymentType: 'CREDIT',
      lines: [{ itemId, qty: '1', unitPrice: '10.000' }],
    });
    expect(inv.status).toBe(201);
    refused(await as(A).post(`/sales-invoices/${inv.body.id}/post`), 400, 'COST_CENTER_REQUIRED');
    expect((await as(A).get(`/sales-invoices/${inv.body.id}`)).body.status).toBe('DRAFT');
    // With the header centre it posts.
    const fixed = await api()
      .put(`/api/v1/sales-invoices/${inv.body.id}`)
      .set(auth(A.token))
      .send({
        invoiceDate: '2025-06-11',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        costCenterId: cc.SALES,
        lines: [{ itemId, qty: '1', unitPrice: '10.000' }],
      });
    expect(fixed.status).toBe(200);
    expect((await as(A).post(`/sales-invoices/${inv.body.id}/post`)).status).toBe(201);
    expect((await as(A).patch(`/accounts/${A.acc['4101']}`, { costCenterRequired: false })).status).toBe(200);
  }, T);

  it('CC8 job:integrity-check counts a journal line whose centre does not exist', async () => {
    const run = async () => {
      try {
        const { stdout } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'integrity-check', '--tenant', A.tenantId], {
          cwd: API_DIR,
          env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'test' },
        });
        return { code: 0, report: JSON.parse(stdout) };
      } catch (err) {
        const e = err as { code?: number; stdout?: string };
        return { code: e.code ?? -1, report: JSON.parse(e.stdout ?? '{}') };
      }
    };
    const check = (r: { checks: { name: string; ok: boolean; count: number }[] }) =>
      r.checks.find((c) => c.name === 'journal_lines.cost_center_id');

    const clean = await run();
    expect(clean.code).toBe(0);
    expect(check(clean.report)).toMatchObject({ ok: true, count: 0 });

    // Point one line of the reversal at a centre that does not exist, then restore it.
    const [line] = await db.query<{ id: bigint }[]>(
      'SELECT id FROM journal_lines WHERE tenant_id = ? AND journal_entry_id = ? AND cost_center_id IS NOT NULL',
      [A.tenantId, reversal],
    );
    await db.query('UPDATE journal_lines SET cost_center_id = 999999999 WHERE tenant_id = ? AND id = ?', [A.tenantId, line.id]);
    try {
      const dirty = await run();
      expect(dirty.code).toBe(1);
      expect(check(dirty.report)).toMatchObject({ ok: false, count: 1 });
    } finally {
      await db.query('UPDATE journal_lines SET cost_center_id = ? WHERE tenant_id = ? AND id = ?', [
        cc['ADM-HQ'],
        A.tenantId,
        line.id,
      ]);
    }
    expect(check((await run()).report)).toMatchObject({ ok: true, count: 0 });
    expect(reversed).not.toBe('');
  }, 120_000);

  it('final: trial balance balanced, stock:verify clean, B untouched', async () => {
    const tb = await as(A).get('/reports/trial-balance');
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
    const verify = await as(A).get('/stock/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tbB = await as(B).get('/reports/trial-balance');
    expect(tbB.body.rows).toEqual([]);
  }, T);
});
