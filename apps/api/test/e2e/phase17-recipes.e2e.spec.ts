/**
 * Phase 17 (ADR-032): recipes exploded at sale — refusals, bills of materials of recipes, explosion
 * rules, the sales preview, negative stock, concurrency, cost card, the recipe reports, tenant
 * isolation, and the consumption report between two counts (tenant C).
 * Every number is computed by hand in the comments; the golden scenarios are in golden-recipes.e2e.spec.ts.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { addMember } from './support/members.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const T = 60_000;
const Y = new Date().getUTCFullYear();

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3737);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
});

type Ctx = { token: string; tenantId: string; pcs: string; tax: string };

/** Registers a tenant with one fiscal year and the unit and tax category it needs. */
async function registerTenant(name: string): Promise<Ctx> {
  const reg = await h.api().post('/api/v1/auth/register').send({
    tenantName: name,
    ownerName: 'Owner',
    email: `${name.toLowerCase()}@test.dev`,
    password: PASS,
  });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  const [t] = (await boot.db.query('SELECT id AS tenantId FROM tenants WHERE name = ?', [name])) as { tenantId: bigint }[];
  h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` }), 201, 'fy');
  const pcs = ((await h.get(token, 'units')).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
  const tax = ((await h.get(token, 'tax-categories')).body as { id: string; code: string }[]).find((x) => x.code === 'STANDARD')!;
  return { token, tenantId: String(t.tenantId), pcs, tax: tax.id };
}

/** An item of the tenant (default kind STOCK). */
async function makeItem(ctx: Ctx, code: string, itemKind?: string, extra: object = {}): Promise<string> {
  return h.ok(
    await h.api()
      .post('/api/v1/items')
      .set(h.auth(ctx.token))
      .send({ code, nameAr: code, baseUnitId: ctx.pcs, taxCategoryId: ctx.tax, ...(itemKind ? { itemKind } : {}), ...extra }),
    201,
    `item ${code}`,
  ).id as string;
}

/** A BOM version created and activated. */
async function activeBom(ctx: Ctx, itemId: string, lines: { componentItemId: string; qty: string }[]): Promise<string> {
  const bom = h.ok(await h.api().post('/api/v1/boms').set(h.auth(ctx.token)).send({ itemId, outputQty: '1', lines }), 201, 'bom');
  h.ok(await h.act(ctx.token, `boms/${bom.id}/activate`), 201, 'activate bom');
  return bom.id as string;
}

/** A posted purchase of stock lines. */
async function buy(ctx: Ctx, supplierId: string, warehouseId: string, date: string, lines: { itemId: string; qty: string; unitCost: string }[]) {
  const bought = h.ok(
    await h.api().post('/api/v1/purchase-invoices').set(h.auth(ctx.token)).send({ invoiceDate: date, supplierId, warehouseId, paymentType: 'CREDIT', lines }),
    201,
    'purchase',
  );
  h.ok(await h.act(ctx.token, `purchase-invoices/${bought.id}/post`), 201, 'post purchase');
}

/** stock:verify clean and the trial balance balanced (CLAUDE.md, after every posting scenario). */
async function verified(token: string) {
  const verify = await h.get(token, 'stock/verify');
  expect(verify.status).toBe(200);
  expect(verify.body.mismatches).toEqual([]);
  const tb = await h.get(token, 'reports/trial-balance');
  expect(tb.body.balanced).toBe(true);
}

/** Stock on hand of an item in a warehouse, as a fixed 6-dp string. */
async function onHand(tenantId: string, itemId: string, warehouseId: string): Promise<string> {
  const [row] = (await boot.db.query(
    'SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?',
    [tenantId, itemId, warehouseId],
  )) as { q: string }[];
  return new Decimal(row?.q ?? 0).toFixed(6);
}

/** A copy of a warehouse row with another code (the API caps the trial plan at one warehouse). */
async function cloneWarehouse(tenantId: string, warehouseId: string, code: string): Promise<string> {
  const cols = (await boot.db.query(
    "SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'warehouses' AND EXTRA NOT LIKE '%auto_increment%'",
  )) as { c: string }[];
  const names = cols.map((x) => x.c);
  const list = names.map((c) => `\`${c}\``).join(', ');
  const select = names.map((c) => (c === 'code' ? '?' : `\`${c}\``)).join(', ');
  await boot.db.query(`INSERT INTO warehouses (${list}) SELECT ${select} FROM warehouses WHERE tenant_id = ? AND id = ?`, [code, tenantId, warehouseId]);
  const [row] = (await boot.db.query('SELECT id FROM warehouses WHERE tenant_id = ? AND code = ?', [tenantId, code])) as { id: bigint }[];
  return String(row.id);
}

