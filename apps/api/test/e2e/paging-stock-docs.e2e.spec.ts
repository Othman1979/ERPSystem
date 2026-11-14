/**
 * Paging and branch-scoped reads of stock documents, goods notes and items
 * (ADR-022, ADR-003). Same shape as paging-branches.e2e.spec.ts:
 *  - numbered pages with the total, filters, q, sort stability and bad
 *    parameters (400 VALIDATION);
 *  - a MAIN-only accountant sees only MAIN's documents (a transfer shows when
 *    its source or its destination is MAIN) and gets 404 for another branch's
 *    document; items are master data, so the accountant sees all of them;
 *  - tenant B sees none of A's documents.
 * Tenant A has branches MAIN (warehouse W1) and B2 (warehouses W2 and W3), so
 * a transfer between two B2 warehouses is hidden from the MAIN-only accountant.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';

const API_PORT = 3234;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

const ADJ = '/api/v1/stock-adjustments';
const TR = '/api/v1/stock-transfers';
const CNT = '/api/v1/stock-counts';
const GN = '/api/v1/goods-notes';
const ITEMS = '/api/v1/items';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `sd-${RUN}-${Math.random().toString(36).slice(2)}` });

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

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface AdjRow {
  id: string;
  docNo: string | null;
  status: string;
  adjustmentDate: string;
  adjustmentType: string;
  warehouse: { id: string };
}
interface TransferRow {
  id: string;
  docNo: string | null;
  status: string;
  transferDate: string;
  fromWarehouse: { id: string };
  toWarehouse: { id: string };
}
interface CountRow {
  id: string;
  docNo: string | null;
  status: string;
  countDate: string;
  warehouse: { id: string };
}
interface NoteRow {
  id: string;
  docNo: string | null;
  status: string;
  noteDate: string;
  noteType: string;
  branch: { id: string } | null;
}
interface ItemRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  itemKind: string;
}

// Fixture counts (see setup). Stock documents: 7 adjustments, 5 transfers, 4 counts, 6 goods notes.
const ADJUSTMENTS = 7;
const TRANSFERS = 5;
const COUNTS = 4;
const NOTES = 6;
const ITEMS_TOTAL = 13; // 12 stock items (SKU-01..SKU-12) and one service (SRV-01)

describe('Paging and branch scope of stock documents, goods notes and items (ADR-022, ADR-003)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let w1 = ''; // MAIN
  let w2 = ''; // B2
  let w3 = ''; // B2
  let stock = ''; // item SKU-01 (STOCK), used by every document
  const item = {} as Record<string, string>;
  const adj = {} as Record<string, string>;
  const tr = {} as Record<string, string>;
  const cnt = {} as Record<string, string>;
  const gn = {} as Record<string, string>;

  const listAt = async <T,>(token: string, route: string, query = ''): Promise<Page<T>> => {
    const res = await api().get(`${route}${query}`).set(auth(token));
    if (res.status !== 200) throw new Error(`GET ${route}${query}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as Page<T>;
  };
  /** Every page of a query, `size` rows at a time. */
  const everyPage = async <T,>(token: string, route: string, query: string, size: number) => {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const body = await listAt<T>(token, route, `?${query ? `${query}&` : ''}pageSize=${size}&page=${page}`);
      rows.push(...body.items);
      if (body.items.length < size) return { rows, total: body.total };
    }
  };
  const create = async (route: string, body: object): Promise<string> => {
    const res = await api().post(route).set(auth(owner)).send(body);
    if (res.status !== 201) throw new Error(`POST ${route}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  const postDoc = async (route: string) => {
    const res = await api().post(route).set(auth(owner)).set(idem());
    if (res.status !== 201) throw new Error(`POST ${route}: ${res.status} ${JSON.stringify(res.body)}`);
  };
  const getAs = (token: string, route: string) => api().get(route).set(auth(token));

  beforeAll(async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `SD ${RUN}`, ownerName: 'Owner', email: `sd-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `SD B ${RUN}`, ownerName: 'Owner B', email: `sd-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`SD ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch and one warehouse: add B2 directly (as the other branch specs do).
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);
    // BASIC allows two warehouses through the API; the third (on B2) is inserted by SQL.
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
    const w3Ins = (await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, branch_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, b2Id, 'W3', 'مستودع 3', now, now],
    )) as { insertId: bigint };
    w3 = String(w3Ins.insertId);

    // Items: twelve stock items (two share a name, one has an English name) and a service.
    const units = await api().get('/api/v1/units').set(auth(owner));
    const pcs = (units.body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    for (let i = 1; i <= 12; i += 1) {
      const n = String(i).padStart(2, '0');
      const id = await create(ITEMS, {
        code: `SKU-${n}`,
        nameAr: i === 7 || i === 8 ? 'صنف مكرر' : `صنف ${n}`,
        nameEn: i === 3 ? 'Gamma widget' : `Item ${n}`,
        baseUnitId: pcs,
        itemKind: 'STOCK',
      });
      item[`SKU-${n}`] = id;
    }
    stock = item['SKU-01'];
    item['SRV-01'] = await create(ITEMS, {
      code: 'SRV-01',
      nameAr: 'خدمة نقل',
      nameEn: 'Transport service',
      baseUnitId: pcs,
      itemKind: 'SERVICE',
    });
    const deactivated = await api().patch(`${ITEMS}/${item['SKU-12']}`).set(auth(owner)).send({ isActive: false });
    expect(deactivated.status).toBe(200);

    // Adjustments: two openings, two INs, one OUT posted; three drafts.
    const opening = (warehouseId: string, description: string) =>
      create(ADJ, {
        adjustmentDate: '2025-02-01',
        adjustmentType: 'OPENING',
        warehouseId,
        description,
        lines: [{ itemId: stock, qty: '100', unitCost: '4.000' }],
      });
    adj.opening1 = await opening(w1, 'opening main');
    adj.opening2 = await opening(w2, 'opening b2');
    adj.in3 = await create(ADJ, {
      adjustmentDate: '2025-03-05',
      adjustmentType: 'IN',
      warehouseId: w1,
      description: 'spare parts',
      lines: [{ itemId: stock, qty: '3', unitCost: '5.000' }],
    });
    adj.in4 = await create(ADJ, {
      adjustmentDate: '2025-03-05',
      adjustmentType: 'IN',
      warehouseId: w1,
      description: 'spare parts',
      lines: [{ itemId: stock, qty: '2', unitCost: '5.000' }],
    });
    adj.out5 = await create(ADJ, {
      adjustmentDate: '2025-03-05',
      adjustmentType: 'OUT',
      warehouseId: w2,
      description: 'damaged',
      lines: [{ itemId: stock, qty: '1' }],
    });
    adj.in6 = await create(ADJ, {
      adjustmentDate: '2025-03-07',
      adjustmentType: 'IN',
      warehouseId: w2,
      description: 'returned',
      lines: [{ itemId: stock, qty: '3', unitCost: '4.000' }],
    });
    adj.out7 = await create(ADJ, {
      adjustmentDate: '2025-03-07',
      adjustmentType: 'OUT',
      warehouseId: w1,
      description: 'shrinkage',
      lines: [{ itemId: stock, qty: '1' }],
    });

    // Transfers: W1→W2 (MAIN→B2), W2→W1, W2→W3 and W3→W2 (both B2), W1→W3.
    const transfer = (fromWarehouseId: string, toWarehouseId: string, transferDate: string, description: string) =>
      create(TR, {
        transferDate,
        fromWarehouseId,
        toWarehouseId,
        description,
        lines: [{ itemId: stock, qty: '5' }],
      });
    tr.t1 = await transfer(w1, w2, '2025-03-06', 'shop refill');
    tr.t2 = await transfer(w2, w1, '2025-03-08', 'return stock');
    tr.t3 = await transfer(w2, w3, '2025-03-08', 'b2 rebalance');
    tr.t4 = await transfer(w3, w2, '2025-03-09', 'b2 internal');
    tr.t5 = await transfer(w1, w3, '2025-03-09', 'main to b2');

    // Counts (explicit lines, so no stock is needed to capture them): MAIN twice, B2 twice.
    const count = (warehouseId: string, countDate: string, description: string) =>
      create(CNT, { countDate, warehouseId, description, lines: [{ itemId: stock, countedQty: '50' }] });
    cnt.c1 = await count(w1, '2025-03-08', 'count main');
    cnt.c2 = await count(w2, '2025-03-10', 'count b2');
    cnt.c3 = await count(w3, '2025-03-10', 'count b2 w3');
    cnt.c4 = await count(w1, '2025-03-12', 'count main 2');

    // Goods notes: GRNs post stock in; GINs stay drafts.
    const note = (
      noteType: 'GRN' | 'GIN',
      warehouseId: string,
      noteDate: string,
      description: string,
    ) =>
      create(GN, {
        noteDate,
        warehouseId,
        noteType,
        description,
        lines:
          noteType === 'GRN'
            ? [{ itemId: stock, qty: '5', unitCost: '2.000' }]
            : [{ itemId: stock, qty: '1' }],
      });
    gn.grn1 = await note('GRN', w1, '2025-03-01', 'grn main');
    gn.grn2 = await note('GRN', w2, '2025-03-02', 'grn b2');
    gn.gin3 = await note('GIN', w1, '2025-03-03', 'gin main');
    gn.grn4 = await note('GRN', w3, '2025-03-04', 'grn b2 w3');
    gn.gin5 = await note('GIN', w2, '2025-03-05', 'gin b2');
    gn.grn6 = await note('GRN', w1, '2025-03-05', 'grn main 2');

    // Post in date order: the stock ledger refuses a posting dated before an item's last movement.
    await postDoc(`${ADJ}/${adj.opening1}/post`); // 02-01 W1
    await postDoc(`${ADJ}/${adj.opening2}/post`); // 02-01 W2
    await postDoc(`${GN}/${gn.grn1}/post`); // 03-01 W1
    await postDoc(`${GN}/${gn.grn2}/post`); // 03-02 W2
    await postDoc(`${ADJ}/${adj.in3}/post`); // 03-05 W1
    await postDoc(`${GN}/${gn.grn6}/post`); // 03-05 W1
    await postDoc(`${TR}/${tr.t1}/post`); // 03-06 W1 -> W2
    await postDoc(`${ADJ}/${adj.out7}/post`); // 03-07 W1
    await postDoc(`${TR}/${tr.t3}/post`); // 03-08 W2 -> W3

    accountant = (
      await addMember(BASE, owner, {
        email: `sd-acct-${RUN}@test.dev`,
        roleCode: 'ACCOUNTANT',
        password: PASS,
        defaultBranchId: mainId,
        branchIds: [mainId],
      })
    ).token;
  }, 180_000);

  it('the MAIN-only accountant is limited to MAIN, the owner sees every branch', async () => {
    const me = async (token: string) => (await api().get('/api/v1/me').set(auth(token))).body.currentMembership;
    expect((await me(owner)).allBranches).toBe(true);
    expect((await me(accountant)).allBranches).toBe(false);
  });

  describe('GET /stock-adjustments', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listAt<AdjRow>(owner, ADJ, '?pageSize=3');
      expect(first).toMatchObject({ page: 1, pageSize: 3, total: ADJUSTMENTS });
      expect(first.items).toHaveLength(3);
      const last = await listAt<AdjRow>(owner, ADJ, '?pageSize=3&page=3');
      expect(last.items).toHaveLength(1);
      expect(last.total).toBe(ADJUSTMENTS);
      const past = await listAt<AdjRow>(owner, ADJ, '?pageSize=3&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: ADJUSTMENTS });
      expect(await listAt(owner, ADJ)).toMatchObject({ page: 1, pageSize: 20, total: ADJUSTMENTS });
    });

    it('filters and q narrow the total', async () => {
      expect((await listAt(owner, ADJ, '?status=POSTED')).total).toBe(4);
      expect((await listAt(owner, ADJ, '?status=DRAFT')).total).toBe(3);
      expect((await listAt(owner, ADJ, '?adjustmentType=IN')).total).toBe(3);
      expect((await listAt(owner, ADJ, '?adjustmentType=OUT')).total).toBe(2);
      expect((await listAt(owner, ADJ, '?adjustmentType=COUNT_ADJUSTMENT')).total).toBe(0);
      expect((await listAt(owner, ADJ, `?warehouseId=${w1}`)).total).toBe(4);
      const b2Drafts = await listAt<AdjRow>(owner, ADJ, `?warehouseId=${w2}&status=DRAFT`);
      expect(b2Drafts.items.map((r) => r.id).sort()).toEqual([adj.out5, adj.in6].sort());
      // The date is inclusive at both ends.
      expect((await listAt(owner, ADJ, '?from=2025-03-05&to=2025-03-05')).total).toBe(3);
      expect((await listAt(owner, ADJ, '?from=2025-03-06')).total).toBe(2);
      // q: the description, then a posted document's number.
      const spare = await listAt<AdjRow>(owner, ADJ, '?q=spare&pageSize=100');
      expect(spare.items.map((r) => r.id).sort()).toEqual([adj.in3, adj.in4].sort());
      const posted = (await getAs(owner, `${ADJ}/${adj.opening2}`)).body as AdjRow;
      expect(posted.docNo).toBeTruthy();
      const byNo = await listAt<AdjRow>(owner, ADJ, `?q=${encodeURIComponent(posted.docNo!)}`);
      expect(byNo.items.map((r) => r.id)).toEqual([adj.opening2]);
      expect((await listAt(owner, ADJ, '?q=%20%20')).total).toBe(ADJUSTMENTS); // blank search = no search
    });

    it('sort is stable: pages of 2 read the same rows in the same order as one page', async () => {
      for (const sort of ['date', '-date', 'docNo', '-docNo']) {
        const one = (await listAt<AdjRow>(owner, ADJ, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await everyPage<AdjRow>(owner, ADJ, `sort=${sort}`, 2);
        expect(paged.total).toBe(ADJUSTMENTS);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(ADJUSTMENTS);
      }
      // Newest first by default; equal dates by id, newest id first.
      const rows = (await listAt<AdjRow>(owner, ADJ, '?pageSize=100')).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1].adjustmentDate.slice(0, 10), rows[i].adjustmentDate.slice(0, 10)];
        expect(a >= b).toBe(true);
        if (a === b) expect(BigInt(rows[i - 1].id) > BigInt(rows[i].id)).toBe(true);
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
      ['sort=bogus'],
      ['sort=--date'],
      ['sort=customer'],
      [`q=${'x'.repeat(101)}`],
      ['status=VOID'],
      ['adjustmentType=SALE'],
      ['warehouseId=abc'],
      ['from=2025-3-1'],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${ADJ}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get(`${ADJ}?from=2025-03-05&to=2025-03-01`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists MAIN's adjustments only; another branch's answers 404", async () => {
      const all = await everyPage<AdjRow>(accountant, ADJ, 'sort=date', 2);
      expect(all.total).toBe(4);
      expect(all.rows.every((r) => r.warehouse.id === w1)).toBe(true);
      expect(all.rows.map((r) => r.id).sort()).toEqual([adj.opening1, adj.in3, adj.in4, adj.out7].sort());
      expect((await listAt(accountant, ADJ, '?status=DRAFT')).total).toBe(1);
      const mine = await getAs(accountant, `${ADJ}/${adj.opening1}`);
      expect(mine.status).toBe(200);
      expect(mine.body.warehouse.id).toBe(w1);
      const theirs = await getAs(accountant, `${ADJ}/${adj.opening2}`);
      expect(theirs.status).toBe(404);
      expect(theirs.body.error.code).toBe('NOT_FOUND');
      expect((await listAt(owner, ADJ, '?pageSize=100')).total).toBe(ADJUSTMENTS);
    });

    it("tenant B sees none of A's adjustments and gets 404 for one", async () => {
      expect(await listAt(tenantB, ADJ)).toMatchObject({ items: [], total: 0 });
      expect((await listAt(tenantB, ADJ, `?warehouseId=${w1}`)).total).toBe(0);
      expect((await getAs(tenantB, `${ADJ}/${adj.opening1}`)).status).toBe(404);
    });
  });

  describe('GET /stock-transfers', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listAt<TransferRow>(owner, TR, '?pageSize=2');
      expect(first).toMatchObject({ page: 1, pageSize: 2, total: TRANSFERS });
      expect(first.items).toHaveLength(2);
      const last = await listAt<TransferRow>(owner, TR, '?pageSize=2&page=3');
      expect(last.items).toHaveLength(1);
      expect(last.total).toBe(TRANSFERS);
      const past = await listAt<TransferRow>(owner, TR, '?pageSize=2&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: TRANSFERS });
    });

    it('filters and q narrow the total; warehouseId matches the source or the destination', async () => {
      expect((await listAt(owner, TR, '?status=POSTED')).total).toBe(2);
      expect((await listAt(owner, TR, '?status=DRAFT')).total).toBe(3);
      expect((await listAt(owner, TR, `?warehouseId=${w2}`)).total).toBe(4);
      expect((await listAt(owner, TR, `?warehouseId=${w3}`)).total).toBe(3);
      expect((await listAt(owner, TR, `?warehouseId=${w1}`)).total).toBe(3);
      const posted = await listAt<TransferRow>(owner, TR, `?warehouseId=${w3}&status=POSTED`);
      expect(posted.items.map((r) => r.id)).toEqual([tr.t3]);
      expect((await listAt(owner, TR, '?from=2025-03-08&to=2025-03-09')).total).toBe(4);
      const refill = await listAt<TransferRow>(owner, TR, '?q=refill');
      expect(refill.items.map((r) => r.id)).toEqual([tr.t1]);
      const docNo = (await getAs(owner, `${TR}/${tr.t1}`)).body.docNo as string;
      expect(docNo).toBeTruthy();
      expect((await listAt<TransferRow>(owner, TR, `?q=${encodeURIComponent(docNo)}`)).items.map((r) => r.id)).toEqual([
        tr.t1,
      ]);
    });

    it('sort is stable: pages of 2 read the same rows in the same order as one page', async () => {
      for (const sort of ['date', '-date', 'docNo', '-docNo']) {
        const one = (await listAt<TransferRow>(owner, TR, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await everyPage<TransferRow>(owner, TR, `sort=${sort}`, 2);
        expect(paged.total).toBe(TRANSFERS);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(TRANSFERS);
      }
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=-warehouse'],
      ['status=DONE'],
      ['warehouseId=0'],
      ['from=2025-03-1'],
      ['toWarehouseId=1'], // not a parameter: the filter is warehouseId
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${TR}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get(`${TR}?from=2025-03-09&to=2025-03-01`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant sees a transfer when its source or destination is MAIN; another branch's answers 404", async () => {
      const all = await everyPage<TransferRow>(accountant, TR, 'sort=date', 2);
      expect(all.total).toBe(3);
      expect(all.rows.map((r) => r.id).sort()).toEqual([tr.t1, tr.t2, tr.t5].sort());
      for (const id of [tr.t1, tr.t2, tr.t5]) expect((await getAs(accountant, `${TR}/${id}`)).status).toBe(200);
      // Both ends in B2: hidden from the list and from GET.
      for (const id of [tr.t3, tr.t4]) {
        const res = await getAs(accountant, `${TR}/${id}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      }
      expect((await listAt(accountant, TR, `?warehouseId=${w3}`)).total).toBe(1);
      expect((await listAt(owner, TR, '?pageSize=100')).total).toBe(TRANSFERS);
    });

    it("tenant B sees none of A's transfers and gets 404 for one", async () => {
      expect(await listAt(tenantB, TR)).toMatchObject({ items: [], total: 0 });
      expect((await getAs(tenantB, `${TR}/${tr.t1}`)).status).toBe(404);
    });
  });

  describe('GET /stock-counts', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listAt<CountRow>(owner, CNT, '?pageSize=3');
      expect(first).toMatchObject({ page: 1, pageSize: 3, total: COUNTS });
      expect(first.items).toHaveLength(3);
      const last = await listAt<CountRow>(owner, CNT, '?pageSize=3&page=2');
      expect(last.items).toHaveLength(1);
      expect(last.total).toBe(COUNTS);
      const past = await listAt<CountRow>(owner, CNT, '?pageSize=3&page=3');
      expect(past).toMatchObject({ items: [], page: 3, total: COUNTS });
    });

    it('filters and q narrow the total', async () => {
      expect((await listAt(owner, CNT, '?status=DRAFT')).total).toBe(COUNTS);
      expect((await listAt(owner, CNT, '?status=POSTED')).total).toBe(0);
      expect((await listAt(owner, CNT, `?warehouseId=${w1}`)).total).toBe(2);
      expect((await listAt(owner, CNT, `?warehouseId=${w2}`)).total).toBe(1);
      expect((await listAt(owner, CNT, '?from=2025-03-10&to=2025-03-10')).total).toBe(2);
      const w3Count = await listAt<CountRow>(owner, CNT, '?q=w3');
      expect(w3Count.items.map((r) => r.id)).toEqual([cnt.c3]);
    });

    it('sort is stable: pages of 2 read the same rows in the same order as one page', async () => {
      for (const sort of ['date', '-date', 'docNo', '-docNo']) {
        const one = (await listAt<CountRow>(owner, CNT, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await everyPage<CountRow>(owner, CNT, `sort=${sort}`, 2);
        expect(paged.total).toBe(COUNTS);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(COUNTS);
      }
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['status=VOID'],
      ['warehouseId=abc'],
      ['to=2025-13-01'],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${CNT}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it("a MAIN-only accountant lists MAIN's counts only; another branch's answers 404", async () => {
      const all = await everyPage<CountRow>(accountant, CNT, 'sort=date', 1);
      expect(all.total).toBe(2);
      expect(all.rows.map((r) => r.id).sort()).toEqual([cnt.c1, cnt.c4].sort());
      expect(all.rows.every((r) => r.warehouse.id === w1)).toBe(true);
      expect((await getAs(accountant, `${CNT}/${cnt.c1}`)).status).toBe(200);
      const theirs = await getAs(accountant, `${CNT}/${cnt.c2}`);
      expect(theirs.status).toBe(404);
      expect(theirs.body.error.code).toBe('NOT_FOUND');
    });

    it("tenant B sees none of A's counts and gets 404 for one", async () => {
      expect(await listAt(tenantB, CNT)).toMatchObject({ items: [], total: 0 });
      expect((await getAs(tenantB, `${CNT}/${cnt.c1}`)).status).toBe(404);
    });
  });

  describe('GET /goods-notes', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listAt<NoteRow>(owner, GN, '?pageSize=4');
      expect(first).toMatchObject({ page: 1, pageSize: 4, total: NOTES });
      expect(first.items).toHaveLength(4);
      const last = await listAt<NoteRow>(owner, GN, '?pageSize=4&page=2');
      expect(last.items).toHaveLength(2);
      expect(last.total).toBe(NOTES);
      const past = await listAt<NoteRow>(owner, GN, '?pageSize=4&page=3');
      expect(past).toMatchObject({ items: [], page: 3, total: NOTES });
    });

    it('filters and q narrow the total', async () => {
      expect((await listAt(owner, GN, '?status=POSTED')).total).toBe(3);
      expect((await listAt(owner, GN, '?status=DRAFT')).total).toBe(3);
      expect((await listAt(owner, GN, '?noteType=GRN')).total).toBe(4);
      expect((await listAt(owner, GN, '?noteType=GIN')).total).toBe(2);
      expect((await listAt(owner, GN, '?from=2025-03-03&to=2025-03-05')).total).toBe(4);
      const b2 = await listAt<NoteRow>(owner, GN, '?q=b2&pageSize=100');
      expect(b2.items.map((r) => r.id).sort()).toEqual([gn.grn2, gn.grn4, gn.gin5].sort());
      const docNo = (await getAs(owner, `${GN}/${gn.grn2}`)).body.docNo as string;
      expect(docNo).toBeTruthy();
      expect((await listAt<NoteRow>(owner, GN, `?q=${encodeURIComponent(docNo)}`)).items.map((r) => r.id)).toEqual([
        gn.grn2,
      ]);
    });

    it('sort is stable: pages of 2 read the same rows in the same order as one page', async () => {
      for (const sort of ['date', '-date', 'docNo', '-docNo']) {
        const one = (await listAt<NoteRow>(owner, GN, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await everyPage<NoteRow>(owner, GN, `sort=${sort}`, 2);
        expect(paged.total).toBe(NOTES);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(NOTES);
      }
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['noteType=GRR'],
      ['status=VOID'],
      ['from=03-01-2025'],
      ['warehouseId=1'], // not a parameter here: a note's branch comes from its warehouse
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${GN}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get(`${GN}?from=2025-03-05&to=2025-03-01`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it("a MAIN-only accountant lists MAIN's notes only; another branch's answers 404", async () => {
      const all = await everyPage<NoteRow>(accountant, GN, 'sort=date', 2);
      expect(all.total).toBe(3);
      expect(all.rows.map((r) => r.id).sort()).toEqual([gn.grn1, gn.gin3, gn.grn6].sort());
      expect(all.rows.every((r) => r.branch?.id === mainId)).toBe(true);
      expect((await listAt(accountant, GN, '?q=b2')).total).toBe(0);
      const mine = await getAs(accountant, `${GN}/${gn.grn1}`);
      expect(mine.status).toBe(200);
      expect(mine.body.branch.id).toBe(mainId);
      const theirs = await getAs(accountant, `${GN}/${gn.grn2}`);
      expect(theirs.status).toBe(404);
      expect(theirs.body.error.code).toBe('NOT_FOUND');
    });

    it("tenant B sees none of A's notes and gets 404 for one", async () => {
      expect(await listAt(tenantB, GN)).toMatchObject({ items: [], total: 0 });
      expect((await getAs(tenantB, `${GN}/${gn.grn1}`)).status).toBe(404);
    });
  });

  describe('GET /items (master data, not branch-scoped)', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await listAt<ItemRow>(owner, ITEMS, '?pageSize=5');
      expect(first).toMatchObject({ page: 1, pageSize: 5, total: ITEMS_TOTAL });
      expect(first.items).toHaveLength(5);
      const last = await listAt<ItemRow>(owner, ITEMS, '?pageSize=5&page=3');
      expect(last.items).toHaveLength(3);
      expect(last.total).toBe(ITEMS_TOTAL);
      const past = await listAt<ItemRow>(owner, ITEMS, '?pageSize=5&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: ITEMS_TOTAL });
      expect(await listAt(owner, ITEMS)).toMatchObject({ page: 1, pageSize: 20, total: ITEMS_TOTAL });
    });

    it('filters and q narrow the total; a blank filter counts as not given', async () => {
      expect((await listAt(owner, ITEMS, '?itemKind=STOCK')).total).toBe(12);
      expect((await listAt(owner, ITEMS, '?itemKind=SERVICE')).total).toBe(1);
      expect((await listAt(owner, ITEMS, '?isActive=false')).total).toBe(1);
      expect((await listAt(owner, ITEMS, '?isActive=true')).total).toBe(12);
      expect((await listAt(owner, ITEMS, '?itemKind=&isActive=')).total).toBe(ITEMS_TOTAL);
      // q by code and by English or Arabic name.
      const byCode = await listAt<ItemRow>(owner, ITEMS, '?q=SKU-05');
      expect(byCode.items.map((r) => r.id)).toEqual([item['SKU-05']]);
      const byName = await listAt<ItemRow>(owner, ITEMS, '?q=Gamma');
      expect(byName.items.map((r) => r.id)).toEqual([item['SKU-03']]);
      const duplicates = await listAt<ItemRow>(owner, ITEMS, `?q=${encodeURIComponent('صنف مكرر')}&pageSize=100`);
      expect(duplicates.items.map((r) => r.id).sort()).toEqual([item['SKU-07'], item['SKU-08']].sort());
      expect((await listAt(owner, ITEMS, '?q=%20%20')).total).toBe(ITEMS_TOTAL);
    });

    it('sort is stable and code ascending by default', async () => {
      const first = (await listAt<ItemRow>(owner, ITEMS, '?pageSize=100')).items;
      const codes = first.map((r) => r.code);
      expect(codes).toEqual([...codes].sort());
      expect(codes[0]).toBe('SKU-01');
      for (const sort of ['code', '-code', 'nameAr', '-nameAr']) {
        const one = (await listAt<ItemRow>(owner, ITEMS, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await everyPage<ItemRow>(owner, ITEMS, `sort=${sort}`, 4);
        expect(paged.total).toBe(ITEMS_TOTAL);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(ITEMS_TOTAL);
      }
    });

    it('returns the item fields the pickers use (prices, tax, kind, units)', async () => {
      const row = (await listAt<ItemRow & Record<string, unknown>>(owner, ITEMS, `?q=SKU-01`)).items[0];
      expect(row).toHaveProperty('baseUnit');
      expect(row).toHaveProperty('taxCategory');
      expect(row).toHaveProperty('_count');
      expect(row).toHaveProperty('salePrice');
      expect(row).toHaveProperty('purchasePrice');
      expect(row).toHaveProperty('itemKind', 'STOCK');
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=--code'],
      ['itemKind=BOTH'],
      ['isActive=maybe'],
      ['search=SKU'], // renamed to q
      [`q=${'x'.repeat(101)}`],
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${ITEMS}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('a MAIN-only accountant sees every item: the list is not branch-scoped', async () => {
      const all = await everyPage<ItemRow>(accountant, ITEMS, 'sort=code', 5);
      expect(all.total).toBe(ITEMS_TOTAL);
      const owned = await everyPage<ItemRow>(owner, ITEMS, 'sort=code', 5);
      expect(all.rows.map((r) => r.id)).toEqual(owned.rows.map((r) => r.id));
    });

    it("tenant B sees none of A's items", async () => {
      expect(await listAt(tenantB, ITEMS)).toMatchObject({ items: [], total: 0 });
      expect((await listAt(tenantB, ITEMS, '?q=SKU-05')).total).toBe(0);
      expect((await listAt(tenantB, ITEMS, `?q=${encodeURIComponent('صنف مكرر')}`)).total).toBe(0);
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
