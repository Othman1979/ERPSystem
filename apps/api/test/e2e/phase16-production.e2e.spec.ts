/**
 * Phase 16 part B — production vouchers (ADR-031 §3, §4, §6, §7, §9, §10, §11):
 *  - drafts: create (actual lines, or the standards when none are sent), update, delete;
 *    numbering only at posting; a posted voucher is neither changed nor deleted;
 *  - versions: a DRAFT version refused (BOM_NOT_ACTIVE), no active version refused,
 *    an INACTIVE version used only when named, a later version does not change a posted voucher;
 *  - posting: idempotent replay of post and reverse under one Idempotency-Key;
 *  - components: refused without allow_negative_stock and allowed with it; two concurrent
 *    postings on the last quantity of a component (exactly one posts);
 *  - reversal: refused for a voucher whose output is gone; allowed when it is still there;
 *  - tenant B 404, branch scope (a storekeeper of MAIN), the `stocked=true` items filter,
 *    stock:verify clean, trial balance balanced, the OpenAPI response audit empty and the
 *    integrity check passing.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 *
 * Stock numbers (R 100 bought @ 1.000; M = 1 unit from R 2 + applied 0.500; N 5 bought @ 2.000;
 * MN = 1 unit from N 1, no applied cost) are checked as they change; see each test.
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { addMember } from './support/members.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';
import { testDatabaseUrl } from './support/test-db.js';

const RUN = Date.now().toString(36);
const T = 60_000;
const Y = new Date().getUTCFullYear();
const AUDIT_FILE = path.join(os.tmpdir(), `p16b-audit-${RUN}.jsonl`);
const API_DIR = path.resolve(import.meta.dirname, '..', '..');

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3739, AUDIT_FILE);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
  rmSync(AUDIT_FILE, { force: true });
});

const q6 = (v: unknown) => new Decimal(String(v)).toFixed(6);

describe('Phase 16 — production vouchers (ADR-031, part B)', () => {
  let ownerA = '';
  let ownerB = '';
  let storekeeper = '';
  let tenantA = '';
  let companyA = '';
  let W1 = '';
  let W2 = '';
  let MAIN = '';
  let B2 = '';
  let R = '';
  let R2 = '';
  let SV = '';
  let M = '';
  let M2 = '';
  let M3 = '';
  let N = '';
  let MN = '';
  let M1V1 = '';
  let M1V2 = '';
  let DV1 = '';
  let DV1Post = '';
  let DCA = '';
  let DCB = '';
  let TODAY = '';

  const get = (token: string, p: string) => h.get(token, p);
  const act = (token: string, p: string, body: object = {}, key?: string) => h.act(token, p, body, key);
  const err = (res: request.Response) => h.err(res);
  const stock = async (itemId: string, warehouseId = W1): Promise<string> => {
    const [row] = (await boot.db.query('SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?', [
      tenantA,
      itemId,
      warehouseId,
    ])) as { q: string }[];
    return q6(row?.q ?? 0);
  };
  const journalCount = async (sourceId: string) => {
    const [row] = (await boot.db.query("SELECT COUNT(*) AS n FROM journal_entries WHERE tenant_id = ? AND source_type = 'PRODUCTION' AND source_id = ?", [
      tenantA,
      sourceId,
    ])) as { n: bigint }[];
    return Number(row.n);
  };
  async function verified(token: string) {
    const verify = await get(token, 'stock/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await get(token, 'reports/trial-balance');
    expect(tb.body.balanced).toBe(true);
  }

  it('setup: tenants A and B, branches MAIN and B2, warehouses W1 and W2 (on B2), items, purchases', async () => {
    for (const tag of ['a', 'b']) {
      const res = await h
        .api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `P16B ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p16b-${tag}-${RUN}@test.dev`, password: PASS });
      expect(res.status).toBe(201);
      if (tag === 'a') ownerA = res.body.accessToken;
      else ownerB = res.body.accessToken;
    }
    await boot.db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P16B % ${RUN}`]);
    const [ta] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`P16B a ${RUN}`])) as { id: bigint }[];
    tenantA = String(ta.id);
    const [co] = (await boot.db.query('SELECT id FROM companies WHERE tenant_id = ? AND is_active = 1', [tenantA])) as { id: bigint }[];
    companyA = String(co.id);
    const [main] = (await boot.db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantA])) as { id: bigint }[];
    MAIN = String(main.id);
    const now = new Date();
    const ins = (await boot.db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantA, companyA, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    B2 = String(ins.insertId);

    for (const token of [ownerA, ownerB]) {
      expect((await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` })).status).toBe(201);
    }
    W1 = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(ownerA)).send({ code: 'W1', nameAr: 'مستودع 1' }), 201, 'W1').id;
    W2 = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(ownerA)).send({ code: 'W2', nameAr: 'مستودع 2' }), 201, 'W2').id;
    await boot.db.query('UPDATE warehouses SET branch_id = ? WHERE tenant_id = ? AND id = ?', [B2, tenantA, W2]);

    const units = (await get(ownerA, 'units')).body as { id: string; code: string }[];
    const pcs = units.find((u) => u.code === 'PCS')!.id;
    const standard = ((await get(ownerA, 'tax-categories')).body as { id: string; code: string }[]).find((x) => x.code === 'STANDARD')!.id;
    const mk = async (code: string, extra: object = {}) =>
      h.ok(await h.api().post('/api/v1/items').set(h.auth(ownerA)).send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: standard, ...extra }), 201, `item ${code}`)
        .id as string;
    R = await mk('B-R');
    R2 = await mk('B-R2');
    SV = await mk('B-SV', { itemKind: 'SERVICE' });
    M = await mk('B-M', { itemKind: 'MANUFACTURED' });
    M2 = await mk('B-M2', { itemKind: 'MANUFACTURED' });
    M3 = await mk('B-M3', { itemKind: 'MANUFACTURED' });
    N = await mk('B-N');
    MN = await mk('B-MN', { itemKind: 'MANUFACTURED' });

    const supplier = h.ok(await h.api().post('/api/v1/parties').set(h.auth(ownerA)).send({ code: 'BS', nameAr: 'مورد', partyType: 'SUPPLIER' }), 201, 'supplier').id;
    const bought = h.ok(
      await h.api().post('/api/v1/purchase-invoices').set(h.auth(ownerA)).send({
        invoiceDate: `${Y}-01-02`,
        supplierId: supplier,
        warehouseId: W1,
        paymentType: 'CREDIT',
        lines: [
          { itemId: R, qty: '100', unitCost: '1' },
          { itemId: R2, qty: '10', unitCost: '3' },
          { itemId: N, qty: '5', unitCost: '2' },
        ],
      }),
      201,
      'purchase',
    );
    h.ok(await act(ownerA, `purchase-invoices/${bought.id}/post`), 201, 'post purchase');

    // M: 1 unit from R 2, applied 0.500 (version 1, activated). M2: a draft version only. MN: 1 unit from N 1.
    M1V1 = h.ok(
      await h.api().post('/api/v1/boms').set(h.auth(ownerA)).send({ itemId: M, outputQty: '1', appliedCostPerUnit: '0.500', lines: [{ componentItemId: R, qty: '2' }] }),
      201,
      'bom M',
    ).id;
    h.ok(await act(ownerA, `boms/${M1V1}/activate`), 201, 'activate M');
    h.ok(await h.api().post('/api/v1/boms').set(h.auth(ownerA)).send({ itemId: M2, outputQty: '1', lines: [{ componentItemId: R, qty: '1' }] }), 201, 'draft M2');
    const mn = h.ok(await h.api().post('/api/v1/boms').set(h.auth(ownerA)).send({ itemId: MN, outputQty: '1', lines: [{ componentItemId: N, qty: '1' }] }), 201, 'bom MN');
    h.ok(await act(ownerA, `boms/${mn.id}/activate`), 201, 'activate MN');

    // The storekeeper of MAIN only (STOREKEEPER: stock movement and tenant read).
    storekeeper = (
      await addMember(boot.base, ownerA, {
        email: `p16b-store-${RUN}@test.dev`,
        roleCode: 'STOREKEEPER',
        password: PASS,
        defaultBranchId: MAIN,
        branchIds: [MAIN],
      })
    ).token;
  });

  // ----------------------------------------------------------- drafts

  it('draft: create with actual lines (R 25 against a standard of 20; R2 is not in the BOM: standard 0); no number, no movement', async () => {
    const res = await act(ownerA, 'production-vouchers', {
      itemId: M,
      qty: '10',
      materialsWarehouseId: W1,
      voucherDate: `${Y}-01-03`,
      lines: [
        { itemId: R, qty: '25' },
        { itemId: R2, qty: '1' },
      ],
    });
    expect(res.status).toBe(201);
    expect([res.body.status, res.body.docNo]).toEqual(['DRAFT', null]);
    expect(res.body.bom).toMatchObject({ id: M1V1, versionNo: 1, status: 'ACTIVE' });
    const lines = res.body.lines as { itemId: string; qtyBase: string; standardQtyBase: string; shortage: { availableQtyBase: string; shortageQtyBase: string } | null }[];
    expect(lines.map((l) => [q6(l.qtyBase), q6(l.standardQtyBase)])).toEqual([
      [q6(25), q6(20)],
      [q6(1), q6(0)],
    ]);
    expect(lines[0].shortage).toMatchObject({ availableQtyBase: q6(100), shortageQtyBase: q6(0) });
    DV1 = res.body.id;
    expect(await stock(R)).toBe(q6(100));
  });

  it('draft: update replaces the lines; without lines the standards of the new quantity come back (R 2 × 4 = 8)', async () => {
    const put = await h.api().put(`/api/v1/production-vouchers/${DV1}`).set(h.auth(ownerA)).send({ qty: '4', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` });
    expect(put.status).toBe(200);
    expect(put.body.lines.map((l: { itemId: string }) => l.itemId)).toEqual([R]);
    expect([q6(put.body.qtyBase), q6(put.body.lines[0].qtyBase), q6(put.body.lines[0].standardQtyBase)]).toEqual([q6(4), q6(8), q6(8)]);
  });

  it('draft: delete a draft; a deleted voucher is not found', async () => {
    const draft = h.ok(await act(ownerA, 'production-vouchers', { itemId: M, qty: '2', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` }), 201, 'draft to delete');
    expect(h.ok(await h.api().delete(`/api/v1/production-vouchers/${draft.id}`).set(h.auth(ownerA)), 200, 'delete')).toEqual({ deleted: true });
    expect(err(await get(ownerA, `production-vouchers/${draft.id}`))).toEqual([404, 'NOT_FOUND']);
  });

  it('refused: a draft version (BOM_NOT_ACTIVE), an item with no version (BOM_NOT_ACTIVE), a non-manufactured item (BOM_ITEM_NOT_MANUFACTURED)', async () => {
    expect(err(await act(ownerA, 'production-vouchers', { itemId: M2, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` }))).toEqual([409, 'BOM_NOT_ACTIVE']);
    const draftVersion = (await get(ownerA, `boms?itemId=${M2}`)).body.items[0].id as string;
    expect(err(await act(ownerA, 'production-vouchers', { itemId: M2, bomId: draftVersion, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` }))).toEqual([
      409,
      'BOM_NOT_ACTIVE',
    ]);
    expect(err(await act(ownerA, 'production-vouchers', { itemId: M3, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` }))).toEqual([409, 'BOM_NOT_ACTIVE']);
    expect(err(await act(ownerA, 'production-vouchers', { itemId: R, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-03` }))).toEqual([
      400,
      'BOM_ITEM_NOT_MANUFACTURED',
    ]);
    expect(err(await act(ownerA, 'production-vouchers', { itemId: M, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-03`, lines: [{ itemId: SV, qty: '1' }] }))).toEqual([
      400,
      'VALIDATION',
    ]);
  });

  // ------------------------------------------------------- posting

  it('post: the number is given at posting; materials 8.000 + applied 2.000 = output 10.000 (unit 2.500); the same key replays the answer', async () => {
    const draft = h.ok(await act(ownerA, 'production-vouchers', { itemId: M, qty: '4', materialsWarehouseId: W1, voucherDate: `${Y}-01-04` }), 201, 'draft DV1 (4)');
    DV1Post = draft.id;
    const key = `p16b-post-${RUN}`;
    const first = await act(ownerA, `production-vouchers/${DV1Post}/post`, {}, key);
    expect(first.status).toBe(201);
    expect([first.body.status, first.body.docNo]).toEqual(['POSTED', expect.stringMatching(/^MFG-/)]);
    expect([m3(first.body.materialsTotal), m3(first.body.appliedTotal), m3(first.body.outputTotal)]).toEqual(['8.000', '2.000', '10.000']);
    expect(await stock(R)).toBe(q6(92));
    expect(await stock(M)).toBe(q6(4));

    const replay = await act(ownerA, `production-vouchers/${DV1Post}/post`, {}, key);
    expect([replay.status, replay.body.docNo]).toEqual([201, first.body.docNo]);
    expect(await journalCount(DV1Post)).toBe(1);
    expect(await stock(R)).toBe(q6(92));
  });

  it('posted vouchers are neither changed nor deleted, nor posted again', async () => {
    expect(err(await h.api().put(`/api/v1/production-vouchers/${DV1Post}`).set(h.auth(ownerA)).send({ qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-04` }))).toEqual([
      409,
      'PRODUCTION_NOT_DRAFT',
    ]);
    expect(err(await h.api().delete(`/api/v1/production-vouchers/${DV1Post}`).set(h.auth(ownerA)))).toEqual([409, 'PRODUCTION_NOT_DRAFT']);
    expect(err(await act(ownerA, `production-vouchers/${DV1Post}/post`))).toEqual([409, 'PRODUCTION_NOT_DRAFT']);
  });

  it('a later version does not change a posted voucher: copy, change the applied cost to 9.000, activate; the voucher keeps 0.500', async () => {
    const copy = h.ok(await act(ownerA, `boms/${M1V1}/copy`), 201, 'copy M');
    M1V2 = copy.id;
    h.ok(
      await h.api().put(`/api/v1/boms/${M1V2}`).set(h.auth(ownerA)).send({ outputQty: '1', appliedCostPerUnit: '9.000', lines: [{ componentItemId: R, qty: '2' }] }),
      200,
      'edit copy',
    );
    h.ok(await act(ownerA, `boms/${M1V2}/activate`), 201, 'activate copy');
    const voucher = h.ok(await get(ownerA, `production-vouchers/${DV1Post}`), 200, 'voucher');
    expect([m3(voucher.appliedCostPerUnit), m3(voucher.appliedTotal)]).toEqual(['0.500', '2.000']);
    // The explicit INACTIVE version (v1) is still usable by name, and only by name.
    const byName = await act(ownerA, 'production-vouchers', { itemId: M, bomId: M1V1, qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-05` });
    expect([byName.status, byName.body.bom?.status]).toEqual([201, 'INACTIVE']);
  });

  // ------------------------------------------------------ reversal

  it('reverse: the same key replays the reversal; one reversal row; stock and journal back to before', async () => {
    const key = `p16b-rev-${RUN}`;
    const first = await act(ownerA, `production-vouchers/${DV1Post}/reverse`, {}, key);
    expect(first.status).toBe(201);
    expect([first.body.reversalOfId, first.body.status]).toEqual([DV1Post, 'POSTED']);
    // The reversal is dated today (company zone): later movements of these items fall on or after it.
    TODAY = String(first.body.voucherDate).slice(0, 10);
    const replay = await act(ownerA, `production-vouchers/${DV1Post}/reverse`, {}, key);
    expect(replay.body.id).toBe(first.body.id);
    const [count] = (await boot.db.query('SELECT COUNT(*) AS n FROM production_vouchers WHERE tenant_id = ? AND reversal_of_id = ?', [tenantA, DV1Post])) as {
      n: bigint;
    }[];
    expect(Number(count.n)).toBe(1);
    expect(await stock(R)).toBe(q6(100));
    expect(await stock(M)).toBe(q6(0));
    await verified(ownerA);
  });

  // ---------------------------------------------- negative components

  it('a component short of stock is refused without allow_negative_stock, and allowed with it; the output reversal then works', async () => {
    // MN needs 1 N per unit: 6 units need 6 N, and only 5 are on hand.
    const short = h.ok(await act(ownerA, 'production-vouchers', { itemId: MN, qty: '6', materialsWarehouseId: W1, voucherDate: `${Y}-01-06` }), 201, 'draft MN 6');
    expect(err(await act(ownerA, `production-vouchers/${short.id}/post`))).toEqual([409, 'STOCK_INSUFFICIENT']);
    expect(await stock(N)).toBe(q6(5));

    await boot.db.query('UPDATE companies SET allow_negative_stock = 1 WHERE tenant_id = ?', [tenantA]);
    let posted;
    try {
      posted = await act(ownerA, `production-vouchers/${short.id}/post`);
    } finally {
      await boot.db.query('UPDATE companies SET allow_negative_stock = 0 WHERE tenant_id = ?', [tenantA]);
    }
    expect(posted.status).toBe(201);
    expect(await stock(N)).toBe(q6(-1));

    const reversed = await act(ownerA, `production-vouchers/${short.id}/reverse`);
    expect(reversed.status).toBe(201);
    expect(await stock(N)).toBe(q6(5));
    expect(await stock(MN)).toBe(q6(0));
    await verified(ownerA);
  });

  // ------------------------------------------------------ concurrency

  it('two concurrent postings on the last quantity of a component: exactly one posts without negative stock', async () => {
    // R on hand 100; each voucher takes 2 × 30 = 60 R. Only one can post.
    DCA = h.ok(await act(ownerA, 'production-vouchers', { itemId: M, qty: '30', materialsWarehouseId: W1, voucherDate: TODAY }), 201, 'DCA').id;
    DCB = h.ok(await act(ownerA, 'production-vouchers', { itemId: M, qty: '30', materialsWarehouseId: W1, voucherDate: TODAY }), 201, 'DCB').id;
    expect(await stock(R)).toBe(q6(100));
    const [a, b] = await Promise.all([act(ownerA, `production-vouchers/${DCA}/post`), act(ownerA, `production-vouchers/${DCB}/post`)]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([201, 409]);
    const failed = a.status === 409 ? a : b;
    expect(failed.body.error.code).toBe('STOCK_INSUFFICIENT');
    expect(await stock(R)).toBe(q6(40));
    await verified(ownerA);
  });

  // -------------------------------------------------- tenant B and branches

  it('tenant B: 404 on every production voucher route, and its list is empty', async () => {
    expect(err(await get(ownerB, `production-vouchers/${DCA}`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await act(ownerB, `production-vouchers/${DCB}/post`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await act(ownerB, `production-vouchers/${DCB}/reverse`))).toEqual([404, 'NOT_FOUND']);
    expect(err(await h.api().put(`/api/v1/production-vouchers/${DCB}`).set(h.auth(ownerB)).send({ qty: '1', materialsWarehouseId: W1, voucherDate: `${Y}-01-07` }))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    expect(err(await h.api().delete(`/api/v1/production-vouchers/${DCB}`).set(h.auth(ownerB)))).toEqual([404, 'NOT_FOUND']);
    expect((await get(ownerB, 'production-vouchers')).body.total).toBe(0);
  });

  it('branch scope: a storekeeper of MAIN does not see a voucher of W2 (on B2), and cannot create or post one', async () => {
    const onB2 = h.ok(await act(ownerA, 'production-vouchers', { itemId: MN, qty: '1', materialsWarehouseId: W2, voucherDate: `${Y}-01-08` }), 201, 'voucher on W2');
    expect(err(await get(storekeeper, `production-vouchers/${onB2.id}`))).toEqual([404, 'NOT_FOUND']);
    const listed = (await get(storekeeper, 'production-vouchers?pageSize=100')).body.items as { id: string }[];
    expect(listed.map((v) => v.id)).not.toContain(onB2.id);
    expect(err(await act(storekeeper, `production-vouchers/${onB2.id}/post`))).toEqual([403, 'BRANCH_NOT_ALLOWED']);
    expect(err(await act(storekeeper, 'production-vouchers', { itemId: MN, qty: '1', materialsWarehouseId: W2, voucherDate: `${Y}-01-08` }))).toEqual([
      403,
      'BRANCH_NOT_ALLOWED',
    ]);
  });

  // ------------------------------------------------------- items filter

  it('items: stocked=true lists the STOCK and MANUFACTURED items and no service; with a SERVICE kind it is empty', async () => {
    const all = (await get(ownerA, 'items?pageSize=100&stocked=true')).body.items as { id: string; itemKind: string }[];
    const ids = all.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([R, N, M, MN]));
    expect(ids).not.toContain(SV);
    expect(all.every((i) => i.itemKind !== 'SERVICE')).toBe(true);
    expect((await get(ownerA, 'items?stocked=true&itemKind=SERVICE')).body.total).toBe(0);
    expect((await get(ownerA, 'items?itemKind=SERVICE&pageSize=100')).body.items.map((i: { id: string }) => i.id)).toContain(SV);
  });

  // ------------------------------------------------------ closing checks

  it('closing: the OpenAPI response audit is empty, the integrity check passes, stock:verify is clean', async () => {
    await verified(ownerA);
    expect(existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8') : '').toBe('');
    const { stdout } = await promisify(execFile)('node', ['dist/jobs/cli.js', 'integrity-check', '--tenant', tenantA], {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(), NODE_ENV: 'test' },
    });
    const report = JSON.parse(stdout) as { ok: boolean };
    expect(report.ok).toBe(true);
  }, T);
});
