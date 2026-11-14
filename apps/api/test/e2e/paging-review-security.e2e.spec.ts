/**
 * Review fixes on the branch scope (ADR-003 §10, §13) and the paging snapshot (ADR-022 §3).
 *  - S2: the company archive (GET /export/tenant-data) needs every branch;
 *  - S3: ACCOUNT_HAS_BALANCE shows the company-wide amount only to a member with every branch;
 *  - S4: a member whose only assigned branch is inactive is refused on every guarded request;
 *  - S5: company-wide cash accounts with no cash box are hidden from a branch-limited member;
 *  - ALLOC: auto-allocation of a receipt settles only the caller's branches' invoices.
 * Tenant A has MAIN, B2 and B3 (B3 is deactivated later for S4), one warehouse on MAIN and on B2.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3238;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `rs-${RUN}-${Math.random().toString(36).slice(2)}` });

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
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

describe('Review fixes: branch scope and snapshot reads (ADR-003, ADR-022)', () => {
  let owner = '';
  let accountant = '';
  let restrictedOwner = '';
  let b3Member = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let b3Id = '';
  let alphaId = '';
  let itemId = '';
  let w1 = '';
  let w2 = '';
  let mainInvoice = '';
  let b2Invoice = '';
  let cashId = '';
  let s3Id = '';
  let s3Offset = '';

  const createAccount = async (body: Record<string, unknown>): Promise<string> => {
    const res = await api().post('/api/v1/accounts').set(auth(owner)).send(body);
    if (res.status !== 201) throw new Error(`account ${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };

  const postJournal = async (lines: object[], entryDate: string): Promise<void> => {
    const draft = await api().post('/api/v1/journal-entries').set(auth(owner)).send({ entryDate, description: 'review', lines });
    if (draft.status !== 201) throw new Error(`draft: ${draft.status} ${JSON.stringify(draft.body)}`);
    const posted = await api().post(`/api/v1/journal-entries/${draft.body.id}/post`).set(auth(owner)).set(idem());
    if (posted.status !== 201) throw new Error(`post: ${posted.status} ${JSON.stringify(posted.body)}`);
  };

  it('setup: tenant A with MAIN, B2 and B3, invoices on MAIN and B2, members, tenant B', async () => {
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
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch; insert B2 and B3 directly (as paging-branches.e2e does).
    const now = new Date();
    const insertBranch = async (code: string, nameAr: string) =>
      String(
        ((await db.query(
          'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
          [t.tenantId, t.companyId, code, nameAr, now, now],
        )) as { insertId: bigint }).insertId,
      );
    b2Id = await insertBranch('B2', 'فرع 2');
    b3Id = await insertBranch('B3', 'فرع 3');
    // Two warehouses (one per branch) need the BASIC plan; TRIAL allows one.
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'BASIC') WHERE id = ?", [t.tenantId]);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    const warehouse = async (code: string, branchId: string) => {
      const res = await api().post('/api/v1/warehouses').set(auth(owner)).send({ code, nameAr: code, branchId });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    w1 = await warehouse('W1', mainId);
    w2 = await warehouse('W2', b2Id);
    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'RS-I', nameAr: 'RS item', baseUnitId: pcs }))
      .body.id as string;
    alphaId = (
      await api()
        .post('/api/v1/parties')
        .set(auth(owner))
        .send({ code: 'RS-CA', nameAr: `Alpha ${RUN}`, partyType: 'CUSTOMER' })
    ).body.id as string;

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

    // One open credit invoice per branch, both to Alpha; posted in date order.
    const invoice = async (branch: string, warehouseId: string, invoiceDate: string, unitPrice: string) => {
      const res = await api()
        .post('/api/v1/sales-invoices')
        .set(auth(owner))
        .set('X-Branch-Id', branch)
        .send({ invoiceDate, customerId: alphaId, warehouseId, paymentType: 'CREDIT', lines: [{ itemId, qty: '1', unitPrice }] });
      expect(res.status).toBe(201);
      const posted = await api().post(`/api/v1/sales-invoices/${res.body.id}/post`).set(auth(owner)).set(idem());
      if (posted.status !== 201) throw new Error(`post invoice: ${posted.status} ${JSON.stringify(posted.body)}`);
      return res.body.id as string;
    };
    mainInvoice = await invoice(mainId, w1, '2025-03-01', '10.000');
    b2Invoice = await invoice(b2Id, w2, '2025-03-02', '20.000');

    accountant = (
      await addMember(BASE, owner, {
        email: `review-acct-${RUN}@test.dev`,
        roleCode: 'ACCOUNTANT',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId],
      })
    ).token;
    // A second OWNER, limited to MAIN: the owner role itself can be branch-limited through the API.
    restrictedOwner = (
      await addMember(BASE, owner, {
        email: `review-owner2-${RUN}@test.dev`,
        roleCode: 'OWNER',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId],
      })
    ).token;
    // An accountant whose only branch is B3, deactivated in the S4 test.
    b3Member = (
      await addMember(BASE, owner, {
        email: `review-b3-${RUN}@test.dev`,
        roleCode: 'ACCOUNTANT',
        password: PASS,
        defaultBranchId: b3Id,
        branchIds: [b3Id],
      })
    ).token;

    // A CASH-control account with no cash box behind it (S5 and the receipt in ALLOC).
    cashId = await createAccount({ code: '1981', nameAr: 'نقدية بلا صندوق', accountType: 'ASSET', controlType: 'CASH', isPostable: true });
    // A balance-sheet account with a posted balance (S3).
    s3Id = await createAccount({ code: '1982', nameAr: 'حساب رصيد', accountType: 'ASSET', isPostable: true });
    s3Offset = await createAccount({ code: '1983', nameAr: 'مقابل رصيد', accountType: 'ASSET', isPostable: true });
    await postJournal(
      [
        { accountId: s3Id, debit: '25.000' },
        { accountId: s3Offset, credit: '25.000' },
      ],
      '2025-03-05',
    );
    // A journal line on the unlinked CASH account: the money S5 must keep from the accountant.
    await postJournal(
      [
        { accountId: cashId, debit: '50.000' },
        { accountId: s3Offset, credit: '50.000' },
      ],
      '2025-03-06',
    );

  }, 120_000);

  describe('S2: GET /export/tenant-data needs every branch (ADR-003 §13)', () => {
    it('a branch-limited owner and a branch-limited accountant are refused with ALL_BRANCHES_REQUIRED', async () => {
      for (const token of [restrictedOwner, accountant]) {
        const res = await api().get('/api/v1/export/tenant-data').set(auth(token));
        expect(res.status).toBe(403);
        expect((res.body as ErrorBody).error.code).toBe('ALL_BRANCHES_REQUIRED');
      }
    });

    it('the owner with every branch still downloads the archive', async () => {
      const res = await api().get('/api/v1/export/tenant-data').set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/zip');
    });
  });

  describe('S3: ACCOUNT_HAS_BALANCE shows the amount only to a member with every branch', () => {
    it('the owner sees the balance; the branch-limited accountant gets the code without any amount', async () => {
      const deactivate = (token: string) =>
        api().patch(`/api/v1/accounts/${s3Id}`).set(auth(token)).send({ isActive: false });

      const asOwner = await deactivate(owner);
      expect(asOwner.status).toBe(409);
      expect((asOwner.body as ErrorBody).error.code).toBe('ACCOUNT_HAS_BALANCE');
      expect((asOwner.body as ErrorBody).error.details?.balance).toBe('25.000');

      const asAccountant = await deactivate(accountant);
      expect(asAccountant.status).toBe(409);
      expect((asAccountant.body as ErrorBody).error.code).toBe('ACCOUNT_HAS_BALANCE');
      expect((asAccountant.body as ErrorBody).error.details?.balance).toBeUndefined();
      expect(JSON.stringify(asAccountant.body)).not.toContain('25.000');
    });
  });

  describe('S4: a member whose only assigned branch is inactive (BRANCH_NOT_ALLOWED)', () => {
    it('is refused on every guarded request once the branch is deactivated', async () => {
      const before = await api().get('/api/v1/sales-invoices').set(auth(b3Member));
      expect(before.status).toBe(200);

      await db.query('UPDATE branches SET is_active = 0 WHERE id = ?', [b3Id]);
      try {
        // Guards run before validation, so an empty body still reaches the branch check.
        const listed = await api().get('/api/v1/sales-invoices').set(auth(b3Member));
        expect(listed.status).toBe(403);
        expect((listed.body as ErrorBody).error.code).toBe('BRANCH_NOT_ALLOWED');
        const created = await api().post('/api/v1/sales-invoices').set(auth(b3Member)).set(idem()).send({});
        expect(created.status).toBe(403);
        expect((created.body as ErrorBody).error.code).toBe('BRANCH_NOT_ALLOWED');
      } finally {
        await db.query('UPDATE branches SET is_active = 1 WHERE id = ?', [b3Id]);
      }
    });
  });

  describe('S5: cash accounts with no cash box follow the branch scope (ADR-003 §10)', () => {
    it('a CASH account with no box is listed for the owner, not for the branch-limited accountant', async () => {
      const ownerRows = (await api().get('/api/v1/treasury/balances').set(auth(owner))).body.rows as {
        kind: string;
        balance: string;
        account: { id: string };
      }[];
      expect(ownerRows.find((r) => r.account.id === cashId)).toMatchObject({ kind: 'ACCOUNT', balance: '50.000' });

      const accRows = (await api().get('/api/v1/treasury/balances').set(auth(accountant))).body.rows as {
        account: { id: string };
      }[];
      expect(accRows.some((r) => r.account.id === cashId)).toBe(false);

      // Tenant B never sees A's accounts.
      const bRows = (await api().get('/api/v1/treasury/balances').set(auth(tenantB))).body.rows as {
        account: { id: string };
      }[];
      expect(bRows.some((r) => r.account.id === cashId)).toBe(false);
    });
  });

  describe('ALLOC: auto-allocation follows the caller branches (ADR-003 §10)', () => {
    it('a MAIN-only accountant receipt with autoAllocate settles MAIN invoices and leaves B2 alone', async () => {
      const res = await api()
        .post('/api/v1/receipts')
        .set(auth(accountant))
        .set(idem())
        .send({
          receiptDate: '2025-03-10',
          partyType: 'CUSTOMER',
          partyId: alphaId,
          cashAccountId: cashId,
          amount: '1000.000',
          autoAllocate: true,
        });
      expect(res.status).toBe(201);

      const main = await api().get(`/api/v1/sales-invoices/${mainInvoice}`).set(auth(owner));
      expect(main.body.outstanding).toBe('0.000');
      const b2 = await api().get(`/api/v1/sales-invoices/${b2Invoice}`).set(auth(owner));
      // Untouched: still owes its whole total (amounts compared as decimals, not strings).
      expect(new Decimal(b2.body.outstanding).eq(new Decimal(b2.body.grandTotal))).toBe(true);
      // B2's invoice is outside the accountant's branch: it answers 404 to them.
      expect((await api().get(`/api/v1/sales-invoices/${b2Invoice}`).set(auth(accountant))).status).toBe(404);
    });
  });
});

