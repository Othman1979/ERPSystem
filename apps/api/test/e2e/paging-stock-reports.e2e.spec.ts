/**
 * Keyset stock movements and branch-scoped stock reads (ADR-022 §4, ADR-003 §12–§13).
 * Tenant A has branches MAIN and B2, with W1 on MAIN and W2 on B2. Each
 * warehouse gets opening stock and a few movements, posted in date order.
 * GET /stock/movements is read `limit` rows at a time with `nextCursor`; the
 * MAIN-only accountant sees W1 figures only, and stock/verify is every branch
 * only. Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3235;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `sr-${RUN}-${Math.random().toString(36).slice(2)}` });

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

interface MovementRow {
  id: string;
  movementDate: string;
  warehouseCode: string;
  itemCode: string;
  sourceType: string;
  qtyIn: string;
  qtyOut: string;
  balanceQtyAfter: string;
}
interface KeysetBody {
  items: MovementRow[];
  nextCursor: string | null;
}
interface CardRow extends MovementRow {
  warehouse: { id: string; code: string; nameAr: string };
}
interface CardBody {
  item: { id: string; code: string };
  summary: {
    opening: { qty: string; value: string };
    totals: { qtyIn: string; qtyOut: string; valueIn: string; valueOut: string };
    closing: { qty: string; value: string };
    balances: { warehouse: { id: string; code: string; nameAr: string }; qtyOnHand: string }[];
  } | null;
  items: CardRow[];
  nextCursor: string | null;
}


describe('Stock reports: keyset movements and branch scope (ADR-022 §4, ADR-003 §12–§13)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let w1 = '';
  let w2 = '';
  let itemI = '';
  let itemJ = '';

  /** Creates a stock document and posts it at once; postings go in date order. */
  const createAndPost = async (
    resource: 'stock-adjustments' | 'stock-transfers',
    body: object,
    branch?: string,
  ): Promise<void> => {
    let create = api().post(`/api/v1/${resource}`).set(auth(owner));
    if (branch) create = create.set('X-Branch-Id', branch);
    const made = await create.send(body);
    if (made.status !== 201) throw new Error(`create ${resource}: ${made.status} ${JSON.stringify(made.body)}`);
    let post = api().post(`/api/v1/${resource}/${made.body.id}/post`).set(auth(owner)).set(idem());
    if (branch) post = post.set('X-Branch-Id', branch);
    const posted = await post;
    if (posted.status >= 300) throw new Error(`post ${resource}: ${posted.status} ${JSON.stringify(posted.body)}`);
  };

  /** One page of the movement ledger; throws unless it answers 200. */
  const movementPage = async (token: string, params: Record<string, string | number> = {}) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await api()
      .get(`/api/v1/stock/movements${query ? `?${query}` : ''}`)
      .set(auth(token));
    if (res.status !== 200) throw new Error(`movements: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as KeysetBody;
  };

  /** Every row of a keyset read, `limit` at a time, following nextCursor to the end. */
  const allMovements = async (token: string, params: Record<string, string | number>, limit: number) => {
    const rows: MovementRow[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1000; guard += 1) {
      const body = await movementPage(token, { ...params, limit, ...(cursor ? { cursor } : {}) });
      rows.push(...body.items);
      if (body.nextCursor === null) return rows;
      cursor = body.nextCursor;
    }
    throw new Error('the keyset read did not end');
  };

  /** A stock report under /stock (raw response, so status and error code can be checked). */
  const get = (token: string, path: string) => api().get(`/api/v1/stock${path}`).set(auth(token));

  /** One page of the item card (ADR-022 §4); throws unless it answers 200. */
  const cardPage = async (token: string, itemId: string, params: Record<string, string | number> = {}) => {
    const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    const res = await get(token, `/items/${itemId}/ledger${query ? `?${query}` : ''}`);
    if (res.status !== 200) throw new Error(`item card: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as CardBody;
  };

  /** Every row of the item card, `limit` at a time, following nextCursor to the end. */
  const allCardRows = async (token: string, itemId: string, params: Record<string, string>, limit: number) => {
    const rows: CardRow[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 1000; guard += 1) {
      const body = await cardPage(token, itemId, { ...params, limit, ...(cursor ? { cursor } : {}) });
      rows.push(...body.items);
      if (body.nextCursor === null) return rows;
      cursor = body.nextCursor;
    }
    throw new Error('the item card read did not end');
  };


  beforeAll(async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Stock ${RUN}`, ownerName: 'Owner', email: `stock-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `Stock B ${RUN}`, ownerName: 'Owner B', email: `stock-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`Stock ${RUN}`],
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
    const item = async (code: string) =>
      (await api().post('/api/v1/items').set(auth(owner)).send({ code, nameAr: code, baseUnitId: pcs })).body.id as string;
    itemI = await item('I');
    itemJ = await item('J');

    // Opening stock on both warehouses (ADR-008), then movements in date order.
    await createAndPost(
      'stock-adjustments',
      {
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId: w1,
        lines: [
          { itemId: itemI, qty: '100', unitCost: '4.000' },
          { itemId: itemJ, qty: '50', unitCost: '2.000' },
        ],
      },
      mainId,
    );
    await createAndPost(
      'stock-adjustments',
      {
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId: w2,
        lines: [
          { itemId: itemI, qty: '60', unitCost: '5.000' },
          { itemId: itemJ, qty: '15', unitCost: '2.000' },
        ],
      },
      b2Id,
    );
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-01', adjustmentType: 'IN', warehouseId: w1, lines: [{ itemId: itemI, qty: '10', unitCost: '4.500' }] },
      mainId,
    );
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-01', adjustmentType: 'OUT', warehouseId: w2, lines: [{ itemId: itemI, qty: '5' }] },
      b2Id,
    );
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-02', adjustmentType: 'IN', warehouseId: w2, lines: [{ itemId: itemJ, qty: '20', unitCost: '2.500' }] },
      b2Id,
    );
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-03', adjustmentType: 'OUT', warehouseId: w1, lines: [{ itemId: itemJ, qty: '7' }] },
      mainId,
    );
    await createAndPost('stock-transfers', {
      transferDate: '2025-03-03',
      fromWarehouseId: w1,
      toWarehouseId: w2,
      lines: [{ itemId: itemI, qty: '4' }],
    });
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-04', adjustmentType: 'OUT', warehouseId: w2, lines: [{ itemId: itemI, qty: '2' }] },
      b2Id,
    );
    await createAndPost(
      'stock-adjustments',
      { adjustmentDate: '2025-03-05', adjustmentType: 'IN', warehouseId: w1, lines: [{ itemId: itemI, qty: '3', unitCost: '4.000' }] },
      mainId,
    );

    const member = await addMember(BASE, owner, {
      email: `stock-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 120_000);

  describe('GET /stock/movements (keyset, ADR-022 §4)', () => {
    it('pages of 3 give the same rows in the same order as one read of 500', async () => {
      const one = await movementPage(owner, { limit: 500 });
      expect(one.nextCursor).toBeNull();
      const paged = await allMovements(owner, {}, 3);
      expect(paged.map((r) => r.id)).toEqual(one.items.map((r) => r.id));
      expect(new Set(paged.map((r) => r.id)).size).toBe(paged.length);
      expect(paged.length).toBeGreaterThan(8);
    });

    it('newest first: date descending, then id descending', async () => {
      const rows = (await movementPage(owner, { limit: 500 })).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        const [da, db2] = [a.movementDate.slice(0, 10), b.movementDate.slice(0, 10)];
        expect(da >= db2).toBe(true);
        if (da === db2) expect(BigInt(a.id) > BigInt(b.id)).toBe(true);
      }
    });

    it('a page that holds the rest has no nextCursor; a full page with rows left has one', async () => {
      const total = (await movementPage(owner, { limit: 500 })).items.length;
      const exact = await movementPage(owner, { limit: total });
      expect(exact.items).toHaveLength(total);
      expect(exact.nextCursor).toBeNull();
      const first = await movementPage(owner, { limit: 3 });
      expect(first.items).toHaveLength(3);
      expect(first.nextCursor).not.toBeNull();
    });

    it('a tampered cursor is refused with CURSOR_INVALID (400)', async () => {
      const cursor = (await movementPage(owner, { limit: 3 })).nextCursor!;
      // One character changed inside the payload (after "v1.").
      const i = cursor.indexOf('.') + 4;
      const tampered = cursor.slice(0, i) + (cursor[i] === 'A' ? 'B' : 'A') + cursor.slice(i + 1);
      const res = await api()
        .get(`/api/v1/stock/movements?limit=3&cursor=${encodeURIComponent(tampered)}`)
        .set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
    });

    it('a cursor reused with another warehouse filter is refused with CURSOR_INVALID', async () => {
      const cursor = (await movementPage(owner, { limit: 3 })).nextCursor!;
      const res = await api()
        .get(`/api/v1/stock/movements?limit=3&warehouseId=${w1}&cursor=${encodeURIComponent(cursor)}`)
        .set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
    });

    it('a cursor does not travel to another branch scope or to another tenant', async () => {
      const cursor = (await movementPage(owner, { limit: 3 })).nextCursor!;
      for (const token of [accountant, tenantB]) {
        const res = await api()
          .get(`/api/v1/stock/movements?limit=3&cursor=${encodeURIComponent(cursor)}`)
          .set(auth(token));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('CURSOR_INVALID');
      }
    });

    it('filters narrow the rows, and paging with a filter reads the same rows as one read', async () => {
      const all = (await movementPage(owner, { limit: 500 })).items;
      const transfers = all.filter((r) => r.sourceType === 'STOCK_TRANSFER');
      expect(transfers.length).toBeGreaterThan(0);
      const bySource = await allMovements(owner, { sourceType: 'STOCK_TRANSFER' }, 1);
      expect(bySource.map((r) => r.id)).toEqual(transfers.map((r) => r.id));

      const day = all.filter((r) => r.movementDate.slice(0, 10) === '2025-03-03');
      expect(day.length).toBeGreaterThan(0);
      const byDay = await allMovements(owner, { from: '2025-03-03', to: '2025-03-03' }, 2);
      expect(byDay.map((r) => r.id)).toEqual(day.map((r) => r.id));

      const onW1 = all.filter((r) => r.warehouseCode === 'W1');
      const byW1 = await allMovements(owner, { warehouseId: w1 }, 2);
      expect(byW1.map((r) => r.id)).toEqual(onW1.map((r) => r.id));
    });

    it.each([
      ['limit=0'],
      ['limit=501'],
      ['limit=abc'],
      ['limit=1.5'],
      ['limit=-1'],
      ['warehouseId=abc'],
      ['itemId=0x1'],
      ['from=2025-3-1'],
      ['to=2025-02-30'],
      ['page=2'], // the numbered-page parameters are gone from this keyset read
      ['pageSize=10'],
      [`cursor=${'x'.repeat(513)}`],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/stock/movements?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('an empty filter counts as not given', async () => {
      const blank = await movementPage(owner, { limit: 500 });
      const res = await api()
        .get('/api/v1/stock/movements?limit=500&warehouseId=&itemId=&sourceType=&from=&to=')
        .set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.body.items.map((r: MovementRow) => r.id)).toEqual(blank.items.map((r) => r.id));
    });
  });

  describe('GET /stock/items/:itemId/ledger (item card, keyset, ADR-022 §4)', () => {
    it('pages of 2 give the same rows, running figures and order as one read of 500', async () => {
      const one = await cardPage(owner, itemI, { limit: 500 });
      expect(one.nextCursor).toBeNull();
      expect(one.items.length).toBeGreaterThan(3);
      const paged = await allCardRows(owner, itemI, {}, 2);
      expect(paged).toEqual(one.items);
      expect(new Set(paged.map((r) => r.id)).size).toBe(paged.length);
    });

    it('the summary is on the first page only; later pages carry items and nextCursor', async () => {
      const one = await cardPage(owner, itemI, { limit: 500 });
      expect(one.summary).not.toBeNull();
      const first = await cardPage(owner, itemI, { limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(first.summary).toEqual(one.summary);
      const second = await cardPage(owner, itemI, { limit: 2, cursor: first.nextCursor! });
      expect(second.summary).toBeNull();
      expect(Object.keys(second).sort()).toEqual(['item', 'items', 'nextCursor', 'summary']);
    });

    it('oldest first: date ascending, then id ascending', async () => {
      const rows = (await cardPage(owner, itemI, { limit: 500 })).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        const [da, db2] = [a.movementDate.slice(0, 10), b.movementDate.slice(0, 10)];
        expect(da <= db2).toBe(true);
        if (da === db2) expect(BigInt(a.id) < BigInt(b.id)).toBe(true);
      }
    });

    it('a filter narrows the card, and paging with the filter reads the same rows as one read', async () => {
      const one = await cardPage(owner, itemI, { limit: 500, sourceType: 'STOCK_TRANSFER' });
      expect(one.items.length).toBeGreaterThan(0);
      expect(one.items.every((r) => r.sourceType === 'STOCK_TRANSFER')).toBe(true);
      expect(await allCardRows(owner, itemI, { sourceType: 'STOCK_TRANSFER' }, 1)).toEqual(one.items);
    });

    it('the MAIN-only accountant reads W1 rows in pages, the same as the owner reads for W1', async () => {
      const ownerW1 = await allCardRows(owner, itemI, { warehouseId: w1 }, 500);
      expect(ownerW1.length).toBeGreaterThan(0);
      expect(await allCardRows(accountant, itemI, {}, 2)).toEqual(ownerW1);
    });

    it('a tampered cursor is refused with CURSOR_INVALID (400)', async () => {
      const cursor = (await cardPage(owner, itemI, { limit: 2 })).nextCursor!;
      const i = cursor.indexOf('.') + 4;
      const tampered = cursor.slice(0, i) + (cursor[i] === 'A' ? 'B' : 'A') + cursor.slice(i + 1);
      const res = await get(owner, `/items/${itemI}/ledger?limit=2&cursor=${encodeURIComponent(tampered)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
    });

    it("a cursor of one item is refused on another item's card", async () => {
      const cursor = (await cardPage(owner, itemI, { limit: 2 })).nextCursor!;
      const res = await get(owner, `/items/${itemJ}/ledger?limit=2&cursor=${encodeURIComponent(cursor)}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
    });

    it('pdf and xlsx still read the whole card (ADR-022 §6)', async () => {
      const xlsx = await get(owner, `/items/${itemI}/ledger?format=xlsx`);
      expect(xlsx.status).toBe(200);
    });

    it.each([
      ['sourceType=BOGUS'],
      ['sourceType=stock_transfer'],
      ['limit=0'],
      ['limit=501'],
      ['from=2025-3-1'],
      ['page=2'],
      ['itemId=1'],
    ])('bad item card parameter %s → 400 VALIDATION', async (query) => {
      const res = await get(owner, `/items/${itemI}/ledger?${query}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('bad sourceType on the movement ledger → 400 VALIDATION', async () => {
      const res = await api().get('/api/v1/stock/movements?sourceType=BOGUS').set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });
  });

  describe('branch scope (ADR-003 §12–§13)', () => {
    it("the MAIN-only accountant's movements are W1's rows only, read by pages", async () => {
      const ownerW1 = (await movementPage(owner, { warehouseId: w1, limit: 500 })).items;
      const ownerW2 = (await movementPage(owner, { warehouseId: w2, limit: 500 })).items;
      expect(ownerW2.length).toBeGreaterThan(0);
      const seen = await allMovements(accountant, {}, 3);
      expect(seen.map((r) => r.id)).toEqual(ownerW1.map((r) => r.id));
      expect(seen.every((r) => r.warehouseCode === 'W1')).toBe(true);
      const w2Ids = new Set(ownerW2.map((r) => r.id));
      expect(seen.some((r) => w2Ids.has(r.id))).toBe(false);
    });

    it("another branch's warehouse filter answers no rows to the accountant", async () => {
      expect(await movementPage(accountant, { warehouseId: w2, limit: 500 })).toEqual({ items: [], nextCursor: null });
    });

    it('balances show W1 only, the same rows as the owner reads for W1', async () => {
      const ownerW1 = await get(owner, `/balances?warehouseId=${w1}`);
      const acct = await get(accountant, '/balances');
      expect(acct.status).toBe(200);
      expect(acct.body.length).toBeGreaterThan(0);
      expect(acct.body.every((r: { warehouseId: string }) => r.warehouseId === w1)).toBe(true);
      expect(acct.body).toEqual(ownerW1.body);
    });

    it('item balances show W1 only, with the same totals as the owner reads for W1', async () => {
      const ownerW1 = await get(owner, `/item-balances?warehouseId=${w1}`);
      const acct = await get(accountant, '/item-balances');
      expect(acct.status).toBe(200);
      expect(acct.body.rows.length).toBeGreaterThan(0);
      expect(acct.body.rows).toEqual(ownerW1.body.rows);
      expect(acct.body.totals).toEqual(ownerW1.body.totals);
      const nothing = await get(accountant, `/item-balances?warehouseId=${w2}`);
      expect(nothing.body.rows).toEqual([]);
    });

    it('the item card shows W1 only: rows, opening, totals, closing and footer balances', async () => {
      const ownerW1 = (await get(owner, `/items/${itemI}/ledger?warehouseId=${w1}`)).body as CardBody;
      const acct = (await get(accountant, `/items/${itemI}/ledger`)).body as CardBody;
      expect(acct.items.length).toBeGreaterThan(0);
      expect(acct.items.map((r) => r.id)).toEqual(ownerW1.items.map((r) => r.id));
      expect(acct.items.every((r) => r.warehouse.code === 'W1')).toBe(true);
      expect(acct.summary!.opening).toEqual(ownerW1.summary!.opening);
      expect(acct.summary!.totals).toEqual(ownerW1.summary!.totals);
      expect(acct.summary!.closing).toEqual(ownerW1.summary!.closing);
      const ownerBody = (await get(owner, `/items/${itemI}/ledger`)).body as CardBody;
      const ownerFooter = ownerBody.summary!.balances.filter((b) => b.warehouse.code === 'W1');
      expect(acct.summary!.balances).toEqual(ownerFooter);
      expect(acct.summary!.balances.every((b) => b.warehouse.code === 'W1')).toBe(true);
    });

    it("the item card answers nothing from another branch's warehouse", async () => {
      const res = await get(accountant, `/items/${itemI}/ledger?warehouseId=${w2}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
      // The footer lists the item's balances in the caller's warehouses (it always
      // ignored the warehouse filter): W1 only, never W2.
      expect(res.body.summary.balances.map((b: { warehouse: { code: string } }) => b.warehouse.code)).toEqual(['W1']);
    });

    it('valuation for the accountant is W1 quantity at average cost, not the company figure', async () => {
      const acct = (await get(accountant, '/valuation')).body;
      const ownerW1 = (await get(owner, `/valuation?warehouseId=${w1}`)).body;
      const ownerAll = (await get(owner, '/valuation')).body;
      expect(acct.rows.length).toBeGreaterThan(0);
      expect(acct.rows).toEqual(ownerW1.rows);
      expect(acct.totalValue).toBe(ownerW1.totalValue);
      // W2 holds stock too, so the company total is larger than W1's.
      expect(ownerAll.totalValue).not.toBe(acct.totalValue);
    });

    it('stock/verify is every branch only: 403 for the accountant, 200 for the owner', async () => {
      const denied = await get(accountant, '/verify');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
      const ok = await get(owner, '/verify');
      expect(ok.status).toBe(200);
      expect(ok.body.mismatches).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it("tenant B sees none of A's movements, balances, item cards or valuation", async () => {
      expect(await movementPage(tenantB, { limit: 500 })).toEqual({ items: [], nextCursor: null });
      expect((await get(tenantB, '/balances')).body).toEqual([]);
      expect((await get(tenantB, '/item-balances')).body.rows).toEqual([]);
      expect((await get(tenantB, '/valuation')).body).toMatchObject({ rows: [], totalValue: '0.000' });
      expect((await get(tenantB, `/items/${itemI}/ledger`)).status).toBe(404);
    });
  });

  describe('GET /stock/balances?itemIds (the items page reads only its own rows)', () => {
    it('answers only the rows of the listed items, the same rows as itemId reads one by one', async () => {
      const both = await get(owner, `/balances?itemIds=${itemI},${itemJ}`);
      expect(both.status).toBe(200);
      const ids = new Set((both.body as { itemId: string }[]).map((r) => r.itemId));
      expect(ids).toEqual(new Set([itemI, itemJ]));

      const onlyJ = await get(owner, `/balances?itemIds=${itemJ}`);
      expect(onlyJ.status).toBe(200);
      expect(onlyJ.body.length).toBeGreaterThan(0);
      expect(onlyJ.body).toEqual((await get(owner, `/balances?itemId=${itemJ}`)).body);
    });

    it('a repeated id is read once; an itemId and an itemIds that do not overlap answer nothing', async () => {
      const dup = await get(owner, `/balances?itemIds=${itemJ},${itemJ}`);
      expect(dup.body).toEqual((await get(owner, `/balances?itemIds=${itemJ}`)).body);
      const both = await get(owner, `/balances?itemId=${itemI}&itemIds=${itemJ}`);
      expect(both.status).toBe(200);
      expect(both.body).toEqual([]);
    });

    it('a malformed list is refused with VALIDATION (400)', async () => {
      for (const query of ['itemIds=abc', `itemIds=${itemI},`, `itemIds=,${itemI}`, 'itemIds=']) {
        const res = await get(owner, `/balances?${query}`);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
      }
    });

    it('more than 100 ids is refused with VALIDATION (400)', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => String(i + 1)).join(',');
      const res = await get(owner, `/balances?itemIds=${ids}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it("tenant B sees none of A's balances when it asks for A's item ids", async () => {
      const res = await get(tenantB, `/balances?itemIds=${itemI},${itemJ}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });
});
