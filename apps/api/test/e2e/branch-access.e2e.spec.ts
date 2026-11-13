/**
 * Branch access (BUILD_PLAN §5.2 BranchGuard, Phase 5 acceptance
 * "an invoice cannot be posted on a branch the user is not allowed",
 * ADR-003). Tenant with branches MAIN and B2:
 *  - the owner has no assigned branches → may use both;
 *  - a cashier assigned to MAIN only cannot pick B2 (X-Branch-Id) nor post
 *    an invoice that belongs to B2;
 *  - new invoices take their branch from the request context, not the body;
 *  - a branch id from another tenant is rejected.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3193;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `br-${RUN}-${Math.random().toString(36).slice(2)}` });

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

describe('Branch access (BranchGuard, ADR-003)', () => {
  let owner = '';
  let cashier = '';
  let otherTenant = '';
  let mainId = '';
  let b2Id = '';
  let warehouseId = '';
  let itemId = '';
  let customerId = '';

  const invoiceBody = () => ({
    invoiceDate: '2025-02-10',
    customerId,
    warehouseId,
    paymentType: 'CREDIT',
    lines: [{ itemId, qty: '1', unitPrice: '10.000' }],
  });

  async function branchOf(invoiceId: string) {
    const [row] = (await db.query('SELECT branch_id FROM sales_invoices WHERE id = ?', [invoiceId])) as {
      branch_id: bigint | null;
    }[];
    return row.branch_id === null ? null : String(row.branch_id);
  }

  it('setup: owner with MAIN + B2, cashier limited to MAIN', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Branch ${RUN}`, ownerName: 'Owner', email: `branch-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;

    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Branch other ${RUN}`, ownerName: 'Other Owner', email: `branch-other-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    otherTenant = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Branch ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [
      t.tenantId,
    ])) as { id: bigint }[];
    mainId = String(main.id);
    // TRIAL allows one branch; add B2 directly (plan limits: phase 1 tests).
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    warehouseId = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W', nameAr: 'W' })).body.id;
    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs })).body.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })
    ).body.id;
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(owner))
      .send({
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId,
        lines: [{ itemId, qty: '100', unitCost: '4.000' }],
      });
    await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(owner)).set(idem());

    const invite = await api()
      .post('/api/v1/users/invite')
      .set(auth(owner))
      .send({
        email: `branch-cashier-${RUN}@test.dev`,
        roleCode: 'CASHIER',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId],
      });
    expect(invite.status).toBe(201);
    const login = await api()
      .post('/api/v1/auth/login')
      .send({ email: `branch-cashier-${RUN}@test.dev`, password: PASS });
    expect(login.status).toBe(200);
    cashier = login.body.accessToken;
  });

  it('/me lists the branches each user may switch to', async () => {
    const mine = await api().get('/api/v1/me').set(auth(owner));
    expect((mine.body.currentMembership.branches as { id: string }[]).map((b) => b.id).sort()).toEqual(
      [mainId, b2Id].sort(),
    );
    const theirs = await api().get('/api/v1/me').set(auth(cashier));
    expect((theirs.body.currentMembership.branches as { id: string }[]).map((b) => b.id)).toEqual([mainId]);
  });

  it('owner (no branches assigned) may post on any branch; branch comes from X-Branch-Id', async () => {
    const inv = await api().post('/api/v1/sales-invoices').set(auth(owner)).set('X-Branch-Id', b2Id).send(invoiceBody());
    expect(inv.status).toBe(201);
    expect(await branchOf(inv.body.id)).toBe(b2Id);
    const posted = await api()
      .post(`/api/v1/sales-invoices/${inv.body.id}/post`)
      .set(auth(owner))
      .set('X-Branch-Id', b2Id)
      .set(idem());
    expect(posted.status).toBe(201);
    const [entry] = (await db.query('SELECT branch_id FROM journal_entries WHERE id = ?', [
      posted.body.journalEntryId,
    ])) as { branch_id: bigint }[];
    expect(String(entry.branch_id)).toBe(b2Id);
  });

  it('without the header a new invoice gets the default branch; a body branchId is refused', async () => {
    const inv = await api().post('/api/v1/sales-invoices').set(auth(owner)).send(invoiceBody());
    expect(inv.status).toBe(201);
    expect(await branchOf(inv.body.id)).toBe(mainId);

    const sneaky = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(cashier))
      .send({ ...invoiceBody(), branchId: b2Id });
    expect(sneaky.status).toBe(400); // not a DTO field (forbidNonWhitelisted)
  });

  it('cashier limited to MAIN cannot select B2', async () => {
    const res = await api().get('/api/v1/sales-invoices').set(auth(cashier)).set('X-Branch-Id', b2Id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_NOT_ALLOWED');
  });

  it('cashier cannot post an invoice that belongs to B2', async () => {
    const inv = await api().post('/api/v1/sales-invoices').set(auth(owner)).set('X-Branch-Id', b2Id).send(invoiceBody());
    expect(inv.status).toBe(201);
    const res = await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(cashier)).set(idem());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    const [row] = (await db.query('SELECT status FROM sales_invoices WHERE id = ?', [inv.body.id])) as {
      status: string;
    }[];
    expect(row.status).toBe('DRAFT');
  });

  it('cashier creates and posts on MAIN', async () => {
    const inv = await api().post('/api/v1/sales-invoices').set(auth(cashier)).send(invoiceBody());
    expect(inv.status).toBe(201);
    expect(await branchOf(inv.body.id)).toBe(mainId);
    const posted = await api().post(`/api/v1/sales-invoices/${inv.body.id}/post`).set(auth(cashier)).set(idem());
    expect(posted.status).toBe(201);
  });

  it("another tenant's branch id is rejected", async () => {
    const res = await api().get('/api/v1/sales-invoices').set(auth(otherTenant)).set('X-Branch-Id', mainId);
    if (res.status !== 403) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    expect(res.body.error.code).toBe('BRANCH_NOT_ALLOWED');
  });

  // ---------------------------------------------- review fixes (2026-11-10)

  /** Invite a member limited to MAIN with `roleCode`; returns their token and membership id. */
  async function mainOnly(roleCode: string) {
    const email = `branch-${roleCode.toLowerCase()}-${RUN}@test.dev`;
    const invite = await api()
      .post('/api/v1/users/invite')
      .set(auth(owner))
      .send({ email, roleCode, password: PASS, defaultBranchId: mainId, branchIds: [mainId] });
    expect(invite.status).toBe(201);
    const login = await api().post('/api/v1/auth/login').send({ email, password: PASS });
    expect(login.status).toBe(200);
    return { token: login.body.accessToken as string, membershipId: invite.body.membershipId as string };
  }

  // The TRIAL plan allows 3 users (owner, cashier and this one), so the stock
  // test re-roles the same MAIN-only member instead of inviting a fourth.
  let mainMember = { token: '', membershipId: '' };

  it('manual journals take the branch from context; a body branchId is refused', async () => {
    mainMember = await mainOnly('ACCOUNTANT');
    const accountant = mainMember.token;
    const accounts = await api().get('/api/v1/accounts').set(auth(owner));
    const flat: { id: string; code: string }[] = [];
    const walk = (ns: { id: string; code: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    const acct = (code: string) => flat.find((a) => a.code === code)!.id;
    const lines = [
      { accountId: acct('5204'), debit: '5.000' },
      { accountId: acct('1101'), credit: '5.000' },
    ];

    const sneaky = await api()
      .post('/api/v1/journal-entries')
      .set(auth(accountant))
      .send({ entryDate: '2025-02-20', description: 'x', branchId: b2Id, lines });
    expect(sneaky.status).toBe(400);

    // Owner drafts on B2; the MAIN-only accountant may not post or delete it.
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(owner))
      .set('X-Branch-Id', b2Id)
      .send({ entryDate: '2025-02-20', description: 'B2 entry', lines });
    expect(draft.status).toBe(201);
    const [row] = (await db.query('SELECT branch_id FROM journal_entries WHERE id = ?', [draft.body.id])) as {
      branch_id: bigint;
    }[];
    expect(String(row.branch_id)).toBe(b2Id);
    const post = await api().post(`/api/v1/journal-entries/${draft.body.id}/post`).set(auth(accountant)).set(idem());
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    expect((await api().delete(`/api/v1/journal-entries/${draft.body.id}`).set(auth(accountant))).status).toBe(403);
  });

  it("a MAIN-only cashier cannot sell from, or adjust, B2's warehouse", async () => {
    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Branch ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, branch_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, b2Id, 'WB2', 'مستودع فرع 2', now, now],
    )) as { insertId: bigint };
    const b2Warehouse = String(ins.insertId);

    const sale = await api()
      .post('/api/v1/sales-invoices')
      .set(auth(cashier))
      .send({ ...invoiceBody(), warehouseId: b2Warehouse });
    expect(sale.status).toBe(403);
    expect(sale.body.error.code).toBe('BRANCH_NOT_ALLOWED');

    // A draft adjustment on B2's warehouse can be saved, but not posted by the storekeeper.
    const adj = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(owner))
      .send({
        adjustmentDate: '2025-02-21',
        adjustmentType: 'IN',
        warehouseId: b2Warehouse,
        lines: [{ itemId, qty: '1', unitCost: '4.000' }],
      });
    expect(adj.status).toBe(201);
    const rerole = await api()
      .patch(`/api/v1/users/${mainMember.membershipId}`)
      .set(auth(owner))
      .send({ roleCode: 'STOREKEEPER' });
    expect(rerole.status).toBe(200);
    const storekeeper = mainMember.token; // permissions are read per request
    const post = await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(storekeeper)).set(idem());
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    // The owner may.
    expect((await api().post(`/api/v1/stock-adjustments/${adj.body.id}/post`).set(auth(owner)).set(idem())).status).toBe(201);
  });
});
