/**
 * Paging and branch-scoped reads of the treasury (ADR-022, ADR-003 §10-§11):
 *  - GET /receipts, /payments (and their /pdf), /cash-transfers are numbered
 *    pages: total, filters, search, sort stability, bad parameters (400);
 *  - a MAIN-only ACCOUNTANT sees MAIN's vouchers only, total included, and gets
 *    404 for another branch's voucher on GET and /pdf;
 *  - GET /treasury/balances lists only the cash boxes of the caller's branches
 *    (a box without a branch stays visible; bank accounts are shown to all);
 *  - tenant B sees none of A's vouchers.
 * Tenant A has branches MAIN and B2, one cash box per branch and one without a
 * branch. The owner posts on both branches. Real MariaDB (erp_test) + built API.
 * Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3233;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `tr-${RUN}-${Math.random().toString(36).slice(2)}` });

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

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface ReceiptRow {
  id: string;
  branchId: string | null;
  receiptNo: string;
  receiptDate: string;
  partyId: string;
  cashAccountId: string;
  amount: string;
  referenceNo: string | null;
}
interface PaymentRow {
  id: string;
  branchId: string | null;
  paymentNo: string;
  paymentDate: string;
  partyId: string | null;
  cashAccountId: string;
  amount: string;
  referenceNo: string | null;
}
interface TransferRow {
  id: string;
  branchId: string | null;
  transferNo: string;
  transferDate: string;
  fromAccountId: string;
  amount: string;
  description: string | null;
}
/** What the test posted: the model the expectations are computed from. */
interface Doc {
  id: string;
  no: string;
  branch: 'MAIN' | 'B2';
  date: string;
  partyId?: string;
  cashAccountId: string;
  amount: string;
  ref: string;
}
interface BalanceRow {
  kind: string;
  id: string;
  account: { id: string };
}

const RECEIPTS = 12;
const RECEIPTS_ON_MAIN = 8;
const PAYMENTS = 8;
const PAYMENTS_ON_MAIN = 5;
const TRANSFERS = 6;
const TRANSFERS_ON_MAIN = 4;

/** Query string from a flat parameter map (values are encoded). */
const qs = (params: Record<string, string | number>) =>
  `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`;