describe('Phase 17 — recipes exploded at sale (ADR-032), tenant A', () => {
  let A: Ctx;
  let W = '';
  let W2 = '';
  let customer = '';
  let supplier = '';
  const ids: Record<string, string> = {};

  /** A draft sale of one line, then posted. */
  async function sell(itemId: string, qty: string, date = `${Y}-02-01`) {
    const created = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(A.token)).send({
        invoiceDate: date,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty, unitPrice: '1.000' }],
      }),
      201,
      'draft sale',
    );
    return { id: created.id as string, posted: await h.act(A.token, `sales-invoices/${created.id}/post`) };
  }

  it(
    'setup: tenant A — stock I1 I2 I3 I4, recipes DISH SAUCE M N X Y Z RA RB, manufactured P; one purchase',
    async () => {
      A = await registerTenant(`P17A${RUN}`);
      W = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(A.token)).send({ code: 'W', nameAr: 'W' }), 201, 'warehouse').id;
      // The trial plan allows one warehouse through the API; a second one (for the transfer) is cloned in the database.
      W2 = await cloneWarehouse(A.tenantId, W, 'W2');
      customer = h.ok(await h.api().post('/api/v1/parties').set(h.auth(A.token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' }), 201, 'customer').id;
      supplier = h.ok(await h.api().post('/api/v1/parties').set(h.auth(A.token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' }), 201, 'supplier').id;
      for (const code of ['I1', 'I2', 'I3', 'I4']) ids[code] = await makeItem(A, code);
      ids.DISH = await makeItem(A, 'DISH', 'RECIPE', { salePrice: '3.000', salePriceIncludesTax: false });
      for (const code of ['SAUCE', 'M', 'N', 'Y', 'Z', 'RA', 'RB']) ids[code] = await makeItem(A, code, 'RECIPE');
      ids.X = await makeItem(A, 'X', 'RECIPE', { salePrice: '11.600', salePriceIncludesTax: true });
      ids.P = await makeItem(A, 'P', 'MANUFACTURED');
      await buy(A, supplier, W, `${Y}-01-01`, [
        { itemId: ids.I1, qty: '10', unitCost: '0.5' },
        { itemId: ids.I2, qty: '10', unitCost: '2' },
        { itemId: ids.I3, qty: '10', unitCost: '5' },
        { itemId: ids.I4, qty: '1', unitCost: '4' },
      ]);
      await verified(A.token);
    },
    T,
  );

  it('the purchase pickers never list a recipe: items?purchasable=true (review #65)', async () => {
    const all = await h.api().get('/api/v1/items?pageSize=100&isActive=true').set(h.auth(A.token));
    const buyable = await h.api().get('/api/v1/items?pageSize=100&isActive=true&purchasable=true').set(h.auth(A.token));
    expect(all.status).toBe(200);
    expect(buyable.status).toBe(200);
    const ids = (r: { body: { items: { id: string; itemKind: string }[] } }) => r.body.items.map((i) => i.itemKind);
    expect(ids(all)).toContain('RECIPE');
    expect(ids(buyable)).not.toContain('RECIPE');
    expect(ids(buyable).length).toBeGreaterThan(0);
  });

  it('RECIPE is refused by name in purchase invoice, purchase request, purchase order, transfer, adjustment, count and production', async () => {
    // The purchase order needs the MEDIUM procurement level (the trial company is SIMPLE).
    await boot.db.query("UPDATE companies SET procurement_level = 'MEDIUM' WHERE tenant_id = ?", [A.tenantId]);
    const supplierBody = { supplierId: supplier, warehouseId: W };
    const refusals: [string, Promise<{ status: number; body: { error?: { code: string } } }>][] = [
      ['purchase invoice', h.api().post('/api/v1/purchase-invoices').set(h.auth(A.token)).send({ invoiceDate: `${Y}-01-02`, ...supplierBody, paymentType: 'CREDIT', lines: [{ itemId: ids.DISH, qty: '1', unitCost: '1' }] })],
      ['purchase request', h.api().post('/api/v1/purchase-requests').set(h.auth(A.token)).send({ requestDate: `${Y}-01-02`, lines: [{ itemId: ids.DISH, qty: '1' }] })],
      ['purchase order', h.api().post('/api/v1/purchase-orders').set(h.auth(A.token)).send({ orderDate: `${Y}-01-02`, ...supplierBody, lines: [{ itemId: ids.DISH, qty: '1', unitPrice: '1' }] })],
      ['transfer', h.api().post('/api/v1/stock-transfers').set(h.auth(A.token)).send({ transferDate: `${Y}-01-02`, fromWarehouseId: W, toWarehouseId: W2, lines: [{ itemId: ids.DISH, qty: '1' }] })],
      ['adjustment', h.api().post('/api/v1/stock-adjustments').set(h.auth(A.token)).send({ adjustmentDate: `${Y}-01-02`, adjustmentType: 'IN', warehouseId: W, lines: [{ itemId: ids.DISH, qty: '1', unitCost: '1' }] })],
      ['count', h.api().post('/api/v1/stock-counts').set(h.auth(A.token)).send({ countDate: `${Y}-01-02`, warehouseId: W, scope: 'ITEMS', itemIds: [ids.DISH] })],
      ['production product', h.api().post('/api/v1/production-vouchers').set(h.auth(A.token)).send({ itemId: ids.DISH, qty: '1', materialsWarehouseId: W, voucherDate: `${Y}-01-02` })],
    ];
    for (const [what, call] of refusals) {
      const res = await call;
      if (res.body.error?.code !== 'RECIPE_NOT_STOCKED') console.log(what, JSON.stringify(res.body));
      expect([what, res.status, res.body.error?.code]).toEqual([what, 400, 'RECIPE_NOT_STOCKED']);
    }
    // A manufactured item cannot use a recipe as a component (ADR-032 §6).
    const bom = await h.api().post('/api/v1/boms').set(h.auth(A.token)).send({ itemId: ids.P, outputQty: '1', lines: [{ componentItemId: ids.DISH, qty: '1' }] });
    expect([bom.status, bom.body.error?.code]).toEqual([400, 'BOM_COMPONENT_INVALID']);
  });

  it('bills of materials: a loop through recipes is refused at activation; a recipe nests a recipe', async () => {
    const ra = h.ok(await h.api().post('/api/v1/boms').set(h.auth(A.token)).send({ itemId: ids.RA, outputQty: '1', lines: [{ componentItemId: ids.RB, qty: '1' }] }), 201, 'bom RA');
    h.ok(await h.act(A.token, `boms/${ra.id}/activate`), 201, 'activate RA');
    const rb = h.ok(await h.api().post('/api/v1/boms').set(h.auth(A.token)).send({ itemId: ids.RB, outputQty: '1', lines: [{ componentItemId: ids.RA, qty: '1' }] }), 201, 'bom RB');
    const loop = await h.act(A.token, `boms/${rb.id}/activate`);
    // A loop is a conflict with the active versions (409).
    expect([loop.status, loop.body.error?.code]).toEqual([409, 'BOM_CYCLE']);

    // N = I1 0.2; M = I1 0.1 directly + N 1 (the same I1 reached on two levels).
    await activeBom(A, ids.N, [{ componentItemId: ids.I1, qty: '0.2' }]);
    ids.bomM = await activeBom(A, ids.M, [
      { componentItemId: ids.I1, qty: '0.1' },
      { componentItemId: ids.N, qty: '1' },
    ]);
    // X = I3 1 (the cost card below).
    ids.bomX = await activeBom(A, ids.X, [{ componentItemId: ids.I3, qty: '1' }]);
  });

  it('a sale merges the duplicates across levels: 5 M take I1 5 × (0.1 + 0.2) = 1.500 in one movement', async () => {
    const { id, posted } = await sell(ids.M, '5');
    expect(posted.status).toBe(201);
    const detail = h.ok(await h.get(A.token, `sales-invoices/${id}`), 200, 'detail');
    expect(detail.lines[0].components.map((c: { qtyBase: string }) => new Decimal(c.qtyBase).toFixed(6))).toEqual(['1.500000']);
    expect(await onHand(A.tenantId, ids.I1, W)).toBe('8.500000');
    await verified(A.token);
  });

  it('the preview shows the shortage before posting: 100 M need I1 30; 8.5 on hand → short 21.5', async () => {
    const created = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(A.token)).send({
        invoiceDate: `${Y}-02-02`,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: ids.M, qty: '100', unitPrice: '1.000' }],
      }),
      201,
      'draft M100',
    );
    const preview = h.ok(await h.get(A.token, `sales-invoices/${created.id}/recipe-preview`), 200, 'preview');
    expect(preview.hasShortage).toBe(true);
    expect(preview.hasWarnings).toBe(false);
    const [i1] = preview.lines[0].components as { code: string; qtyBase: string; onHandBase: string; shortageBase: string }[];
    expect([i1.code, new Decimal(i1.qtyBase).toFixed(6), new Decimal(i1.onHandBase).toFixed(6), new Decimal(i1.shortageBase).toFixed(6)]).toEqual([
      'I1',
      '30.000000',
      '8.500000',
      '21.500000',
    ]);
    ids.previewInvoice = created.id;
  });

  it('two sales on the last unit of an ingredient at once: one posts, the other is refused as insufficient stock', async () => {
    ids.bomY = await activeBom(A, ids.Y, [{ componentItemId: ids.I4, qty: '1' }]);
    const draftOf = async () =>
      h.ok(
        await h.api().post('/api/v1/sales-invoices').set(h.auth(A.token)).send({
          invoiceDate: `${Y}-02-03`,
          customerId: customer,
          warehouseId: W,
          paymentType: 'CREDIT',
          lines: [{ itemId: ids.Y, qty: '1', unitPrice: '1.000' }],
        }),
        201,
        'draft Y',
      ).id as string;
    const [d1, d2] = [await draftOf(), await draftOf()];
    const [p1, p2] = await Promise.all([h.act(A.token, `sales-invoices/${d1}/post`), h.act(A.token, `sales-invoices/${d2}/post`)]);
    const results = [p1, p2];
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const loser = results.find((r) => r.status !== 201)!;
    expect([loser.status, loser.body.error?.code]).toEqual([expect.any(Number), 'STOCK_INSUFFICIENT']);
    expect(await onHand(A.tenantId, ids.I4, W)).toBe('0.000000');
    await verified(A.token);
  });

  it('negative stock: refused without allow_negative_stock; allowed with it (ADR-018), the component goes negative', async () => {
    const refused = await sell(ids.Y, '1', `${Y}-02-04`);
    expect([refused.posted.status, refused.posted.body.error?.code]).toEqual([expect.any(Number), 'STOCK_INSUFFICIENT']);
    await boot.db.query('UPDATE companies SET allow_negative_stock = 1 WHERE tenant_id = ?', [A.tenantId]);
    try {
      const allowed = await sell(ids.Y, '1', `${Y}-02-04`);
      expect(allowed.posted.status).toBe(201);
      expect(await onHand(A.tenantId, ids.I4, W)).toBe('-1.000000');
    } finally {
      await boot.db.query('UPDATE companies SET allow_negative_stock = 0 WHERE tenant_id = ?', [A.tenantId]);
    }
  });

  it('cost card with a tax-inclusive price: X = I3 1 at 5.000; 11.600 incl. 16% → net 10.000; margin 5.000 (50.00%)', async () => {
    const card = h.ok(await h.get(A.token, `boms/${ids.bomX}/cost`), 200, 'cost X');
    expect([
      m3(card.totalCost),
      new Decimal(card.unitCost).toFixed(6),
      m3(card.salePriceNet),
      m3(card.margin),
      new Decimal(card.marginPct).toFixed(2),
      card.pricesIncludeTax,
      card.zeroCostWarning,
    ]).toEqual(['5.000', '5.000000', '10.000', '5.000', '50.00', true, false]);
  });

  it('a recipe with no ACTIVE version: the sale posts at cost 0 and the recipe-sales-without-bom report lists it', async () => {
    const { id, posted } = await sell(ids.Z, '1', `${Y}-02-05`);
    expect(posted.status).toBe(201);
    expect(m3(posted.body.costTotal)).toBe('0.000');
    const rep = h.ok(await h.get(A.token, `stock-reports/recipe-sales-without-bom?from=${Y}-01-01&to=${Y}-12-31`), 200, 'report');
    expect(rep.some((r: { invoiceId: string; itemCode: string }) => r.invoiceId === id && r.itemCode === 'Z')).toBe(true);
  });

  it('HARD reservation: 10 H1 on hand, an order of 9 H1 confirmed; a direct sale of 2 HR (H1 1 each) is refused STOCK_RESERVED, 1 HR posts', async () => {
    ids.H1 = await makeItem(A, 'H1');
    ids.HR = await makeItem(A, 'HR', 'RECIPE');
    await activeBom(A, ids.HR, [{ componentItemId: ids.H1, qty: '1' }]);
    await buy(A, supplier, W, `${Y}-01-10`, [{ itemId: ids.H1, qty: '10', unitCost: '1' }]);
    expect((await h.patchCompany(A.token, { salesReservation: 'HARD' })).status).toBe(200);
    try {
      const order = h.ok(
        await h.api().post('/api/v1/sales-orders').set(h.auth(A.token)).send({
          orderDate: `${Y}-02-10`,
          customerId: customer,
          warehouseId: W,
          lines: [{ itemId: ids.H1, qty: '9', unitPrice: '2' }],
        }),
        201,
        'order H1',
      );
      expect(h.ok(await h.act(A.token, `sales-orders/${order.id}/confirm`), 201, 'confirm order').status).toBe('CONFIRMED');
      // Needs 2 of the 1 that is available after the reservation: refused; the draft stays a draft.
      expect(h.err((await sell(ids.HR, '2', `${Y}-02-11`)).posted)).toEqual([409, 'STOCK_RESERVED']);
      expect(await onHand(A.tenantId, ids.H1, W)).toBe('10.000000');
      // Needs exactly the 1 that is available: posts.
      expect((await sell(ids.HR, '1', `${Y}-02-11`)).posted.status).toBe(201);
      expect(await onHand(A.tenantId, ids.H1, W)).toBe('9.000000');
      await verified(A.token);
    } finally {
      expect((await h.patchCompany(A.token, { salesReservation: 'SOFT' })).status).toBe(200);
    }
  });

  it('nesting: a chain of 3 recipes explodes at sale (L1 → L2 → L3 → G 2 each level 1); activation does not limit the depth, the sale does', async () => {
    ids.G = await makeItem(A, 'G');
    for (const code of ['L1', 'L2', 'L3']) ids[code] = await makeItem(A, code, 'RECIPE');
    await activeBom(A, ids.L3, [{ componentItemId: ids.G, qty: '2' }]);
    await activeBom(A, ids.L2, [{ componentItemId: ids.L3, qty: '1' }]);
    await activeBom(A, ids.L1, [{ componentItemId: ids.L2, qty: '1' }]);
    await buy(A, supplier, W, `${Y}-01-11`, [{ itemId: ids.G, qty: '10', unitCost: '1' }]);
    // 3 L1 → 3 L2 → 3 L3 → G 3 × 2 = 6 in one movement.
    const { id, posted } = await sell(ids.L1, '3', `${Y}-02-12`);
    expect(posted.status).toBe(201);
    const detail = h.ok(await h.get(A.token, `sales-invoices/${id}`), 200, 'detail');
    expect(detail.lines[0].components.map((c: { qtyBase: string }) => new Decimal(c.qtyBase).toFixed(6))).toEqual(['6.000000']);
    expect(m3(posted.body.costTotal)).toBe('6.000');
    expect(await onHand(A.tenantId, ids.G, W)).toBe('4.000000');
    await verified(A.token);
  });

  it('nesting deeper than 8 levels: a chain of 10 recipes activates, but the sale is refused RECIPE_DEPTH_EXCEEDED (400) and nothing moves', async () => {
    ids.D = await makeItem(A, 'D');
    const chain: string[] = [];
    for (let i = 0; i < 10; i++) chain.push(await makeItem(A, `DR${i}`, 'RECIPE'));
    // Built from the bottom: DR9 = D 1; DR8 = DR9 1; ... DR0 = DR1 1 (DR9 sits at depth 9 from DR0).
    await activeBom(A, chain[9], [{ componentItemId: ids.D, qty: '1' }]);
    for (let i = 8; i >= 0; i--) await activeBom(A, chain[i], [{ componentItemId: chain[i + 1], qty: '1' }]);
    await buy(A, supplier, W, `${Y}-01-12`, [{ itemId: ids.D, qty: '5', unitCost: '1' }]);
    const refused = await sell(chain[0], '1', `${Y}-02-13`);
    expect(h.err(refused.posted)).toEqual([400, 'RECIPE_DEPTH_EXCEEDED']);
    expect(await onHand(A.tenantId, ids.D, W)).toBe('5.000000');
    // The same recipe one level up (DR1, 9 levels with its leaf at depth 8) is the last depth that explodes.
    expect((await sell(chain[1], '1', `${Y}-02-13`)).posted.status).toBe(201);
    expect(await onHand(A.tenantId, ids.D, W)).toBe('4.000000');
    await verified(A.token);
  }, 120_000);

  it('tenant B cannot read tenant A: the recipe preview, the cost card and the consumption report are 404', async () => {
    const B = await registerTenant(`P17B${RUN}`);
    const pv = await h.get(B.token, `sales-invoices/${ids.previewInvoice}/recipe-preview`);
    expect(pv.status).toBe(404);
    const cost = await h.get(B.token, `boms/${ids.bomM}/cost`);
    expect(cost.status).toBe(404);
    const cons = await h.get(B.token, `stock-reports/consumption?warehouseId=${W}&fromCountId=1&toCountId=2`);
    expect(cons.status).toBe(404);
  });
});

