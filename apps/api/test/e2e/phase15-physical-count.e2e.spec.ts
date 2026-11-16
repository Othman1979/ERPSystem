/**
 * Phase 15 — advanced physical count (ADR-030), backend:
 *  - scope: WAREHOUSE (with includeZero), GROUP with its subgroups, ITEMS; the
 *    book qty at the count date (a movement after the count date is not in it,
 *    one on the count date is); the branch of the warehouse;
 *  - counting: a second unit, a barcode scan (one of the barcode's unit, a line
 *    created for an item not on the sheet), an item added from the shelf;
 *  - blind counts: no book qty and no difference while a draft, in the JSON and
 *    the sheet export, until submitted;
 *  - submit, reopen: no edit after submit; keyed transitions;
 *  - approval: refused to the creator or to anyone who entered a quantity, even
 *    after another user counted the same line, and to the importer
 *    (STOCK_COUNT_SELF_APPROVAL), accepted to another storekeeper and to the
 *    owner; uncounted lines skipped; a scan is keyed (a replay adds once);
 *    nothing counted refused; the adjustment dated today; a single winner of two
 *    concurrent approvals; a keyed replay;
 *  - Excel: the sheet export, the import (all or nothing, row numbers);
 *  - the difference report (values at the current average cost, zero-cost gains);
 *  - tenant B 404, stock:verify clean, trial balance balanced, OpenAPI audit empty.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { Decimal } from '../../src/common/decimal/decimal.utils.js';
import { addMember } from './support/members.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3714;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p15-audit-${RUN}.jsonl`);
const T = 60_000;

/** The current year: the fiscal year, the count dates and the opening stock sit in it. */
const Y = new Date().getUTCFullYear();
const OPEN = `${Y}-01-02`;
/** A count date: movements on it are in its book, movements after it are not. */
const C = `${Y}-03-10`;
/** A sale after the count date. */
const LATE = `${Y}-03-12`;
const SHEET_BOOK_HEADER = 'رصيد الدفتر';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = (key = `p15-${RUN}-${Math.random().toString(36).slice(2)}`) => ({ 'Idempotency-Key': key });
const d = (value: unknown) => new Decimal(String(value));
/** The company's calendar day (Asia/Amman by default), the approval date. */
const todayCompany = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Amman' });
/** A binary body reader for supertest (the xlsx and pdf answers). */
const binary = (res: unknown, cb: (err: Error | null, body: Buffer) => void) => {
  // superagent hands the raw response stream to a custom parser; its declared type is not a stream.
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
};

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
    cwd: API_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
      OPENAPI_RESPONSE_AUDIT: AUDIT_FILE,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (dat) => process.stderr.write(`[api] ${dat}`));
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
  rmSync(AUDIT_FILE, { force: true });
});