describe('Paging and branch-scoped treasury reads (ADR-022, ADR-003)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let alphaId = '';
  let betaId = '';
  let supplierId = '';
  let cashAccountId = '';
  let cash2Id = '';
  let cash3Id = '';
  let bankAccountId = '';
  let boxMainId = '';
  let boxB2Id = '';
  let boxNoBranchId = '';
  let bankRowId = '';
  const receipts: Doc[] = [];
  const payments: Doc[] = [];
  const transfers: Doc[] = [];

  const listOf = async <T>(token: string, route: string, params: Record<string, string | number> = {}) => {
    const res = await api().get(`/api/v1/${route}${qs(params)}`).set(auth(token));
    if (res.status !== 200) throw new Error(`${route}${qs(params)}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as Page<T>;
  };
  /** Every page of a list, `size` rows at a time. */
  const allPagesOf = async <T extends { id: string }>(
    token: string,
    route: string,
    params: Record<string, string | number>,
    size: number,
  ) => {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const body = await listOf<T>(token, route, { ...params, pageSize: size, page });
      rows.push(...body.items);
      if (body.items.length < size) return { rows, total: body.total };
    }
  };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  const onMain = (docs: Doc[]) => docs.filter((d) => d.branch === 'MAIN');
  const onB2 = (docs: Doc[]) => docs.filter((d) => d.branch === 'B2');

  it('setup: tenant A with MAIN and B2, vouchers on both, an ACCOUNTANT on MAIN only, tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Treasury ${RUN}`, ownerName: 'Owner', email: `tr-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Treasury B ${RUN}`, ownerName: 'Owner B', email: `tr-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Treasury ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch; add B2 directly (as paging-branches does).
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'BASIC') WHERE id = ?", [t.tenantId]);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });

    const party = async (code: string, nameAr: string, partyType: 'CUSTOMER' | 'SUPPLIER') =>
      (await api().post('/api/v1/parties').set(auth(owner)).send({ code, nameAr, partyType })).body.id as string;
    // Codes carry the run id so a search for a code matches only this run's party.
    alphaId = await party(`TRA-${RUN}`, `Alpha ${RUN}`, 'CUSTOMER');
    betaId = await party(`TRB-${RUN}`, `Beta ${RUN}`, 'CUSTOMER');
    supplierId = await party(`TRS-${RUN}`, `Supplier ${RUN}`, 'SUPPLIER');

    // Ledger accounts: the chart's CASH and BANK accounts, plus two more cash accounts
    // (one per cash box that belongs to a branch) under the same parent.
    const accounts = await api().get('/api/v1/accounts').set(auth(owner));
    const flat: { id: string; controlType?: string }[] = [];
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;
    bankAccountId = flat.find((a) => a.controlType === 'BANK')!.id;
    const [cashRow] = (await db.query('SELECT parent_id AS parentId FROM accounts WHERE tenant_id = ? AND id = ?', [
      t.tenantId,
      BigInt(cashAccountId),
    ])) as { parentId: bigint | null }[];
    expect(cashRow.parentId).not.toBeNull();
    const cashAccount = async (name: string) => {
      const res = await api()
        .post('/api/v1/accounts')
        .set(auth(owner))
        .send({ nameAr: name, accountType: 'ASSET', parentId: String(cashRow.parentId), controlType: 'CASH', isPostable: true });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    cash2Id = await cashAccount(`صندوق ${RUN} 2`);
    cash3Id = await cashAccount(`صندوق ${RUN} 3`);

    // One cash box per branch and one without a branch (cash boxes are branch-scoped by the column).
    const box = async (code: string, accountId: string, branchId?: string) => {
      const res = await api()
        .post('/api/v1/cash-boxes')
        .set(auth(owner))
        .send({ code, name: code, accountId, ...(branchId ? { branchId } : {}) });
      expect(res.status).toBe(201);
      expect(res.body.branchId).toBe(branchId ?? null);
      return res.body.id as string;
    };
    boxMainId = await box(`M${RUN}`, cashAccountId, mainId);
    boxB2Id = await box(`B${RUN}`, cash2Id, b2Id);
    boxNoBranchId = await box(`N${RUN}`, cash3Id);
    const bank = await api().post('/api/v1/bank-accounts').set(auth(owner)).send({ bankName: `Bank ${RUN}`, accountId: bankAccountId });
    expect(bank.status).toBe(201);
    bankRowId = bank.body.id as string;

    // Vouchers: dates repeat (2025-03-01..05), so equal dates test the id tie-break.
    for (let i = 0; i < RECEIPTS; i += 1) {
      const main = i < RECEIPTS_ON_MAIN;
      const partyId = i % 2 === 0 ? alphaId : betaId;
      const date = `2025-03-0${1 + (i % 5)}`;
      const amount = `${10 + i}.000`;
      const ref = `${RUN}-${main ? 'MAIN' : 'B2'}-${i}`;
      const cash = main ? cashAccountId : cash2Id;
      const res = await api()
        .post('/api/v1/receipts')
        .set(auth(owner))
        .set('X-Branch-Id', main ? mainId : b2Id)
        .set(idem())
        .send({ receiptDate: date, partyType: 'CUSTOMER', partyId, cashAccountId: cash, amount, referenceNo: ref });
      if (res.status !== 201) throw new Error(`receipt ${i}: ${res.status} ${JSON.stringify(res.body)}`);
      receipts.push({ id: res.body.id, no: res.body.receiptNo, branch: main ? 'MAIN' : 'B2', date, partyId, cashAccountId: cash, amount, ref });
    }
    for (let i = 0; i < PAYMENTS; i += 1) {
      const main = i < PAYMENTS_ON_MAIN;
      const date = `2025-03-0${1 + (i % 5)}`;
      const amount = `${20 + i}.000`;
      const ref = `${RUN}-${main ? 'MAIN' : 'B2'}-P${i}`;
      const cash = main ? cashAccountId : cash2Id;
      const res = await api()
        .post('/api/v1/payments')
        .set(auth(owner))
        .set('X-Branch-Id', main ? mainId : b2Id)
        .set(idem())
        .send({ paymentDate: date, partyType: 'SUPPLIER', partyId: supplierId, cashAccountId: cash, amount, referenceNo: ref });
      if (res.status !== 201) throw new Error(`payment ${i}: ${res.status} ${JSON.stringify(res.body)}`);
      payments.push({ id: res.body.id, no: res.body.paymentNo, branch: main ? 'MAIN' : 'B2', date, partyId: supplierId, cashAccountId: cash, amount, ref });
    }
    for (let i = 0; i < TRANSFERS; i += 1) {
      const main = i < TRANSFERS_ON_MAIN;
      const date = `2025-03-0${1 + (i % 5)}`;
      const amount = `${5 + i}.000`;
      const ref = `${RUN} ${main ? 'MAIN' : 'B2'} move ${i}`;
      const from = main ? cashAccountId : cash2Id;
      const res = await api()
        .post('/api/v1/cash-transfers')
        .set(auth(owner))
        .set('X-Branch-Id', main ? mainId : b2Id)
        .set(idem())
        .send({ transferDate: date, fromAccountId: from, toAccountId: bankAccountId, amount, description: ref });
      if (res.status !== 201) throw new Error(`transfer ${i}: ${res.status} ${JSON.stringify(res.body)}`);
      transfers.push({ id: res.body.id, no: res.body.transferNo, branch: main ? 'MAIN' : 'B2', date, cashAccountId: from, amount, ref });
    }

    const member = await addMember(BASE, owner, {
      email: `tr-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 180_000);

  describe('GET /receipts', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listOf<ReceiptRow>(owner, 'receipts', { pageSize: 5 });
      expect(first).toMatchObject({ page: 1, pageSize: 5, total: RECEIPTS });
      expect(first.items).toHaveLength(5);
      const last = await listOf<ReceiptRow>(owner, 'receipts', { pageSize: 5, page: 3 });
      expect(last.items).toHaveLength(2);
      expect(last.total).toBe(RECEIPTS);
      expect(await listOf(owner, 'receipts', { pageSize: 5, page: 4 })).toMatchObject({ items: [], page: 4, total: RECEIPTS });
      expect(await listOf(owner, 'receipts')).toMatchObject({ page: 1, pageSize: 20, total: RECEIPTS });
    });

    it('filters and search narrow the total, for the owner and for the MAIN-only accountant', async () => {
      const alpha = receipts.filter((r) => r.partyId === alphaId);
      const b2 = onB2(receipts);
      const inRange = receipts.filter((r) => r.date >= '2025-03-02' && r.date <= '2025-03-03');
      expect((await listOf(owner, 'receipts', { partyId: alphaId })).total).toBe(alpha.length);
      expect((await listOf(owner, 'receipts', { cashAccountId: cash2Id })).total).toBe(b2.length);
      expect((await listOf(owner, 'receipts', { from: '2025-03-02', to: '2025-03-03' })).total).toBe(inRange.length);
      expect((await listOf(owner, 'receipts', { q: `${RUN}-B2` })).total).toBe(b2.length);
      const alphaPage = (await listOf<ReceiptRow>(owner, 'receipts', { q: `Alpha ${RUN}`, pageSize: 100 })).items;
      expect(alphaPage.every((r) => r.partyId === alphaId)).toBe(true);
      expect((await listOf(owner, 'receipts', { q: `Alpha ${RUN}` })).total).toBe(alpha.length);

      // Search by receipt number (a number may be a prefix of another, so only check the hit), then by party code.
      const b2Receipt = receipts[RECEIPTS_ON_MAIN];
      const byNo = (await listOf<ReceiptRow>(owner, 'receipts', { q: b2Receipt.no, pageSize: 100 })).items;
      expect(ids(byNo)).toContain(b2Receipt.id);
      expect(byNo.every((r) => r.receiptNo.includes(b2Receipt.no))).toBe(true);
      expect((await listOf(owner, 'receipts', { q: `TRA-${RUN}` })).total).toBe(alpha.length);

      // The accountant: MAIN's receipts only, the same filters narrowed to MAIN.
      expect((await listOf(accountant, 'receipts', { partyId: alphaId })).total).toBe(onMain(alpha).length);
      expect((await listOf(accountant, 'receipts', { cashAccountId: cash2Id })).total).toBe(0);
      expect((await listOf(accountant, 'receipts', { q: `${RUN}-B2` })).total).toBe(0);
      expect((await listOf(accountant, 'receipts', { from: '2025-03-02', to: '2025-03-03' })).total).toBe(
        onMain(inRange).length,
      );
      expect((await listOf(accountant, 'receipts', { q: `Alpha ${RUN}` })).total).toBe(onMain(alpha).length);
    });

    it('sort is stable: pages of 5 read the same rows in the same order as one page', async () => {
      for (const sort of ['-receiptDate', 'receiptDate', 'receiptNo', '-receiptNo', 'amount', '-amount']) {
        const one = ids((await listOf<ReceiptRow>(owner, 'receipts', { sort, pageSize: 100 })).items);
        const paged = await allPagesOf<ReceiptRow>(owner, 'receipts', { sort }, 5);
        expect(paged.total).toBe(RECEIPTS);
        expect(ids(paged.rows)).toEqual(one);
        expect(new Set(one).size).toBe(RECEIPTS);
      }
      // Newest first by default; equal dates by id, newest id first.
      const rows = (await listOf<ReceiptRow>(owner, 'receipts', { pageSize: 100 })).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        expect(a.receiptDate >= b.receiptDate).toBe(true);
        if (a.receiptDate === b.receiptDate) expect(BigInt(a.id) > BigInt(b.id)).toBe(true);
      }
      const byAmount = (await listOf<ReceiptRow>(owner, 'receipts', { sort: 'amount', pageSize: 100 })).items.map((r) =>
        Number(r.amount),
      );
      expect(byAmount).toEqual([...byAmount].sort((x, y) => x - y));
    });

    it.each([
      ['page=0'],
      ['page=1.5'],
      ['page=10001'],
      ['pageSize=0'],
      ['pageSize=101'],
      ['sort=customer'],
      ['sort=--receiptDate'],
      [`q=${'x'.repeat(101)}`],
      ['partyId=abc'],
      ['cashAccountId=0'],
      ['from=2025-3-1'],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/receipts?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get('/api/v1/receipts?from=2025-03-05&to=2025-03-01').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists MAIN's receipts only, total included", async () => {
      const all = await allPagesOf<ReceiptRow>(accountant, 'receipts', {}, 3);
      expect(all.total).toBe(RECEIPTS_ON_MAIN);
      expect(all.rows).toHaveLength(RECEIPTS_ON_MAIN);
      expect(all.rows.every((r) => r.branchId === mainId)).toBe(true);
      expect((await listOf<ReceiptRow>(owner, 'receipts', { pageSize: 100 })).items.some((r) => r.branchId === b2Id)).toBe(true);
    });

    it("tenant B sees none of A's receipts, even filtered by A's party", async () => {
      expect(await listOf(tenantB, 'receipts')).toMatchObject({ items: [], total: 0 });
      expect((await listOf(tenantB, 'receipts', { partyId: alphaId })).total).toBe(0);
      expect((await listOf(tenantB, 'receipts', { q: `Alpha ${RUN}` })).total).toBe(0);
    });
  });

  describe('GET /receipts/:id and /pdf', () => {
    it("another branch's receipt answers 404 to a MAIN-only accountant, on GET and /pdf", async () => {
      const b2Receipt = receipts[RECEIPTS_ON_MAIN];
      for (const suffix of ['', '/pdf']) {
        const res = await api().get(`/api/v1/receipts/${b2Receipt.id}${suffix}`).set(auth(accountant));
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
    });

    it("the accountant opens and prints MAIN's receipt; the owner opens B2's", async () => {
      const mainReceipt = receipts[0];
      const view = await api().get(`/api/v1/receipts/${mainReceipt.id}`).set(auth(accountant));
      expect(view.status).toBe(200);
      expect(view.body.branchId).toBe(mainId);
      const pdf = await api().get(`/api/v1/receipts/${mainReceipt.id}/pdf`).set(auth(accountant));
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      const b2Receipt = receipts[RECEIPTS_ON_MAIN];
      expect((await api().get(`/api/v1/receipts/${b2Receipt.id}`).set(auth(owner))).status).toBe(200);
      expect((await api().get(`/api/v1/receipts/${b2Receipt.id}/pdf`).set(auth(owner))).status).toBe(200);
    });

    it("tenant B gets 404 for A's receipt and its PDF", async () => {
      for (const suffix of ['', '/pdf']) {
        const res = await api().get(`/api/v1/receipts/${receipts[0].id}${suffix}`).set(auth(tenantB));
        expect(res.status).toBe(404);
      }
    });
  });

  describe('GET /payments', () => {
    it('numbered pages with the total; a page past the end is empty', async () => {
      const first = await listOf<PaymentRow>(owner, 'payments', { pageSize: 3 });
      expect(first).toMatchObject({ page: 1, pageSize: 3, total: PAYMENTS });
      expect(first.items).toHaveLength(3);
      expect((await listOf(owner, 'payments', { pageSize: 3, page: 3 })).items).toHaveLength(2);
      expect(await listOf(owner, 'payments', { pageSize: 3, page: 4 })).toMatchObject({ items: [], total: PAYMENTS });
    });

    it('filters and search narrow the total, for the owner and for the accountant', async () => {
      expect((await listOf(owner, 'payments', { partyId: supplierId })).total).toBe(PAYMENTS);
      expect((await listOf(owner, 'payments', { cashAccountId: cash2Id })).total).toBe(onB2(payments).length);
      expect((await listOf(owner, 'payments', { from: '2025-03-01', to: '2025-03-01' })).total).toBe(
        payments.filter((p) => p.date === '2025-03-01').length,
      );
      expect((await listOf(owner, 'payments', { q: `Supplier ${RUN}` })).total).toBe(PAYMENTS);
      expect((await listOf(owner, 'payments', { q: `${RUN}-B2` })).total).toBe(onB2(payments).length);
      const b2Payment = payments[PAYMENTS_ON_MAIN];
      const byNo = (await listOf<PaymentRow>(owner, 'payments', { q: b2Payment.no, pageSize: 100 })).items;
      expect(ids(byNo)).toContain(b2Payment.id);
      expect(byNo.every((r) => r.paymentNo.includes(b2Payment.no))).toBe(true);

      expect((await listOf(accountant, 'payments', { q: `Supplier ${RUN}` })).total).toBe(PAYMENTS_ON_MAIN);
      expect((await listOf(accountant, 'payments', { cashAccountId: cash2Id })).total).toBe(0);
      expect((await listOf(accountant, 'payments', { q: `${RUN}-B2` })).total).toBe(0);
    });

    it('sort is stable: pages of 3 read the same rows in the same order as one page', async () => {
      for (const sort of ['-paymentDate', 'paymentDate', 'paymentNo', 'amount', '-amount']) {
        const one = ids((await listOf<PaymentRow>(owner, 'payments', { sort, pageSize: 100 })).items);
        const paged = await allPagesOf<PaymentRow>(owner, 'payments', { sort }, 3);
        expect(paged.total).toBe(PAYMENTS);
        expect(ids(paged.rows)).toEqual(one);
        expect(new Set(one).size).toBe(PAYMENTS);
      }
    });

    it.each([['page=0'], ['pageSize=101'], ['sort=paymentNo-'], [`q=${'x'.repeat(101)}`], ['supplierId=1']])(
      'bad parameter %s → 400 VALIDATION',
      async (query) => {
        const res = await api().get(`/api/v1/payments?${query}`).set(auth(owner));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
      },
    );

    it("a MAIN-only accountant lists MAIN's payments only; GET and /pdf of another branch's are 404", async () => {
      const all = await allPagesOf<PaymentRow>(accountant, 'payments', {}, 2);
      expect(all.total).toBe(PAYMENTS_ON_MAIN);
      expect(all.rows.every((r) => r.branchId === mainId)).toBe(true);
      const b2Payment = payments[PAYMENTS_ON_MAIN];
      for (const suffix of ['', '/pdf']) {
        expect((await api().get(`/api/v1/payments/${b2Payment.id}${suffix}`).set(auth(accountant))).status).toBe(404);
      }
      const mainPayment = payments[0];
      expect((await api().get(`/api/v1/payments/${mainPayment.id}`).set(auth(accountant))).status).toBe(200);
      const pdf = await api().get(`/api/v1/payments/${mainPayment.id}/pdf`).set(auth(accountant));
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect((await api().get(`/api/v1/payments/${b2Payment.id}/pdf`).set(auth(owner))).status).toBe(200);
    });

    it("tenant B sees none of A's payments, and gets 404 for one by id", async () => {
      expect(await listOf(tenantB, 'payments')).toMatchObject({ items: [], total: 0 });
      expect((await listOf(tenantB, 'payments', { q: `Supplier ${RUN}` })).total).toBe(0);
      expect((await api().get(`/api/v1/payments/${payments[0].id}/pdf`).set(auth(tenantB))).status).toBe(404);
    });
  });

  describe('GET /cash-transfers', () => {
    it('numbered pages with the total; a page past the end is empty', async () => {
      const first = await listOf<TransferRow>(owner, 'cash-transfers', { pageSize: 4 });
      expect(first).toMatchObject({ page: 1, pageSize: 4, total: TRANSFERS });
      expect(first.items).toHaveLength(4);
      expect((await listOf(owner, 'cash-transfers', { pageSize: 4, page: 2 })).items).toHaveLength(2);
      expect(await listOf(owner, 'cash-transfers', { pageSize: 4, page: 3 })).toMatchObject({ items: [], total: TRANSFERS });
    });

    it('filters and search narrow the total, for the owner and for the accountant', async () => {
      expect((await listOf(owner, 'cash-transfers', { q: `${RUN} B2` })).total).toBe(onB2(transfers).length);
      expect((await listOf(owner, 'cash-transfers', { q: `${RUN} MAIN` })).total).toBe(onMain(transfers).length);
      expect((await listOf(owner, 'cash-transfers', { from: '2025-03-04', to: '2025-03-05' })).total).toBe(
        transfers.filter((t) => t.date >= '2025-03-04' && t.date <= '2025-03-05').length,
      );
      const b2Transfer = transfers[TRANSFERS_ON_MAIN];
      const byNo = (await listOf<TransferRow>(owner, 'cash-transfers', { q: b2Transfer.no, pageSize: 100 })).items;
      expect(ids(byNo)).toContain(b2Transfer.id);
      expect(byNo.every((r) => r.transferNo.includes(b2Transfer.no))).toBe(true);

      expect((await listOf(accountant, 'cash-transfers', { q: `${RUN} B2` })).total).toBe(0);
      expect((await listOf(accountant, 'cash-transfers', { q: `${RUN} MAIN` })).total).toBe(TRANSFERS_ON_MAIN);
    });

    it('sort is stable: pages of 4 read the same rows in the same order as one page', async () => {
      for (const sort of ['-transferDate', 'transferDate', 'transferNo', 'amount', '-amount']) {
        const one = ids((await listOf<TransferRow>(owner, 'cash-transfers', { sort, pageSize: 100 })).items);
        const paged = await allPagesOf<TransferRow>(owner, 'cash-transfers', { sort }, 4);
        expect(paged.total).toBe(TRANSFERS);
        expect(ids(paged.rows)).toEqual(one);
        expect(new Set(one).size).toBe(TRANSFERS);
      }
    });

    it.each([['page=0'], ['pageSize=101'], ['sort=bogus'], ['from=2025/03/01'], ['branchId=1']])(
      'bad parameter %s → 400 VALIDATION',
      async (query) => {
        const res = await api().get(`/api/v1/cash-transfers?${query}`).set(auth(owner));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
      },
    );

    it("a MAIN-only accountant lists MAIN's transfers only; GET of another branch's is 404", async () => {
      const all = await allPagesOf<TransferRow>(accountant, 'cash-transfers', {}, 3);
      expect(all.total).toBe(TRANSFERS_ON_MAIN);
      expect(all.rows.every((r) => r.branchId === mainId)).toBe(true);
      const b2Transfer = transfers[TRANSFERS_ON_MAIN];
      const res = await api().get(`/api/v1/cash-transfers/${b2Transfer.id}`).set(auth(accountant));
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect((await api().get(`/api/v1/cash-transfers/${transfers[0].id}`).set(auth(accountant))).status).toBe(200);
    });

    it("tenant B sees none of A's transfers and gets 404 for one by id", async () => {
      expect(await listOf(tenantB, 'cash-transfers')).toMatchObject({ items: [], total: 0 });
      expect((await api().get(`/api/v1/cash-transfers/${transfers[0].id}`).set(auth(tenantB))).status).toBe(404);
    });
  });

  describe('GET /treasury/balances', () => {
    it('lists every cash box to the owner, and only the caller branches\' boxes to the accountant', async () => {
      const ownerRows = (await api().get('/api/v1/treasury/balances').set(auth(owner))).body.rows as BalanceRow[];
      const ownerBoxes = ownerRows.filter((r) => r.kind === 'CASH_BOX').map((r) => r.id);
      expect(ownerBoxes.sort()).toEqual([boxMainId, boxB2Id, boxNoBranchId].sort());

      const accRows = (await api().get('/api/v1/treasury/balances').set(auth(accountant))).body.rows as BalanceRow[];
      const accBoxes = accRows.filter((r) => r.kind === 'CASH_BOX').map((r) => r.id);
      // MAIN's box and the box without a branch; B2's box is hidden.
      expect(accBoxes.sort()).toEqual([boxMainId, boxNoBranchId].sort());
      // The ledger account of B2's box is not listed under another kind either.
      expect(accRows.some((r) => r.account.id === cash2Id)).toBe(false);
      expect(ownerRows.some((r) => r.account.id === cash2Id)).toBe(true);
      // Bank accounts have no branch: everyone sees them.
      expect(accRows.some((r) => r.kind === 'BANK_ACCOUNT')).toBe(true);
    });
  });

  describe('PUT /cash-boxes and /bank-accounts (validated bodies, branch)', () => {
    /** The MAIN branch of tenant B, which tenant A must not reach. */
    const tenantBBranch = async () => {
      const [row] = (await db.query(
        "SELECT id FROM branches WHERE tenant_id = (SELECT id FROM tenants WHERE name = ?) AND code = 'MAIN'",
        [`Treasury B ${RUN}`],
      )) as { id: bigint }[];
      return String(row.id);
    };
    const boxIdsOf = async (token: string) =>
      ((await api().get('/api/v1/treasury/balances').set(auth(token))).body.rows as BalanceRow[])
        .filter((r) => r.kind === 'CASH_BOX')
        .map((r) => r.id)
        .sort();

    it('an unknown field on PUT /cash-boxes/:id → 400 VALIDATION', async () => {
      const res = await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(owner)).send({ name: 'X', bogus: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('an unknown field on PUT /bank-accounts/:id → 400 VALIDATION', async () => {
      const res = await api().put(`/api/v1/bank-accounts/${bankRowId}`).set(auth(owner)).send({ bankName: 'X', bogus: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('a too-long name on PUT /cash-boxes/:id → 400, and null for a name that cannot be cleared → 400', async () => {
      const long = await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(owner)).send({ name: 'x'.repeat(192) });
      expect(long.status).toBe(400);
      const nulled = await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(owner)).send({ name: null });
      expect(nulled.status).toBe(400);
    });

    it("a cash box cannot be created on another tenant's branch → 404", async () => {
      const res = await api()
        .post('/api/v1/cash-boxes')
        .set(auth(owner))
        .send({ code: `Y${RUN}`, name: 'Y', accountId: cash3Id, branchId: await tenantBBranch() });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it("a MAIN-only accountant cannot create a box on B2, nor move B2's box (to MAIN or to no branch) → 403", async () => {
      const create = await api()
        .post('/api/v1/cash-boxes')
        .set(auth(accountant))
        .send({ code: `X${RUN}`, name: 'X', accountId: cash3Id, branchId: b2Id });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      for (const branchId of [mainId, null]) {
        const move = await api().put(`/api/v1/cash-boxes/${boxB2Id}`).set(auth(accountant)).send({ branchId });
        expect(move.status).toBe(403);
        expect(move.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      }
      const listed = (await api().get('/api/v1/cash-boxes').set(auth(owner))).body as { id: string; branchId: string | null }[];
      expect(listed.find((b) => b.id === boxB2Id)?.branchId).toBe(b2Id);
    });

    it("a MAIN-only accountant cannot rename, deactivate, re-link or delete B2's box → 403, and it is unchanged", async () => {
      for (const body of [{ name: 'Hijack' }, { isActive: false }, { accountId: cash3Id }]) {
        const res = await api().put(`/api/v1/cash-boxes/${boxB2Id}`).set(auth(accountant)).send(body);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      }
      const del = await api().delete(`/api/v1/cash-boxes/${boxB2Id}`).set(auth(accountant));
      expect(del.status).toBe(403);
      expect(del.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      const listed = (await api().get('/api/v1/cash-boxes').set(auth(owner))).body as {
        id: string;
        name: string;
        isActive: boolean;
        branchId: string | null;
        account: { id: string };
      }[];
      const box = listed.find((b) => b.id === boxB2Id)!;
      expect(box).toMatchObject({ name: `B${RUN}`, isActive: true, branchId: b2Id });
      expect(box.account.id).toBe(cash2Id);
      // Its own branch's box stays writable for the accountant.
      expect((await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(accountant)).send({ isActive: true })).status).toBe(200);
    });

    it('only a member with every branch moves a box to or from "no branch" → 403 ALL_BRANCHES_REQUIRED', async () => {
      const take = await api().put(`/api/v1/cash-boxes/${boxNoBranchId}`).set(auth(accountant)).send({ branchId: mainId });
      expect(take.status).toBe(403);
      expect(take.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
      const share = await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(accountant)).send({ branchId: null });
      expect(share.status).toBe(403);
      expect(share.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
      const listed = (await api().get('/api/v1/cash-boxes').set(auth(owner))).body as { id: string; branchId: string | null }[];
      expect(listed.find((b) => b.id === boxNoBranchId)?.branchId).toBeNull();
      expect(listed.find((b) => b.id === boxMainId)?.branchId).toBe(mainId);
    });

    it('the owner moves a box to B2, then to no branch, then back to MAIN; the accountant sees it accordingly', async () => {
      const put = (branchId: string | null) => api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(owner)).send({ branchId });

      const toB2 = await put(b2Id);
      expect(toB2.status).toBe(200);
      expect(toB2.body.branchId).toBe(b2Id);
      expect(await boxIdsOf(accountant)).toEqual([boxNoBranchId]);

      const toNone = await put(null);
      expect(toNone.status).toBe(200);
      expect(toNone.body.branchId).toBeNull();
      expect(await boxIdsOf(accountant)).toEqual([boxMainId, boxNoBranchId].sort());

      // Restore the state the other tests expect: the box is on MAIN again.
      const restored = await put(mainId);
      expect(restored.status).toBe(200);
      expect(restored.body.branchId).toBe(mainId);
      expect(await boxIdsOf(accountant)).toEqual([boxMainId, boxNoBranchId].sort());
    });

    it("tenant B cannot update A's cash box or bank account → 404", async () => {
      const box = await api().put(`/api/v1/cash-boxes/${boxMainId}`).set(auth(tenantB)).send({ name: 'Hijack' });
      expect(box.status).toBe(404);
      const bank = await api().put(`/api/v1/bank-accounts/${bankRowId}`).set(auth(tenantB)).send({ bankName: 'Hijack' });
      expect(bank.status).toBe(404);
    });

    it('clears ibanMasked with null', async () => {
      const iban = 'JO94TEST0000000000000001';
      const set = await api().put(`/api/v1/bank-accounts/${bankRowId}`).set(auth(owner)).send({ ibanMasked: iban });
      expect(set.status).toBe(200);
      expect(set.body.ibanMasked).toBe(iban);
      const cleared = await api().put(`/api/v1/bank-accounts/${bankRowId}`).set(auth(owner)).send({ ibanMasked: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.ibanMasked).toBeNull();
      const listed = (await api().get('/api/v1/bank-accounts').set(auth(owner))).body as { id: string; ibanMasked: string | null }[];
      expect(listed.find((b) => b.id === bankRowId)?.ibanMasked).toBeNull();
    });
  });
});
