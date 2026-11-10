/**
 * Branch on goods notes and voucher entries (phase 6 open items, ADR-003):
 *  - a goods note takes its warehouse's branch, else the request branch,
 *    never one from the body;
 *  - a member limited to other branches cannot create, change, delete or
 *    post it; its journal entry carries the branch;
 *  - receipt / payment journal entries (and their reversals) carry the
 *    voucher's branch;
 *  - tenant isolation of goods notes.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3191;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `gnb-${RUN}-${Math.random().toString(36).slice(2)}` });

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

describe('Branch on goods notes and voucher entries', () => {
  let owner = '';
  let storekeeper = '';
  let otherTenant = '';
  let mainId = '';
  let b2Id = '';
  let plainWarehouse = ''; // no branch
  let b2Warehouse = ''; // branch B2
  let itemId = '';
  let customerId = '';
  let cashAccountId = '';
  let b2Note = '';

  const grn = (warehouseId: string) => ({
    noteDate: '2025-03-10',
    warehouseId,
    noteType: 'GRN',
    lines: [{ itemId, qty: '5', unitCost: '2.000' }],
  });

  async function noteBranch(id: string) {
    const [row] = (await db.query('SELECT branch_id FROM goods_notes WHERE id = ?', [id])) as { branch_id: bigint | null }[];
    return row.branch_id === null ? null : String(row.branch_id);
  }

  async function entryBranch(entryId: string | bigint) {
    const [row] = (await db.query('SELECT branch_id FROM journal_entries WHERE id = ?', [entryId])) as {
      branch_id: bigint | null;
    }[];
    return row.branch_id === null ? null : String(row.branch_id);
  }

  it('setup: MAIN + B2, a warehouse on each side, a storekeeper limited to MAIN', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `GNB ${RUN}`, ownerName: 'Owner', email: `gnb-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `GNB other ${RUN}`, ownerName: 'Other', email: `gnb-other-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    otherTenant = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`GNB ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch and one warehouse: add the second of each directly.
    const now = new Date();
    const b2 = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(b2.insertId);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    plainWarehouse = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W', nameAr: 'W' })).body.id;
    const w2 = (await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, branch_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, b2Id, 'W2', 'مستودع 2', now, now],
    )) as { insertId: bigint };
    b2Warehouse = String(w2.insertId);

    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    itemId = (await api().post('/api/v1/items').set(auth(owner)).send({ code: 'I', nameAr: 'I', baseUnitId: pcs })).body.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' })
    ).body.id;
    const accounts = await api().get('/api/v1/accounts').set(auth(owner));
    const walk = (ns: { id: string; controlType?: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        if (n.controlType === 'CASH' && !cashAccountId) cashAccountId = n.id;
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);

    const invite = await api()
      .post('/api/v1/users/invite')
      .set(auth(owner))
      .send({
        email: `gnb-store-${RUN}@test.dev`,
        roleCode: 'STOREKEEPER',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId],
      });
    expect(invite.status).toBe(201);
    const login = await api().post('/api/v1/auth/login').send({ email: `gnb-store-${RUN}@test.dev`, password: PASS });
    expect(login.status).toBe(200);
    storekeeper = login.body.accessToken;
  });

  it("a note takes its warehouse's branch, whatever the request branch is", async () => {
    const res = await api().post('/api/v1/goods-notes').set(auth(owner)).set('X-Branch-Id', mainId).send(grn(b2Warehouse));
    expect(res.status).toBe(201);
    b2Note = res.body.id;
    expect(await noteBranch(b2Note)).toBe(b2Id);
    expect(res.body.branch.id).toBe(b2Id);
  });

  it('a warehouse without a branch: the request branch, else the default', async () => {
    const withHeader = await api().post('/api/v1/goods-notes').set(auth(owner)).set('X-Branch-Id', b2Id).send(grn(plainWarehouse));
    expect(withHeader.status).toBe(201);
    expect(await noteBranch(withHeader.body.id)).toBe(b2Id);
    const noHeader = await api().post('/api/v1/goods-notes').set(auth(owner)).send(grn(plainWarehouse));
    expect(noHeader.status).toBe(201);
    expect(await noteBranch(noHeader.body.id)).toBe(mainId);
  });

  it('a branchId in the body is refused', async () => {
    const res = await api().post('/api/v1/goods-notes').set(auth(owner)).send({ ...grn(plainWarehouse), branchId: b2Id });
    expect(res.status).toBe(400);
  });

  it('a member limited to MAIN cannot touch a B2 note, but works on MAIN', async () => {
    const create = await api().post('/api/v1/goods-notes').set(auth(storekeeper)).send(grn(b2Warehouse));
    expect(create.status).toBe(403);
    expect(create.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    for (const res of [
      await api().put(`/api/v1/goods-notes/${b2Note}`).set(auth(storekeeper)).send(grn(plainWarehouse)),
      await api().delete(`/api/v1/goods-notes/${b2Note}`).set(auth(storekeeper)),
      await api().post(`/api/v1/goods-notes/${b2Note}/post`).set(auth(storekeeper)).set(idem()),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('BRANCH_NOT_ALLOWED');
    }

    const own = await api().post('/api/v1/goods-notes').set(auth(storekeeper)).send(grn(plainWarehouse));
    expect(own.status).toBe(201);
    expect(await noteBranch(own.body.id)).toBe(mainId);
    // Moving it to the B2 warehouse would move it to B2: refused.
    const move = await api().put(`/api/v1/goods-notes/${own.body.id}`).set(auth(storekeeper)).send(grn(b2Warehouse));
    expect(move.status).toBe(403);
    const posted = await api().post(`/api/v1/goods-notes/${own.body.id}/post`).set(auth(storekeeper)).set(idem());
    expect(posted.status).toBe(201);
    expect(await entryBranch(posted.body.journalEntry.id)).toBe(mainId);
  });

  it("moving a note to another warehouse takes that warehouse's branch; posting carries it", async () => {
    const note = await api().post('/api/v1/goods-notes').set(auth(owner)).send(grn(plainWarehouse));
    expect(await noteBranch(note.body.id)).toBe(mainId);
    const moved = await api().put(`/api/v1/goods-notes/${note.body.id}`).set(auth(owner)).send(grn(b2Warehouse));
    expect(moved.status).toBe(200);
    expect(await noteBranch(note.body.id)).toBe(b2Id);

    const posted = await api().post(`/api/v1/goods-notes/${b2Note}/post`).set(auth(owner)).set(idem());
    expect(posted.status).toBe(201);
    expect(await entryBranch(posted.body.journalEntry.id)).toBe(b2Id);
  });

  it("receipt entries and their reversals carry the voucher's branch", async () => {
    const r = await api()
      .post('/api/v1/receipts')
      .set(auth(owner))
      .set('X-Branch-Id', b2Id)
      .set(idem())
      .send({ receiptDate: '2025-03-12', partyType: 'CUSTOMER', partyId: customerId, cashAccountId, amount: '10.000' });
    expect(r.status).toBe(201);
    expect(await entryBranch(r.body.journalEntry.id)).toBe(b2Id);
    const rev = await api()
      .post(`/api/v1/receipts/${r.body.id}/reverse`)
      .set(auth(owner))
      .set('X-Branch-Id', b2Id)
      .set(idem())
      .send({ reversalDate: '2025-03-13' });
    expect(rev.status).toBe(201);
    const [v] = (await db.query('SELECT reversal_entry_id FROM receipts WHERE id = ?', [r.body.id])) as {
      reversal_entry_id: bigint;
    }[];
    expect(await entryBranch(v.reversal_entry_id)).toBe(b2Id);

    const p = await api()
      .post('/api/v1/payments')
      .set(auth(owner))
      .set('X-Branch-Id', b2Id)
      .set(idem())
      .send({ paymentDate: '2025-03-12', partyType: 'CUSTOMER', partyId: customerId, cashAccountId, amount: '4.000' });
    expect(p.status).toBe(201);
    expect(await entryBranch(p.body.journalEntry.id)).toBe(b2Id);
  });

  it("another tenant cannot see or touch this tenant's notes", async () => {
    expect((await api().get(`/api/v1/goods-notes/${b2Note}`).set(auth(otherTenant))).status).toBe(404);
    expect((await api().put(`/api/v1/goods-notes/${b2Note}`).set(auth(otherTenant)).send(grn(plainWarehouse))).status).toBe(404);
    expect((await api().delete(`/api/v1/goods-notes/${b2Note}`).set(auth(otherTenant))).status).toBe(404);
    expect((await api().post(`/api/v1/goods-notes/${b2Note}/post`).set(auth(otherTenant)).set(idem())).status).toBe(404);
    const list = await api().get('/api/v1/goods-notes').set(auth(otherTenant));
    expect(list.body).toEqual([]);
  });

  it('the trial balance stays balanced', async () => {
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(owner));
    expect(tb.body.balanced).toBe(true);
  });
});