describe('Phase 15 — physical count (ADR-030)', () => {
  let owner = '';
  let ownerB = '';
  let s1 = ''; // storekeeper, MAIN
  let s2 = ''; // storekeeper, MAIN
  let s3 = ''; // storekeeper, B2 only
  let tenantA = '';
  let companyA = '';
  let main = '';
  let b2 = '';
  let W1 = '';
  let W2 = '';
  let pcs = '';
  let box = '';
  let I1 = ''; // PH-A: base PCS, BOX = 12 PCS, barcodes PH-A-PC and PH-A-BX
  let I1BOX = ''; // the item unit of BOX on I1
  let I2 = ''; // PH-B: in the subgroup G1, barcode PH-B-PC
  let I3 = ''; // PH-C: in the group G
  let I4 = ''; // PH-D: no group, no stock
  let SV = ''; // a service item
  let G = '';
  let G1 = '';
  let CB = ''; // the blind count (created and counted by S1)
  let CI = ''; // the import count (a draft, then left as it is)

  const post = (token: string, p: string, body: object = {}, key?: string) =>
    api().post(`/api/v1/${p}`).set(auth(token)).set(idem(key)).send(body);
  const get = (token: string, p: string) => api().get(`/api/v1/${p}`).set(auth(token));
  const put = (token: string, p: string, body: object) => api().put(`/api/v1/${p}`).set(auth(token)).send(body);
  const err = (res: request.Response) => [res.status, res.body.error?.code];

  /** A stock document posted at once (OPENING, OUT or a count-free adjustment). */
  async function adjust(type: 'OPENING' | 'OUT', date: string, warehouseId: string, lines: object[]) {
    const created = await api()
      .post('/api/v1/stock-adjustments')
      .set(auth(owner))
      .send({ adjustmentDate: date, adjustmentType: type, warehouseId, lines });
    expect(created.status).toBe(201);
    const posted = await post(owner, `stock-adjustments/${created.body.id}/post`);
    expect(posted.status).toBe(201);
  }

  /** A count, by the given token, in the given scope. */
  async function count(token: string, body: object) {
    const res = await api().post('/api/v1/stock-counts').set(auth(token)).send(body);
    expect(res.status).toBe(201);
    return res.body as {
      id: string;
      status: string;
      lines: { id: string; itemId: string; systemQty: string | null; differenceQty: string | null; countedQty: string | null; item: { code: string } }[];
    };
  }

  const lineOf = (c: { lines: { item: { code: string } }[] }, code: string) => {
    const found = c.lines.find((l) => l.item.code === code);
    if (!found) throw new Error(`no line ${code}`);
    return found as unknown as { id: string; systemQty: string | null; countedQty: string | null; itemId: string; countedBy?: string | null };
  };

  async function balance(itemId: string, warehouseId: string): Promise<string> {
    const [row] = (await db.query('SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?', [
      tenantA,
      itemId,
      warehouseId,
    ])) as { q: string }[];
    return d(row?.q ?? 0).toString();
  }

  /** The sheet rows of an xlsx answer: the header cells, as text. */
  async function xlsxHeaders(buffer: Buffer): Promise<string[]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = wb.worksheets[0];
    const header = sheet.getRow(1);
    const out: string[] = [];
    header.eachCell((cell) => out.push(String(cell.value)));
    return out;
  }

  async function importFile(token: string, countId: string, rows: (string | number | null)[][]) {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Count');
    sheet.addRow(['Code', 'Barcode', 'Unit', 'Counted']);
    for (const r of rows) sheet.addRow(r);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    return api()
      .post(`/api/v1/stock-counts/${countId}/import`)
      .set(auth(token))
      .attach('file', buf, { filename: 'count.xlsx', contentType: XLSX });
  }

  async function verified(token = owner) {
    const v = await get(token, 'stock/verify');
    expect(v.status).toBe(200);
    expect(v.body.mismatches).toEqual([]);
    const tb = await get(token, 'reports/trial-balance');
    expect(tb.body.balanced).toBe(true);
  }

  // ----------------------------------------------------------------- setup

  it(
    'setup: tenants A and B, a second branch, storekeepers, items with a unit and barcodes, groups, opening stock',
    async () => {
      for (const tag of ['a', 'b']) {
        const res = await api()
          .post('/api/v1/auth/register')
          .send({ tenantName: `P15 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p15-${tag}-${RUN}@test.dev`, password: PASS });
        expect(res.status).toBe(201);
        if (tag === 'a') owner = res.body.accessToken;
        else ownerB = res.body.accessToken;
      }
      const [t] = (await db.query(
        'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
        [`P15 a ${RUN}`],
      )) as { tenantId: bigint; companyId: bigint }[];
      tenantA = String(t.tenantId);
      companyA = String(t.companyId);
      await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P15 % ${RUN}`]);
      const [mainRow] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantA])) as { id: bigint }[];
      main = String(mainRow.id);
      const now = new Date();
      const b2Ins = (await db.query(
        'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        [tenantA, companyA, 'B2', 'فرع 2', now, now],
      )) as { insertId: bigint };
      b2 = String(b2Ins.insertId);
      for (const token of [owner, ownerB]) {
        expect((await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` })).status).toBe(201);
      }
      W1 = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W1', nameAr: 'مستودع 1' })).body.id;
      await db.query('UPDATE warehouses SET branch_id = ? WHERE tenant_id = ? AND id = ?', [main, tenantA, W1]);
      W2 = (await api().post('/api/v1/warehouses').set(auth(owner)).send({ code: 'W2', nameAr: 'مستودع 2' })).body.id;
      await db.query('UPDATE warehouses SET branch_id = ? WHERE tenant_id = ? AND id = ?', [b2, tenantA, W2]);

      const units = (await get(owner, 'units')).body as { id: string; code: string }[];
      pcs = units.find((u) => u.code === 'PCS')!.id;
      box = units.find((u) => u.code === 'BOX')!.id;
      const taxes = (await get(owner, 'tax-categories')).body as { id: string; code: string }[];
      const standard = taxes.find((x) => x.code === 'STANDARD')!.id;

      G = (await api().post('/api/v1/item-groups').set(auth(owner)).send({ code: 'G', nameAr: 'مجموعة' })).body.id;
      G1 = (await api().post('/api/v1/item-groups').set(auth(owner)).send({ code: 'G1', nameAr: 'فرعية', parentId: G })).body.id;

      const mk = async (code: string, extra: object = {}) => {
        const res = await api().post('/api/v1/items').set(auth(owner)).send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: standard, ...extra });
        expect(res.status).toBe(201);
        return res.body.id as string;
      };
      I1 = await mk('PH-A', { units: [{ unitId: box, factorToBase: '12' }] });
      const detail = (await get(owner, `items/${I1}`)).body as { units: { id: string; unitId: string }[] };
      I1BOX = detail.units.find((u) => u.unitId === box)!.id;
      expect((await api().post(`/api/v1/items/${I1}/barcodes`).set(auth(owner)).send({ barcode: `PH-A-PC-${RUN}` })).status).toBe(201);
      expect((await api().post(`/api/v1/items/${I1}/barcodes`).set(auth(owner)).send({ barcode: `PH-A-BX-${RUN}`, itemUnitId: I1BOX })).status).toBe(201);
      I2 = await mk('PH-B', { itemGroupId: G1 });
      expect((await api().post(`/api/v1/items/${I2}/barcodes`).set(auth(owner)).send({ barcode: `PH-B-PC-${RUN}` })).status).toBe(201);
      I3 = await mk('PH-C', { itemGroupId: G });
      I4 = await mk('PH-D');
      SV = await mk('PH-S', { itemKind: 'SERVICE' });

      const addUser = (email: string, branchIds: string[]) =>
        addMember(BASE, owner, { email, roleCode: 'STOREKEEPER', password: PASS, branchIds, defaultBranchId: branchIds[0] });
      s1 = (await addUser(`p15-s1-${RUN}@test.dev`, [main])).token;
      s2 = (await addUser(`p15-s2-${RUN}@test.dev`, [main])).token;
      s3 = (await addUser(`p15-s3-${RUN}@test.dev`, [b2])).token;

      // Opening stock at W1 (PH-A 100, PH-B 40, PH-C 30), a sale on the count date and one after it.
      await adjust('OPENING', OPEN, W1, [
        { itemId: I1, qty: '100', unitCost: '5' },
        { itemId: I2, qty: '40', unitCost: '2' },
        { itemId: I3, qty: '30', unitCost: '3' },
      ]);
      await adjust('OPENING', OPEN, W2, [{ itemId: I1, qty: '20', unitCost: '5' }]);
      await adjust('OUT', C, W1, [{ itemId: I3, qty: '5' }]); // on the count date: in its book
      await adjust('OUT', LATE, W1, [{ itemId: I2, qty: '10' }]); // after the count date: not in its book
      expect(await balance(I2, W1)).toBe('30');
    },
    T,
  );

  describe('scope and the book at the count date (§1, §7)', () => {
    it('WAREHOUSE takes the items with a book at the count date; includeZero adds the rest; later movements are not in the book', async () => {
      const c = await count(owner, { countDate: C, warehouseId: W1, description: 'scope warehouse' });
      expect(c.lines.map((l) => l.item.code).sort()).toEqual(['PH-A', 'PH-B', 'PH-C']);
      expect(d(lineOf(c, 'PH-A').systemQty).toString()).toBe('100');
      expect(d(lineOf(c, 'PH-B').systemQty).toString()).toBe('40'); // the sale after C (LATE) is not in the book
      expect(d(lineOf(c, 'PH-C').systemQty).toString()).toBe('25'); // the sale on C is in it
      const zero = await count(owner, { countDate: C, warehouseId: W1, includeZero: true });
      expect(zero.lines.map((l) => l.item.code).sort()).toEqual(['PH-A', 'PH-B', 'PH-C', 'PH-D']);
      expect(d(lineOf(zero, 'PH-D').systemQty).toString()).toBe('0');
    });

    it('GROUP takes the group and its subgroups; ITEMS takes the chosen items; bad scopes are refused', async () => {
      const g = await count(owner, { countDate: C, warehouseId: W1, scope: 'GROUP', itemGroupId: G });
      expect(g.lines.map((l) => l.item.code).sort()).toEqual(['PH-B', 'PH-C']); // PH-B is in the subgroup G1
      const it1 = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1, I4] });
      expect(it1.lines.map((l) => l.item.code).sort()).toEqual(['PH-A', 'PH-D']);
      expect(d(lineOf(it1, 'PH-D').systemQty).toString()).toBe('0'); // chosen items count even with no book
      expect(err(await post(owner, 'stock-counts', { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [SV] }))).toEqual([400, 'VALIDATION']);
      expect(err(await post(owner, 'stock-counts', { countDate: C, warehouseId: W1, scope: 'GROUP', itemGroupId: '999999' }))).toEqual([404, 'NOT_FOUND']);
      expect(err(await post(owner, 'stock-counts', { countDate: C, warehouseId: W1, scope: 'GROUP' }))).toEqual([400, 'VALIDATION']);
    });

    it('a count date in the future is refused', async () => {
      const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      expect(err(await post(owner, 'stock-counts', { countDate: future, warehouseId: W1 }))).toEqual([400, 'VALIDATION']);
    });

    it('branch: a storekeeper of another branch neither counts the warehouse nor sees its count', async () => {
      const refused = await api().post('/api/v1/stock-counts').set(auth(s3)).send({ countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1] });
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      const mine = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1] });
      expect((await get(s3, `stock-counts/${mine.id}`)).status).toBe(404);
    });
  });

  describe('counting (§7, §8, §9)', () => {
    let CM = ''; // the scanning count: PH-A and PH-C on the sheet

    it('counts in a second unit: the base quantity is stored with the entered one; null clears the line', async () => {
      const c = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1, I3] });
      CM = c.id;
      const a = lineOf(c, 'PH-A');
      const boxes = await put(owner, `stock-counts/${CM}/lines/${a.id}`, { itemUnitId: I1BOX, countedQty: '2' });
      expect(boxes.status).toBe(200);
      expect([d(boxes.body.countedQty).toString(), boxes.body.itemUnit.unit.code, d(boxes.body.countedUnitQty).toString()]).toEqual(['24', 'BOX', '2']);
      const fractional = await put(owner, `stock-counts/${CM}/lines/${a.id}`, { itemUnitId: I1BOX, countedQty: '2.5' });
      expect(d(fractional.body.countedQty).toString()).toBe('30');
      expect(d(fractional.body.differenceQty).toString()).toBe('-70'); // 30 counted against the book of 100
      expect(err(await put(owner, `stock-counts/${CM}/lines/${a.id}`, { itemUnitId: '999999', countedQty: '1' }))).toEqual([400, 'VALIDATION']);
      const cleared = await put(owner, `stock-counts/${CM}/lines/${a.id}`, { countedQty: null });
      expect([cleared.body.countedQty, cleared.body.itemUnitId, cleared.body.countedBy]).toEqual([null, null, null]);
    });

    it('a scan adds one of the barcode unit, a base scan adds one base unit, an unknown barcode is 404', async () => {
      const bx = await post(owner, `stock-counts/${CM}/scan`, { barcode: `PH-A-BX-${RUN}` });
      expect(bx.status).toBe(201);
      expect([d(bx.body.countedQty).toString(), d(bx.body.countedUnitQty).toString(), bx.body.itemUnit.unit.code]).toEqual(['12', '1', 'BOX']);
      const bx2 = await post(owner, `stock-counts/${CM}/scan`, { barcode: `PH-A-BX-${RUN}` });
      expect([d(bx2.body.countedQty).toString(), d(bx2.body.countedUnitQty).toString()]).toEqual(['24', '2']);
      const pc = await post(owner, `stock-counts/${CM}/scan`, { barcode: `PH-A-PC-${RUN}` });
      // The line was counted in boxes; a base scan makes the total 25 base units, not a whole number of boxes.
      expect([d(pc.body.countedQty).toString(), pc.body.itemUnitId, d(pc.body.countedUnitQty).toString()]).toEqual(['25', null, '25']);
      const newLine = await post(owner, `stock-counts/${CM}/scan`, { barcode: `PH-B-PC-${RUN}` }); // PH-B is not on the sheet
      expect(newLine.status).toBe(201);
      expect([newLine.body.item.code, d(newLine.body.countedQty).toString(), d(newLine.body.systemQty).toString()]).toEqual(['PH-B', '1', '40']);
      expect(err(await post(owner, `stock-counts/${CM}/scan`, { barcode: `NOPE-${RUN}` }))).toEqual([404, 'NOT_FOUND']);
    });

    it('an item found on the shelf is added once; a service item is refused', async () => {
      const added = await post(owner, `stock-counts/${CM}/lines`, { itemId: I4 });
      expect(added.status).toBe(201);
      expect(d(added.body.systemQty).toString()).toBe('0');
      expect(err(await post(owner, `stock-counts/${CM}/lines`, { itemId: I4 }))).toEqual([409, 'CONFLICT']);
      expect(err(await post(owner, `stock-counts/${CM}/lines`, { itemId: SV }))).toEqual([400, 'VALIDATION']);
    });

    it('a scan into a new count line counts in boxes when the total is whole boxes', async () => {
      const c = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I3] });
      const first = await post(owner, `stock-counts/${c.id}/scan`, { barcode: `PH-A-BX-${RUN}` }); // PH-A is not on this sheet
      expect(first.status).toBe(201);
      expect([first.body.item.code, first.body.itemUnit.unit.code, d(first.body.countedQty).toString()]).toEqual(['PH-A', 'BOX', '12']);
    });

    it('a scan needs an Idempotency-Key; a replay with the same key adds once, a new key adds again', async () => {
      const c = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1] });
      const bare = await api().post(`/api/v1/stock-counts/${c.id}/scan`).set(auth(owner)).send({ barcode: `PH-A-PC-${RUN}` });
      expect(err(bare)).toEqual([400, 'VALIDATION']);
      const key = `p15-scan-${RUN}`;
      const first = await post(owner, `stock-counts/${c.id}/scan`, { barcode: `PH-A-PC-${RUN}` }, key);
      expect(first.status).toBe(201);
      expect(d(first.body.countedQty).toString()).toBe('1');
      const replay = await post(owner, `stock-counts/${c.id}/scan`, { barcode: `PH-A-PC-${RUN}` }, key);
      expect([replay.status, d(replay.body.countedQty).toString()]).toEqual([201, '1']);
      expect(d(lineOf((await get(owner, `stock-counts/${c.id}`)).body, 'PH-A').countedQty).toString()).toBe('1');
      const again = await post(owner, `stock-counts/${c.id}/scan`, { barcode: `PH-A-PC-${RUN}` });
      expect(d(again.body.countedQty).toString()).toBe('2');
    });
  });

  describe('blind counts, submit and reopen (§5, §6)', () => {

    it('a blind draft shows no book qty or difference anywhere, until submitted', async () => {
      const c = await count(s1, { countDate: C, warehouseId: W1, blind: true, description: 'blind' });
      CB = c.id;
      expect(c.lines.every((l) => l.systemQty === null && l.differenceQty === null)).toBe(true);
      for (const [code, qty] of [['PH-A', '95'], ['PH-B', '35'], ['PH-C', '25']] as const) {
        const upd = await put(s1, `stock-counts/${CB}/lines/${lineOf(c, code).id}`, { countedQty: qty });
        expect([upd.status, upd.body.systemQty, upd.body.differenceQty]).toEqual([200, null, null]);
      }
      const got = await get(s1, `stock-counts/${CB}`);
      expect(got.body.lines.every((l: { systemQty: unknown; differenceQty: unknown }) => l.systemQty === null && l.differenceQty === null)).toBe(true);
      const json = await get(s1, `stock-counts/${CB}/sheet`);
      expect(json.body.bookHidden).toBe(true);
      expect(json.body.rows.every((r: object) => !('bookQty' in r))).toBe(true);
      const xlsx = await api().get(`/api/v1/stock-counts/${CB}/sheet?format=xlsx`).set(auth(s1)).buffer(true).parse(binary);
      expect(xlsx.status).toBe(200);
      expect(await xlsxHeaders(xlsx.body as Buffer)).not.toContain(SHEET_BOOK_HEADER);
      expect((await get(s1, `stock-counts/${CB}/variance`)).status).toBe(409); // the difference is hidden too
    });

    it('submit shows the book; submit needs a key; a submitted count takes no edit; reopen brings it back', async () => {
      expect((await api().post(`/api/v1/stock-counts/${CB}/submit`).set(auth(s1)).send({})).status).toBe(400); // no key
      expect(await post(s1, `stock-counts/${CB}/submit`)).toMatchObject({ status: 201, body: { status: 'SUBMITTED' } });
      const shown = await get(s1, `stock-counts/${CB}`);
      expect(d(lineOf(shown.body, 'PH-A').systemQty).toString()).toBe('100');
      const sheet = await get(s1, `stock-counts/${CB}/sheet`);
      expect(sheet.body.bookHidden).toBe(false);
      expect(d(sheet.body.rows.find((r: { code: string }) => r.code === 'PH-A').bookQty).toString()).toBe('100');
      expect((await get(s1, `stock-counts/${CB}/variance`)).status).toBe(200);
      // Nothing is edited after submit.
      const a = lineOf(shown.body, 'PH-A');
      expect(err(await put(s1, `stock-counts/${CB}/lines/${a.id}`, { countedQty: '1' }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(err(await post(s1, `stock-counts/${CB}/scan`, { barcode: `PH-A-PC-${RUN}` }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(err(await post(s1, `stock-counts/${CB}/lines`, { itemId: I4 }))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(err(await post(s1, `stock-counts/${CB}/refresh`))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect(err(await api().delete(`/api/v1/stock-counts/${CB}`).set(auth(s1)))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      // Reopen is keyed; a draft cannot be reopened; the count is editable again.
      expect((await api().post(`/api/v1/stock-counts/${CB}/reopen`).set(auth(s1)).send({})).status).toBe(400);
      expect(await post(s1, `stock-counts/${CB}/reopen`)).toMatchObject({ status: 201, body: { status: 'DRAFT' } });
      expect(err(await post(s1, `stock-counts/${CB}/reopen`))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
      expect((await put(s1, `stock-counts/${CB}/lines/${a.id}`, { countedQty: '95' })).status).toBe(200);
      expect(await post(s1, `stock-counts/${CB}/submit`)).toMatchObject({ status: 201, body: { status: 'SUBMITTED' } });
    });
  });

  describe('Excel sheet import (§11)', () => {

    it('a bad sheet is refused as a whole, listing every row with a problem', async () => {
      const c = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1, I2, I3, I4] });
      CI = c.id;
      const bad = await importFile(owner, CI, [
        ['PH-A', null, null, 50], // row 2: valid
        ['NOPE', null, null, 1], // row 3: unknown item
        ['PH-B', null, null, '-1'], // row 4: negative
        ['PH-B', null, null, 2], // row 5: valid
        ['PH-B', null, null, 3], // row 6: duplicate of row 5
        ['PH-A', null, 'XYZ', 1], // row 7: unknown unit
        [null, `PH-A-PC-${RUN}`, null, '1.1234567'], // row 8: more than 6 decimals
        [null, null, null, null], // row 9: blank, skipped
      ]);
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION');
      const rows = (bad.body.error.details.errors as { row: number; reason: string }[]).map((e) => e.row);
      expect(rows).toEqual([3, 4, 6, 7, 8]);
      expect(bad.body.error.details.errors[0].reason).toMatch(/^UNKNOWN_ITEM/);
      const after = await get(owner, `stock-counts/${CI}`);
      expect(lineOf(after.body, 'PH-A').countedQty).toBeNull(); // nothing applied
    });

    it('a good sheet sets the counted quantities (units and zeros included) and skips the empty cells', async () => {
      const ok = await importFile(owner, CI, [
        ['PH-A', null, 'BOX', 2], // two boxes = 24 PCS
        ['PH-B', null, null, 35],
        ['PH-C', null, null, null], // not counted: skipped
        ['PH-D', null, null, 0], // an explicit zero is a count
      ]);
      expect(ok.status).toBe(201);
      expect(d(lineOf(ok.body, 'PH-A').countedQty).toString()).toBe('24');
      expect(ok.body.lines.find((l: { item: { code: string } }) => l.item.code === 'PH-A').itemUnit.unit.code).toBe('BOX');
      expect(d(lineOf(ok.body, 'PH-B').countedQty).toString()).toBe('35');
      expect(lineOf(ok.body, 'PH-C').countedQty).toBeNull();
      expect(d(lineOf(ok.body, 'PH-D').countedQty).toString()).toBe('0');
    });

    it('the file must be an xlsx, and a count that is not a draft takes no import', async () => {
      const csv = await api()
        .post(`/api/v1/stock-counts/${CI}/import`)
        .set(auth(owner))
        .attach('file', Buffer.from('code,counted\nPH-A,1\n'), { filename: 'count.csv', contentType: 'text/csv' });
      expect(csv.status).toBe(400);
      expect((await api().post(`/api/v1/stock-counts/${CI}/import`).set(auth(owner))).status).toBe(400); // no file
      expect((await api().post(`/api/v1/stock-counts/${CI}/import`).set(auth(ownerB)).attach('file', Buffer.from('x'), { filename: 'a.xlsx', contentType: XLSX })).status).toBe(404);
    });
  });

  describe('approval (§1, §3, §4, §12)', () => {
    let CP = '';
    let CK = '';

    it('the difference report: values at the current average cost, uncounted lines and totals', async () => {
      const v = await get(owner, `stock-counts/${CI}/variance`);
      expect(v.status).toBe(200);
      const codes = v.body.lines.map((l: { code: string }) => l.code).sort();
      expect(codes).toEqual(['PH-A', 'PH-B', 'PH-D']);
      expect(v.body.uncounted.map((u: { code: string }) => u.code)).toEqual(['PH-C']);
      const a = v.body.lines.find((l: { code: string }) => l.code === 'PH-A');
      expect([d(a.bookQty).toString(), d(a.countedQty).toString(), d(a.differenceQty).toString()]).toEqual(['100', '24', '-76']);
      expect(d(a.unitCost).toString()).toBe('5');
      expect(d(a.differenceValue).toString()).toBe('-380');
      expect(d(v.body.totals.shortageQty).toString()).toBe('-81'); // -76 PH-A and -5 PH-B
      expect(d(v.body.totals.shortageValue).toString()).toBe('-390'); // -380 and -10
      expect(d(v.body.totals.surplusValue).toString()).toBe('0');
      expect(d(v.body.totals.netValue).toString()).toBe('-390');
      expect([v.body.totals.countedLines, v.body.totals.uncountedLines]).toEqual([3, 1]);
      const pdf = await api().get(`/api/v1/stock-counts/${CI}/variance?format=pdf`).set(auth(owner)).buffer(true).parse(binary);
      expect([pdf.status, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);
      const sheet = await api().get(`/api/v1/stock-counts/${CI}/variance?format=xlsx`).set(auth(owner)).buffer(true).parse(binary);
      expect([sheet.status, sheet.headers['content-type']]).toEqual([200, XLSX]);
    });

    it('a count with nothing counted is refused; the counter cannot approve it; another storekeeper approves it', async () => {
      // Nothing counted: refused at approval.
      const empty = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I3] });
      expect((await post(owner, `stock-counts/${empty.id}/submit`)).status).toBe(201);
      expect(err(await post(owner, `stock-counts/${empty.id}/approve`))).toEqual([400, 'VALIDATION']);

      // Storekeeper S1 counts PH-B, the owner created the count: S1 may not approve it; S2 may.
      CK = (await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I2] })).id;
      const bLine = lineOf(await get(owner, `stock-counts/${CK}`).then((r) => r.body), 'PH-B');
      expect((await put(s1, `stock-counts/${CK}/lines/${bLine.id}`, { countedQty: '38' })).status).toBe(200);
      expect((await post(s1, `stock-counts/${CK}/submit`)).status).toBe(201);
      const selfApprove = await api().post(`/api/v1/stock-counts/${CK}/approve`).set(auth(s1)).set(idem());
      expect([selfApprove.status, selfApprove.body.error.code]).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);
      const before = await balance(I2, W1);
      const other = await api().post(`/api/v1/stock-counts/${CK}/approve`).set(auth(s2)).set(idem());
      expect(other.status).toBe(201);
      expect(other.body.status).toBe('POSTED');
      // The difference is 38 - 40 = -2, on the current book.
      expect(d(await balance(I2, W1)).toString()).toBe(d(before).minus(2).toString());
    });

    it('uncounted lines are skipped; the adjustment is dated today; on-hand = current + difference', async () => {
      // CP: PH-A counted 90 (book 100), PH-B counted 40 (book at C 40: no difference), PH-C not counted.
      const cp = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1, I2, I3] });
      CP = cp.id;
      expect((await put(owner, `stock-counts/${CP}/lines/${lineOf(cp, 'PH-A').id}`, { countedQty: '90' })).status).toBe(200);
      expect((await put(owner, `stock-counts/${CP}/lines/${lineOf(cp, 'PH-B').id}`, { countedQty: '40' })).status).toBe(200);
      expect((await post(owner, `stock-counts/${CP}/submit`)).status).toBe(201);
      const beforeA = await balance(I1, W1);
      const beforeB = await balance(I2, W1);
      const beforeC = await balance(I3, W1);
      const approved = await post(owner, `stock-counts/${CP}/approve`);
      expect(approved.status).toBe(201);
      expect([approved.body.status, approved.body.docNo === null]).toEqual(['POSTED', false]);
      const adj = await get(owner, `stock-adjustments/${approved.body.adjustmentId}`);
      expect(adj.body.adjustmentDate.slice(0, 10)).toBe(todayCompany());
      expect(adj.body.adjustmentType).toBe('COUNT_ADJUSTMENT');
      expect(adj.body.lines.map((l: { item: { code: string } }) => l.item.code)).toEqual(['PH-A']); // PH-B has no difference
      expect(await balance(I1, W1)).toBe(d(beforeA).minus(10).toString());
      expect(await balance(I2, W1)).toBe(beforeB); // the sale after C is in the current balance, not the difference
      expect(await balance(I3, W1)).toBe(beforeC); // not counted: nothing posted for it
      expect(err(await post(owner, `stock-counts/${CP}/approve`))).toEqual([409, 'INVALID_STATUS_TRANSITION']);
    });

    it('a surplus at zero cost: the report flags it; the owner approves it; the gain is booked at zero cost', async () => {
      const cz = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I4] });
      expect((await put(owner, `stock-counts/${cz.id}/lines/${lineOf(cz, 'PH-D').id}`, { countedQty: '3' })).status).toBe(200);
      expect((await post(owner, `stock-counts/${cz.id}/submit`)).status).toBe(201);
      const v = await get(owner, `stock-counts/${cz.id}/variance`);
      const line = v.body.lines[0];
      expect([line.zeroCostGain, d(line.differenceQty).toString(), d(line.differenceValue).toString()]).toEqual([true, '3', '0']);
      expect((await post(owner, `stock-counts/${cz.id}/approve`)).status).toBe(201);
      expect(await balance(I4, W1)).toBe('3');
    });

    it('two concurrent approvals: one wins, the other is refused; a keyed replay returns the same result', async () => {
      const cc = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I1] });
      expect((await put(owner, `stock-counts/${cc.id}/lines/${lineOf(cc, 'PH-A').id}`, { countedQty: '80' })).status).toBe(200);
      expect((await post(owner, `stock-counts/${cc.id}/submit`)).status).toBe(201);
      const before = await balance(I1, W1);
      const k1 = `p15-race-1-${RUN}`;
      const k2 = `p15-race-2-${RUN}`;
      const [x, y] = await Promise.all([
        api().post(`/api/v1/stock-counts/${cc.id}/approve`).set(auth(owner)).set(idem(k1)),
        api().post(`/api/v1/stock-counts/${cc.id}/approve`).set(auth(owner)).set(idem(k2)),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      const winner = x.status === 201 ? x : y;
      expect(d(await balance(I1, W1)).toString()).toBe(d(before).minus(20).toString()); // posted once: 100 - 20 on the book of C
      // The same key again replays the stored answer; nothing is posted twice.
      const replay = await api().post(`/api/v1/stock-counts/${cc.id}/approve`).set(auth(owner)).set(idem(x.status === 201 ? k1 : k2));
      expect([replay.status, replay.body.docNo]).toEqual([201, winner.body.docNo]);
      expect(d(await balance(I1, W1)).toString()).toBe(d(before).minus(20).toString());
    });

    it('a counter cannot approve after another storekeeper counted the same line; the importer cannot approve', async () => {
      // S1 enters PH-B, then S2 enters the same line: the line now names S2, but S1 still counted it.
      const cr = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I2] });
      const bLine = lineOf(cr, 'PH-B');
      expect((await put(s1, `stock-counts/${cr.id}/lines/${bLine.id}`, { countedQty: '39' })).status).toBe(200);
      expect((await put(s2, `stock-counts/${cr.id}/lines/${bLine.id}`, { countedQty: '40' })).status).toBe(200);
      expect((await post(owner, `stock-counts/${cr.id}/submit`)).status).toBe(201);
      const detail = await get(owner, `stock-counts/${cr.id}`);
      expect(detail.body.counterIds).toHaveLength(2);
      expect(err(await api().post(`/api/v1/stock-counts/${cr.id}/approve`).set(auth(s1)).set(idem()))).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);
      expect(err(await api().post(`/api/v1/stock-counts/${cr.id}/approve`).set(auth(s2)).set(idem()))).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);

      // S2 imports a sheet (the importer is a counter); S2 may not approve it, S1 (who did not count it) may.
      const ci = await count(owner, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I3] });
      expect((await importFile(s2, ci.id, [['PH-C', null, null, 26]])).status).toBe(201);
      expect((await post(owner, `stock-counts/${ci.id}/submit`)).status).toBe(201);
      expect(err(await api().post(`/api/v1/stock-counts/${ci.id}/approve`).set(auth(s2)).set(idem()))).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);
      expect((await api().post(`/api/v1/stock-counts/${ci.id}/approve`).set(auth(s1)).set(idem())).status).toBe(201);
    });

    it('the owner may approve a count they counted; a count of tenant A is 404 for tenant B', async () => {
      expect((await get(ownerB, `stock-counts/${CP}`)).status).toBe(404);
      expect((await get(ownerB, `stock-counts/${CP}/sheet`)).status).toBe(404);
      expect((await get(ownerB, `stock-counts/${CP}/variance`)).status).toBe(404);
      expect((await post(ownerB, `stock-counts/${CI}/submit`)).status).toBe(404);
      expect((await put(ownerB, `stock-counts/${CI}/lines/${lineOf(await get(owner, `stock-counts/${CI}`).then((r) => r.body), 'PH-A').id}`, { countedQty: '1' })).status).toBe(404);
      expect((await post(ownerB, `stock-counts/${CI}/scan`, { barcode: `PH-A-PC-${RUN}` })).status).toBe(404);
      expect((await api().post(`/api/v1/stock-counts/${CI}/approve`).set(auth(ownerB)).set(idem())).status).toBe(404);
      expect((await post(ownerB, `stock-counts/${CI}/reopen`)).status).toBe(404);
      expect((await api().post(`/api/v1/stock-counts/${CI}/import`).set(auth(ownerB)).attach('file', Buffer.from('x'), { filename: 'a.xlsx', contentType: XLSX })).status).toBe(404);
    });

    it('the counts of storekeeper S1 are approved by S2 when S1 created them (the creator is refused, another approves)', async () => {
      const mine = await count(s1, { countDate: C, warehouseId: W1, scope: 'ITEMS', itemIds: [I3] });
      expect((await put(s1, `stock-counts/${mine.id}/lines/${lineOf(mine, 'PH-C').id}`, { countedQty: '30' })).status).toBe(200);
      expect((await post(s1, `stock-counts/${mine.id}/submit`)).status).toBe(201);
      expect(err(await api().post(`/api/v1/stock-counts/${mine.id}/approve`).set(auth(s1)).set(idem()))).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);
      const beforeI3 = await balance(I3, W1);
      const ok = await api().post(`/api/v1/stock-counts/${mine.id}/approve`).set(auth(s2)).set(idem());
      expect(ok.status).toBe(201);
      // Counted 30 against the book of C (25): +5 on the current balance (25).
      expect(await balance(I3, W1)).toBe(d(beforeI3).plus(5).toString());
    });
  });

  it('a blind count: its creator is refused, another storekeeper approves it on the book at the count date', async () => {
      expect(err(await api().post(`/api/v1/stock-counts/${CB}/approve`).set(auth(s1)).set(idem()))).toEqual([403, 'STOCK_COUNT_SELF_APPROVAL']);
      const before = { a: await balance(I1, W1), b: await balance(I2, W1), c: await balance(I3, W1) };
      const ok = await api().post(`/api/v1/stock-counts/${CB}/approve`).set(auth(s2)).set(idem());
      expect([ok.status, ok.body.status]).toEqual([201, 'POSTED']);
      // Counted 95, 35, 25 against the book at C (100, 40, 25): -5, -5, 0.
      expect(await balance(I1, W1)).toBe(d(before.a).minus(5).toString());
      expect(await balance(I2, W1)).toBe(d(before.b).minus(5).toString());
      expect(await balance(I3, W1)).toBe(before.c);
    });

  it('after the postings: stock:verify has no differences and the trial balance balances', async () => {
    await verified(owner);
  });

  it('the OpenAPI response audit stays empty', () => {
    const found = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8') : '';
    expect(found).toBe('');
  });
});
