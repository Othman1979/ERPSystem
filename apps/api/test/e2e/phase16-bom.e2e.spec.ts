/**
 * Phase 16 part A — bills of materials (ADR-031 §1, §5, §6, §11):
 *  - versions: a draft is created with version_no max + 1; only a draft is changed or
 *    deleted (BOM_NOT_DRAFT); copy makes a new draft; activation makes the item's only
 *    ACTIVE version (the previous one INACTIVE); deactivation; reactivation;
 *  - refusals on create: a non-manufactured item, a service component, the item as its
 *    own component, a unit of another item (BOM_UNIT_INVALID);
 *  - a loop through the active versions refused at activation (BOM_CYCLE), the state kept;
 *  - the requirements preview: the ratio, the waste percentage, one level only;
 *  - a MANUFACTURED item behaves as stock: a purchase, a sale with its cost, a count;
 *  - the PDF, tenant B 404 on every route, stock:verify clean, trial balance balanced,
 *    and the OpenAPI response audit empty.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { Decimal } from '../../src/common/decimal/decimal.utils.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3716;
const BASE = `http://127.0.0.1:${API_PORT}`;
const API_DIR = path.resolve(import.meta.dirname, '..', '..');
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const AUDIT_FILE = path.join(os.tmpdir(), `p16-audit-${RUN}.jsonl`);

/** The current year: the fiscal year and every document date sit in it. */
const Y = new Date().getUTCFullYear();

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `p16-${RUN}-${Math.random().toString(36).slice(2)}` });
const d = (value: unknown) => new Decimal(String(value));
/** A binary body reader for supertest (the pdf answer). */
const binary = (res: unknown, cb: (err: Error | null, body: Buffer) => void) => {
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

describe('Phase 16 — bills of materials (ADR-031, part A)', () => {
  let ownerA = '';
  let ownerB = '';
  let tenantA = '';
  let W1 = '';
  let pcs = '';
  let box = '';
  let standard = '';
  let customer = '';
  let supplier = '';
  let M1 = ''; // manufactured product: base PCS
  let SF1 = ''; // semi-finished, manufactured: base PCS
  let R1 = ''; // raw material: base PCS, BOX = 12 PCS
  let R1BOX = ''; // the BOX unit row of R1
  let R2 = ''; // raw material: base PCS
  let SV = ''; // a service
  let M1V1 = ''; // M1 version 1: SF1 x 1 + R1 x 3 BOX, waste 5% on R1, applied cost 2.500
  let SF1V1 = ''; // SF1 version 1: R2 x 5, no waste
  let SF1V2 = ''; // SF1 version 2: a draft with M1 as a component (the loop)

  const get = (token: string, p: string) => api().get(`/api/v1/${p}`).set(auth(token));
  const post = (token: string, p: string, body: object = {}) => api().post(`/api/v1/${p}`).set(auth(token)).set(idem()).send(body);
  const err = (res: request.Response) => [res.status, res.body.error?.code];

  /** A posted purchase or sale invoice: created, then posted with its own key. */
  async function createAndPost(kind: string, body: object) {
    const created = await api().post(`/api/v1/${kind}`).set(auth(ownerA)).send(body);
    if (created.status !== 201) throw new Error(`create ${kind} → ${created.status} ${JSON.stringify(created.body)}`);
    const posted = await post(ownerA, `${kind}/${created.body.id}/post`);
    return { created, posted };
  }

  async function stockOf(itemId: string, warehouseId: string): Promise<string> {
    const [row] = (await db.query('SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?', [
      tenantA,
      itemId,
      warehouseId,
    ])) as { q: string }[];
    return d(row?.q ?? 0).toString();
  }

  // ----------------------------------------------------------------- setup

  it('setup: tenants A and B, a warehouse, units, items (manufactured, raw, a service), parties', async () => {
    for (const tag of ['a', 'b']) {
      const res = await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `P16 ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p16-${tag}-${RUN}@test.dev`, password: PASS });
      expect(res.status).toBe(201);
      if (tag === 'a') ownerA = res.body.accessToken;
      else ownerB = res.body.accessToken;
    }
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P16 % ${RUN}`]);
    const [t] = (await db.query('SELECT id AS tenantId FROM tenants WHERE name = ?', [`P16 a ${RUN}`])) as { tenantId: bigint }[];
    tenantA = String(t.tenantId);
    for (const token of [ownerA, ownerB]) {
      expect((await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` })).status).toBe(201);
    }
    W1 = (await api().post('/api/v1/warehouses').set(auth(ownerA)).send({ code: 'W1', nameAr: 'مستودع 1' })).body.id;

    const units = (await get(ownerA, 'units')).body as { id: string; code: string }[];
    pcs = units.find((u) => u.code === 'PCS')!.id;
    box = units.find((u) => u.code === 'BOX')!.id;
    standard = ((await get(ownerA, 'tax-categories')).body as { id: string; code: string }[]).find((x) => x.code === 'STANDARD')!.id;

    const mk = async (code: string, extra: object = {}) => {
      const res = await api().post('/api/v1/items').set(auth(ownerA)).send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: standard, ...extra });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    M1 = await mk('P16-M1', { itemKind: 'MANUFACTURED' });
    SF1 = await mk('P16-SF1', { itemKind: 'MANUFACTURED' });
    R1 = await mk('P16-R1', { units: [{ unitId: box, factorToBase: '12' }] });
    const detail = (await get(ownerA, `items/${R1}`)).body as { units: { id: string; unitId: string }[] };
    R1BOX = detail.units.find((u) => u.unitId === box)!.id;
    R2 = await mk('P16-R2');
    SV = await mk('P16-SV', { itemKind: 'SERVICE' });

    customer = (await api().post('/api/v1/parties').set(auth(ownerA)).send({ code: 'C16', nameAr: 'عميل', partyType: 'CUSTOMER' })).body.id;
    supplier = (await api().post('/api/v1/parties').set(auth(ownerA)).send({ code: 'S16', nameAr: 'مورد', partyType: 'SUPPLIER' })).body.id;
  });

  // ------------------------------------------------------------- versions

  it('create: a draft per manufactured item, version 1, lines in base units (a unit of the component, the base unit when none)', async () => {
    const sf = await post(ownerA, 'boms', { itemId: SF1, outputQty: '10', lines: [{ componentItemId: R2, qty: '5' }] });
    expect(sf.status).toBe(201);
    expect([sf.body.versionNo, sf.body.status]).toEqual([1, 'DRAFT']);
    expect(sf.body.outputItemUnit).toBeNull(); // no unit given: the base unit
    SF1V1 = sf.body.id;

    const m1 = await post(ownerA, 'boms', {
      itemId: M1,
      outputQty: '10',
      appliedCostPerUnit: '2.500',
      lines: [
        { componentItemId: SF1, qty: '1' },
        { componentItemId: R1, itemUnitId: R1BOX, qty: '3', wastePct: '5' },
      ],
    });
    expect(m1.status).toBe(201);
    expect(m1.body.lines.map((l: { qtyBase: string }) => d(l.qtyBase).toString())).toEqual(['1', '36']);
    expect([d(m1.body.lines[1].qty).toString(), d(m1.body.lines[1].wastePct).toString()]).toEqual(['3', '5']);
    expect(d(m1.body.appliedCostPerUnit).toString()).toBe('2.5');
    M1V1 = m1.body.id;
  });

  it('refused on create: a non-manufactured item, a service or the item itself as component, a unit of another item', async () => {
    expect(err(await post(ownerA, 'boms', { itemId: R1, outputQty: '1', lines: [{ componentItemId: R2, qty: '1' }] }))).toEqual([400, 'BOM_ITEM_NOT_MANUFACTURED']);
    expect(err(await post(ownerA, 'boms', { itemId: M1, outputQty: '1', lines: [{ componentItemId: SV, qty: '1' }] }))).toEqual([400, 'BOM_COMPONENT_INVALID']);
    expect(err(await post(ownerA, 'boms', { itemId: M1, outputQty: '1', lines: [{ componentItemId: M1, qty: '1' }] }))).toEqual([400, 'BOM_COMPONENT_INVALID']);
    // R1's BOX row used on R2: the unit belongs to another item.
    expect(err(await post(ownerA, 'boms', { itemId: M1, outputQty: '1', lines: [{ componentItemId: R2, itemUnitId: R1BOX, qty: '1' }] }))).toEqual([400, 'BOM_UNIT_INVALID']);
    expect(err(await post(ownerA, 'boms', { itemId: M1, outputQty: '1', lines: [{ componentItemId: R2, qty: '0' }] }))).toEqual([400, 'VALIDATION']);
  });

  it('update and delete only a draft; a copy is a new draft with the same lines', async () => {
    const put = await api()
      .put(`/api/v1/boms/${M1V1}`)
      .set(auth(ownerA))
      .send({
        outputQty: '10',
        appliedCostPerUnit: '3.000',
        note: 'updated',
        lines: [
          { componentItemId: SF1, qty: '1' },
          { componentItemId: R1, itemUnitId: R1BOX, qty: '3', wastePct: '5' },
        ],
      });
    expect(put.status).toBe(200);
    expect([d(put.body.appliedCostPerUnit).toString(), put.body.note]).toEqual(['3', 'updated']);

    const copy = await post(ownerA, `boms/${M1V1}/copy`);
    expect(copy.status).toBe(201);
    expect([copy.body.versionNo, copy.body.status, copy.body.lines.length]).toEqual([2, 'DRAFT', 2]);
    const removed = await api().delete(`/api/v1/boms/${copy.body.id}`).set(auth(ownerA));
    expect([removed.status, removed.body]).toEqual([200, { deleted: true }]);
  });

  // ----------------------------------------------------------- activation

  it('activation: one ACTIVE version per item; the previous one goes INACTIVE; an active version is not edited', async () => {
    expect((await post(ownerA, `boms/${M1V1}/activate`)).body.status).toBe('ACTIVE');
    expect((await post(ownerA, `boms/${SF1V1}/activate`)).body.status).toBe('ACTIVE');

    const v2 = await post(ownerA, `boms/${M1V1}/copy`);
    expect(v2.body.versionNo).toBe(2);
    const v2Id = v2.body.id as string;
    expect((await post(ownerA, `boms/${v2Id}/activate`)).body.status).toBe('ACTIVE');

    const [v1Row] = (await db.query('SELECT status FROM boms WHERE tenant_id = ? AND id = ?', [tenantA, M1V1])) as { status: string }[];
    expect(v1Row.status).toBe('INACTIVE');
    const [count] = (await db.query("SELECT COUNT(*) AS n FROM boms WHERE tenant_id = ? AND item_id = ? AND status = 'ACTIVE'", [tenantA, M1])) as {
      n: bigint;
    }[];
    expect(Number(count.n)).toBe(1);

    expect(err(await api().put(`/api/v1/boms/${v2Id}`).set(auth(ownerA)).send({ outputQty: '1', lines: [{ componentItemId: R2, qty: '1' }] }))).toEqual([409, 'BOM_NOT_DRAFT']);
    expect(err(await api().delete(`/api/v1/boms/${v2Id}`).set(auth(ownerA)))).toEqual([409, 'BOM_NOT_DRAFT']);

    // Deactivate, then bring the first version back.
    expect((await post(ownerA, `boms/${v2Id}/deactivate`)).body.status).toBe('INACTIVE');
    expect((await post(ownerA, `boms/${M1V1}/activate`)).body.status).toBe('ACTIVE');
  });

  it('refused: a loop through the active versions (M1 uses SF1, SF1 would use M1)', async () => {
    const loop = await post(ownerA, 'boms', { itemId: SF1, outputQty: '10', lines: [{ componentItemId: M1, qty: '1' }] });
    expect(loop.status).toBe(201);
    SF1V2 = loop.body.id;
    expect(err(await post(ownerA, `boms/${SF1V2}/activate`))).toEqual([409, 'BOM_CYCLE']);

    // The refused activation changed nothing: SF1 keeps its ACTIVE version.
    const [sf1] = (await db.query('SELECT status FROM boms WHERE tenant_id = ? AND id = ?', [tenantA, SF1V1])) as { status: string }[];
    const [sf2] = (await db.query('SELECT status FROM boms WHERE tenant_id = ? AND id = ?', [tenantA, SF1V2])) as { status: string }[];
    expect([sf1.status, sf2.status]).toEqual(['ACTIVE', 'DRAFT']);
  });

  it('deactivate needs an active version; the list pages and filters by item and status', async () => {
    expect(err(await post(ownerA, `boms/${SF1V2}/deactivate`))).toEqual([409, 'BOM_NOT_ACTIVE']);
    const list = await get(ownerA, `boms?itemId=${M1}`);
    expect(list.status).toBe(200);
    expect(list.body.items.every((b: { itemId: string }) => b.itemId === M1)).toBe(true);
    const active = await get(ownerA, `boms?itemId=${M1}&status=ACTIVE`);
    expect(active.body.items.map((b: { id: string }) => b.id)).toEqual([M1V1]);
    expect(active.body.items[0].lineCount).toBe(2);
  });

  // ---------------------------------------------------------- requirements

  it('requirements: the ratio, the waste percentage, one level only (a manufactured component is not exploded)', async () => {
    const r = await get(ownerA, `boms/${M1V1}/requirements?qty=20`);
    expect(r.status).toBe(200);
    expect([d(r.body.qtyBase).toString(), d(r.body.outputQtyBase).toString()]).toEqual(['20', '10']);
    const [sf, raw] = r.body.lines;
    expect(sf.componentItemId).toBe(SF1);
    expect(d(sf.requiredQtyBase).toString()).toBe('2');
    expect(raw.componentItemId).toBe(R1);
    expect(d(raw.requiredQtyBase).toString()).toBe('75.6'); // 36 x (20 / 10) x 1.05
    expect(r.body.lines).toHaveLength(2);

    const sfReq = await get(ownerA, `boms/${SF1V1}/requirements?qty=10`);
    expect(d(sfReq.body.lines[0].requiredQtyBase).toString()).toBe('5');
    expect(err(await get(ownerA, `boms/${M1V1}/requirements?qty=0`))).toEqual([400, 'VALIDATION']);
  });

  // ------------------------------------------------- manufactured as stock

  it('a manufactured item behaves as stock: a purchase brings it in, a sale takes it out at its cost, a count includes it', async () => {
    const bought = await createAndPost('purchase-invoices', {
      invoiceDate: `${Y}-03-02`,
      supplierId: supplier,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: SF1, qty: '10', unitCost: '5.000' }],
    });
    expect(bought.posted.status).toBe(201);
    expect(await stockOf(SF1, W1)).toBe('10');

    const sold = await createAndPost('sales-invoices', {
      invoiceDate: `${Y}-03-03`,
      customerId: customer,
      warehouseId: W1,
      paymentType: 'CREDIT',
      lines: [{ itemId: SF1, qty: '4', unitPrice: '8.000' }],
    });
    expect(sold.posted.status).toBe(201);
    expect(d(sold.posted.body.costTotal).toString()).toBe('20');
    expect(await stockOf(SF1, W1)).toBe('6');

    const count = await post(ownerA, 'stock-counts', { countDate: `${Y}-03-10`, warehouseId: W1, scope: 'WAREHOUSE' });
    expect(count.status).toBe(201);
    expect(count.body.lines.some((l: { itemId: string }) => l.itemId === SF1)).toBe(true);
  });

  // -------------------------------------------------------- tenant and output

  it('PDF 200; tenant B gets 404 on every route, and sees no list rows', async () => {
    const pdf = await api().get(`/api/v1/boms/${M1V1}/pdf`).set(auth(ownerA)).buffer(true).parse(binary);
    expect([pdf.status, pdf.headers['content-type']]).toEqual([200, 'application/pdf']);

    expect(err(await get(ownerB, `boms/${M1V1}`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await get(ownerB, `boms/${M1V1}/requirements?qty=1`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await post(ownerB, `boms/${M1V1}/activate`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await api().delete(`/api/v1/boms/${SF1V2}`).set(auth(ownerB)))).toEqual([404, 'NOT_FOUND']);
    expect(err(await get(ownerB, `boms/${M1V1}/pdf`))).toEqual([404, 'NOT_FOUND']);
    expect((await get(ownerB, 'boms')).body.items).toEqual([]);
  });

  it('stock:verify clean, trial balance balanced, and the OpenAPI response audit empty', async () => {
    const v = await get(ownerA, 'stock/verify');
    expect(v.status).toBe(200);
    expect(v.body.mismatches).toEqual([]);
    const tb = await get(ownerA, 'reports/trial-balance');
    expect(tb.body.balanced).toBe(true);
    const audit = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    expect(audit).toBe('');
  });
});