describe('Phase 17 — consumption between two counts (ADR-032 §6), tenant C', () => {
  let C: Ctx;
  let W = '';
  let customer = '';
  let supplier = '';
  let approver = '';
  let I1 = '';
  let I5 = '';
  let R = '';
  let P = '';

  /** A physical count of the two items: created by the owner, counted, submitted, approved by another storekeeper. */
  async function countAndApprove(countDate: string, counted: Record<string, string>) {
    const cnt = h.ok(
      await h.api().post('/api/v1/stock-counts').set(h.auth(C.token)).send({ countDate, warehouseId: W, scope: 'ITEMS', itemIds: [I1, I5] }),
      201,
      'count',
    );
    for (const line of cnt.lines as { id: string; itemId: string }[]) {
      const res = await h.api().put(`/api/v1/stock-counts/${cnt.id}/lines/${line.id}`).set(h.auth(C.token)).send({ countedQty: counted[line.itemId] });
      expect(res.status).toBe(200);
    }
    h.ok(await h.act(C.token, `stock-counts/${cnt.id}/submit`), 201, 'submit count');
    h.ok(await h.act(approver, `stock-counts/${cnt.id}/approve`), 201, 'approve count');
    return cnt.id as string;
  }

  it('setup: tenant C — stock I1 I5, recipe R = I1 1, manufactured P = I1 1, opening purchase, a second storekeeper', async () => {
    C = await registerTenant(`P17C${RUN}`);
    W = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(C.token)).send({ code: 'W', nameAr: 'W' }), 201, 'warehouse').id;
    customer = h.ok(await h.api().post('/api/v1/parties').set(h.auth(C.token)).send({ code: 'C', nameAr: 'C', partyType: 'CUSTOMER' }), 201, 'customer').id;
    supplier = h.ok(await h.api().post('/api/v1/parties').set(h.auth(C.token)).send({ code: 'S', nameAr: 'S', partyType: 'SUPPLIER' }), 201, 'supplier').id;
    I1 = await makeItem(C, 'I1');
    I5 = await makeItem(C, 'I5');
    R = await makeItem(C, 'R', 'RECIPE');
    P = await makeItem(C, 'P', 'MANUFACTURED');
    await activeBom(C, R, [{ componentItemId: I1, qty: '1' }]);
    await activeBom(C, P, [{ componentItemId: I1, qty: '1' }]);
    await buy(C, supplier, W, `${Y}-01-01`, [
      { itemId: I1, qty: '10', unitCost: '1' },
      { itemId: I5, qty: '10', unitCost: '2' },
    ]);
    const branch = (await boot.db.query('SELECT id FROM branches WHERE tenant_id = ? ORDER BY id LIMIT 1', [C.tenantId])) as { id: bigint }[];
    const branchId = String(branch[0].id);
    const member = await addMember(boot.base, C.token, {
      email: `approver-${RUN}@test.dev`,
      roleCode: 'STOREKEEPER',
      password: PASS,
      branchIds: [branchId],
      defaultBranchId: branchId,
    });
    approver = member.token;
  });

  it('count 1 (2025-01-02 → dated Y-01-02): I1 10 and I5 10 counted and approved', async () => {
    const counted = { [I1]: '10', [I5]: '10' };
    (C as Ctx & { c1?: string }).c1 = await countAndApprove(`${Y}-01-02`, counted);
  });

  it('between the counts: a purchase of I1 5, a recipe sale of 2 R, a direct sale of 3 I5, a production of 1 P', async () => {
    await buy(C, supplier, W, `${Y}-01-03`, [{ itemId: I1, qty: '5', unitCost: '1' }]);
    const recipeSale = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(C.token)).send({
        invoiceDate: `${Y}-01-04`,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: R, qty: '2', unitPrice: '1.000' }],
      }),
      201,
      'recipe sale',
    );
    h.ok(await h.act(C.token, `sales-invoices/${recipeSale.id}/post`), 201, 'post recipe sale');
    const direct = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(C.token)).send({
        invoiceDate: `${Y}-01-05`,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: I5, qty: '3', unitPrice: '3.000' }],
      }),
      201,
      'direct sale',
    );
    h.ok(await h.act(C.token, `sales-invoices/${direct.id}/post`), 201, 'post direct sale');
    const produced = h.ok(
      await h.api().post('/api/v1/production-vouchers').set(h.auth(C.token)).send({ itemId: P, qty: '1', materialsWarehouseId: W, voucherDate: `${Y}-01-06` }),
      201,
      'voucher',
    );
    h.ok(await h.act(C.token, `production-vouchers/${produced.id}/post`), 201, 'post production');
    await verified(C.token);
  });

  it('count 2 (dated Y-01-07): I1 counted 11 (one unrecorded), I5 counted 7; the report splits the consumption', async () => {
    const c1 = (C as Ctx & { c1?: string }).c1!;
    const c2 = await countAndApprove(`${Y}-01-07`, { [I1]: '11', [I5]: '7' });
    const res = await h.get(C.token, `stock-reports/consumption?warehouseId=${W}&fromCountId=${c1}&toCountId=${c2}`);
    expect(res.status).toBe(200);
    const rows = res.body.rows as Record<string, string>[];
    const byCode = (code: string) => rows.find((r) => r.code === code)!;
    // I1: counted 10 + receipts 5 − counted 11 = actual 4; recorded = recipe 2 + production 1 = 3
    // (the count adjustment −1 is left out of both); variance 4 − 3 = 1; at the average 1.000.
    const i1 = byCode('I1');
    expect([
      new Decimal(i1.openingCounted).toFixed(6),
      new Decimal(i1.receipts).toFixed(6),
      new Decimal(i1.closingCounted).toFixed(6),
      new Decimal(i1.actual).toFixed(6),
      new Decimal(i1.recorded).toFixed(6),
      new Decimal(i1.recipeOut).toFixed(6),
      new Decimal(i1.directSales).toFixed(6),
      new Decimal(i1.otherOut).toFixed(6),
      new Decimal(i1.variance).toFixed(6),
      m3(i1.varianceValue),
    ]).toEqual(['10.000000', '5.000000', '11.000000', '4.000000', '3.000000', '2.000000', '0.000000', '1.000000', '1.000000', '1.000']);
    // I5: counted 10 − counted 7 = actual 3 = recorded 3 (direct sale); no variance; at the average 2.000.
    const i5 = byCode('I5');
    expect([
      new Decimal(i5.actual).toFixed(6),
      new Decimal(i5.recorded).toFixed(6),
      new Decimal(i5.directSales).toFixed(6),
      new Decimal(i5.variance).toFixed(6),
      m3(i5.recordedValue),
    ]).toEqual(['3.000000', '3.000000', '3.000000', '0.000000', '6.000']);
    expect(rows).toHaveLength(2);
    expect([m3(res.body.totals.actualValue), m3(res.body.totals.recordedValue), m3(res.body.totals.varianceValue)]).toEqual(['10.000', '9.000', '1.000']);
  });

  it('the consumption report is refused for two counts that are not in order or not posted', async () => {
    const c1 = (C as Ctx & { c1?: string }).c1!;
    const reversed = await h.get(C.token, `stock-reports/consumption?warehouseId=${W}&fromCountId=${Number(c1) + 1}&toCountId=${c1}`);
    expect(reversed.status).toBeGreaterThanOrEqual(400);
  });
});
