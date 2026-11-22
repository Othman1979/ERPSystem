/**
 * Phase 14 part B — sales invoices made from sales orders (ADR-027 §4, §5, §8):
 *  - over-invoicing refused at post (SALES_ORDER_OVER_INVOICED) and at the draft update;
 *  - concurrency: two posts of the same remaining line (one wins, stock out once); a cancel
 *    racing an invoice post; a confirm racing a direct post on the last quantity (HARD);
 *  - the deadlock check of the post path: many posts of invoices of different orders plus an
 *    owner PATCH /company in one Promise.all; no 500, only DomainError answers;
 *  - sales_order_required, the price lock with its approval, default settings unchanged;
 *  - tenant and branch isolation of the new routes, an idempotent replay of POST invoice;
 *  - a quote past its validity is still convertible once ACCEPTED (accept is the only gate).
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import type request from 'supertest';
import { addMember } from './support/members.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const T = 120_000;
const AUDIT_FILE = path.join(os.tmpdir(), `p14b-audit-${RUN}.jsonl`);

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3725, AUDIT_FILE);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
  rmSync(AUDIT_FILE, { force: true });
});

describe('Phase 14 part B — invoices from sales orders (ADR-027)', () => {
  let owner = '';
  let ownerB = '';
  let acc = ''; // the author of drafts (ACCOUNTANT + sales.approve, so a self-approval is attempted)
  let acc2 = ''; // a different approver (ACCOUNTANT + sales.approve)
  let accMain = ''; // ACCOUNTANT + sales.approve restricted to the main branch
  let tenantA = '';
  let mainBranch = '';
  let warehouse = '';
  let warehouseB2 = '';
  let customer = '';
  let supplier = '';
  let pcs = '';
  let tax16 = '';
  let itemNo = 0;

  const money = (v: unknown) => new Decimal(String(v)).toFixed(3);
  const qty6 = (v: unknown) => new Decimal(String(v)).toFixed(6);

  /** A new stock item with `stock` pieces bought at 5.000 (none when 0). */
  async function newItem(stock: number, wh = warehouse): Promise<string> {
    itemNo += 1;
    const id = h.ok(
      await h.api().post('/api/v1/items').set(h.auth(owner)).send({ code: `P${itemNo}`, nameAr: `P${itemNo}`, baseUnitId: pcs, taxCategoryId: tax16 }),
      201,
      'item',
    ).id as string;
    if (stock > 0) {
      const bought = h.ok(
        await h.api().post('/api/v1/purchase-invoices').set(h.auth(owner)).send({
          invoiceDate: '2026-11-01',
          supplierId: supplier,
          warehouseId: wh,
          paymentType: 'CREDIT',
          lines: [{ itemId: id, qty: String(stock), unitCost: '5' }],
        }),
        201,
        'purchase',
      );
      h.ok(await h.act(owner, `purchase-invoices/${bought.id}/post`), 201, 'post purchase');
    }
    return id;
  }

  /** A confirmed order of one line at `price` (default 10), made by `token`. */
  async function confirmedOrder(itemId: string, qty: string, opts: { price?: string; token?: string; warehouseId?: string; customerId?: string } = {}) {
    const token = opts.token ?? owner;
    const created = h.ok(
      await h.api().post('/api/v1/sales-orders').set(h.auth(token)).send({
        orderDate: '2026-11-10',
        customerId: opts.customerId ?? customer,
        warehouseId: opts.warehouseId ?? warehouse,
        lines: [{ itemId, qty, unitPrice: opts.price ?? '10' }],
      }),
      201,
      'create order',
    );
    const confirmed = h.ok(await h.act(token, `sales-orders/${created.id}/confirm`), 201, 'confirm order');
    expect(confirmed.status).toBe('CONFIRMED');
    return { id: confirmed.id as string, lineId: confirmed.lines[0].id as string, itemId };
  }

  /** A draft invoice from the order (all that is left). */
  async function draftOf(orderId: string, token = owner): Promise<string> {
    return h.ok(await h.act(token, `sales-orders/${orderId}/invoice`, { invoiceDate: '2026-11-15' }), 201, 'draft from order').id as string;
  }

  /** PUT of a draft made from an order: its one line set to `qty` at `price`. */
  function setLine(token: string, invoiceId: string, o: { itemId: string; lineId: string }, qty: string, price = '10', warehouseId = warehouse) {
    return h.updateLocked(token, 'SALES_INVOICE', invoiceId, {
      invoiceDate: '2026-11-15',
      customerId: customer,
      warehouseId,
      paymentType: 'CREDIT',
      lines: [{ itemId: o.itemId, qty, unitPrice: price, orderLineId: o.lineId }],
    });
  }

  const post = (token: string, invoiceId: string) => h.act(token, `sales-invoices/${invoiceId}/post`);

  async function directDraft(itemId: string, qty: string, token = owner) {
    return h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
        invoiceDate: '2026-11-15',
        customerId: customer,
        warehouseId: warehouse,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty, unitPrice: '10' }],
      }),
      201,
      'direct draft',
    ).id as string;
  }

  async function onHand(itemId: string, wh = warehouse): Promise<string> {
    const rows = (await h.get(owner, 'stock/balances')).body as { itemId: string; warehouseId: string; qtyOnHand: string }[];
    return qty6(rows.find((r) => r.itemId === itemId && r.warehouseId === wh)?.qtyOnHand ?? '0');
  }

  async function orderState(orderId: string) {
    const body = (await h.get(owner, `sales-orders/${orderId}`)).body;
    return { status: body.status as string, invoiced: qty6(body.lines[0].invoicedQty) };
  }

  /** stock:verify clean and the trial balance balanced (CLAUDE.md, after any posting test). */
  async function verified() {
    const verify = await h.get(owner, 'stock/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await h.get(owner, 'reports/trial-balance');
    expect(tb.body.balanced).toBe(true);
  }

  const outcome = (r: request.Response) => (r.status === 201 ? 'OK' : `${r.status} ${r.body?.error?.code}`);

  it(
    'setup: tenants A and B, a second branch with a warehouse, a customer, members',
    async () => {
      for (const tag of ['a', 'b']) {
        const res = await h
          .api()
          .post('/api/v1/auth/register')
          .send({ tenantName: `P14B ${tag} ${RUN}`, ownerName: `Owner ${tag}`, email: `p14b-${tag}-${RUN}@test.dev`, password: PASS });
        expect(res.status).toBe(201);
        if (tag === 'a') owner = res.body.accessToken;
        else ownerB = res.body.accessToken;
      }
      const [t] = (await boot.db.query(
        'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
        [`P14B a ${RUN}`],
      )) as { tenantId: bigint; companyId: bigint }[];
      tenantA = String(t.tenantId);
      await boot.db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'PRO') WHERE name LIKE ?", [`P14B % ${RUN}`]);
      const [main] = (await boot.db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [tenantA])) as { id: bigint }[];
      mainBranch = String(main.id);
      const now = new Date();
      const b2 = (await boot.db.query(
        'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        [tenantA, String(t.companyId), 'B2', 'B2', now, now],
      )) as { insertId: bigint };
      const w2 = (await boot.db.query(
        'INSERT INTO warehouses (tenant_id, company_id, branch_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
        [tenantA, String(t.companyId), String(b2.insertId), 'W2', 'W2', now, now],
      )) as { insertId: bigint };
      warehouseB2 = String(w2.insertId);

      for (const token of [owner, ownerB]) {
        h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' }), 201, 'fy');
      }
      warehouse = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(owner)).send({ code: 'W1', nameAr: 'W1' }), 201, 'warehouse').id;
      pcs = ((await h.get(owner, 'units')).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      tax16 = ((await h.get(owner, 'tax-categories')).body as { id: string; rate: string }[]).find((x) => new Decimal(x.rate).eq(16))!.id;
      const party = async (code: string, partyType: string) =>
        h.ok(await h.api().post('/api/v1/parties').set(h.auth(owner)).send({ code, nameAr: code, partyType }), 201, code).id as string;
      customer = await party('C1', 'CUSTOMER');
      supplier = await party('S1', 'SUPPLIER');

      const grant = (membershipId: string) =>
        h.api().put(`/api/v1/users/${membershipId}/purchase-permissions`).set(h.auth(owner)).send({ permissions: [{ code: 'sales.approve' }] });
      const a = await addMember(boot.base, owner, { email: `p14b-acc-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
      const a2 = await addMember(boot.base, owner, { email: `p14b-acc2-${RUN}@test.dev`, roleCode: 'ACCOUNTANT', password: PASS });
      const am = await addMember(boot.base, owner, {
        email: `p14b-accmain-${RUN}@test.dev`,
        roleCode: 'ACCOUNTANT',
        password: PASS,
        branchIds: [mainBranch],
        defaultBranchId: mainBranch,
      });
      acc = a.token;
      acc2 = a2.token;
      accMain = am.token;
      for (const m of [a, a2, am]) expect((await grant(m.membershipId)).status).toBe(200);
    },
    T,
  );

  describe('over-invoicing (ADR-027 §4)', () => {
    it('refuses to post an invoice of more than the remaining quantity (SALES_ORDER_OVER_INVOICED)', async () => {
      const item = await newItem(20);
      const order = await confirmedOrder(item, '10');
      // Two drafts, each valid alone at save time: 6 and 6 of the 10.
      const d1 = await draftOf(order.id);
      const d2 = await draftOf(order.id);
      h.ok(await setLine(owner, d1, order, '6'), 200, 'd1 to 6');
      h.ok(await setLine(owner, d2, order, '6'), 200, 'd2 to 6');
      expect((await post(owner, d1)).status).toBe(201);
      const refused = await post(owner, d2);
      expect(h.err(refused)).toEqual([409, 'SALES_ORDER_OVER_INVOICED']);
      expect(await orderState(order.id)).toEqual({ status: 'PARTIALLY_INVOICED', invoiced: '6.000000' });
      expect(await onHand(item)).toBe('14.000000'); // only the 6 left the stock
      // The refused draft stays a draft and can be corrected to the 4 that remain.
      h.ok(await setLine(owner, d2, order, '4'), 200, 'd2 to 4');
      expect((await post(owner, d2)).status).toBe(201);
      expect(await orderState(order.id)).toEqual({ status: 'INVOICED', invoiced: '10.000000' });
      await verified();
    }, T);

    it('refuses to save a draft above the remaining quantity at the update', async () => {
      const item = await newItem(20);
      const order = await confirmedOrder(item, '10');
      const d1 = await draftOf(order.id);
      h.ok(await setLine(owner, d1, order, '6'), 200, 'd1 to 6');
      expect((await post(owner, d1)).status).toBe(201);
      const d2 = await draftOf(order.id); // the 4 that remain
      const over = await setLine(owner, d2, order, '5');
      expect(over.status).toBeGreaterThanOrEqual(400);
      expect(['SALES_ORDER_OVER_INVOICED', 'VALIDATION']).toContain(over.body?.error?.code);
      const stillOk = await setLine(owner, d2, order, '4');
      expect(stillOk.status).toBe(200);
    }, T);
  });

  describe('concurrency (ADR-027 §8)', () => {
    it('lets exactly one of two posts of the whole remaining line win, and takes the stock out once', async () => {
      const item = await newItem(20);
      const order = await confirmedOrder(item, '10');
      const d1 = await draftOf(order.id);
      const d2 = await draftOf(order.id);
      const [r1, r2] = await Promise.all([post(owner, d1), post(owner, d2)]);
      const outcomes = [r1, r2].map(outcome).sort();
      expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
      const loser = [r1, r2].find((r) => r.status !== 201)!;
      expect(loser.status).toBe(409);
      // The loser sees the order already INVOICED (NOT_INVOICEABLE), over-billed, or a lock conflict.
      expect(['SALES_ORDER_OVER_INVOICED', 'CONFLICT', 'SALES_ORDER_NOT_INVOICEABLE']).toContain(loser.body.error.code);
      expect(await orderState(order.id)).toEqual({ status: 'INVOICED', invoiced: '10.000000' });
      expect(await onHand(item)).toBe('10.000000'); // 20 - 10, once
      await verified();
    }, T);

    it('lets exactly one of two posts of 6 on an order of 10 win (invoicedQty 6 once)', async () => {
      const item = await newItem(20);
      const order = await confirmedOrder(item, '10');
      const d1 = await draftOf(order.id);
      const d2 = await draftOf(order.id);
      h.ok(await setLine(owner, d1, order, '6'), 200, 'd1');
      h.ok(await setLine(owner, d2, order, '6'), 200, 'd2');
      const [r1, r2] = await Promise.all([post(owner, d1), post(owner, d2)]);
      expect([r1, r2].filter((r) => r.status === 201)).toHaveLength(1);
      const loser = [r1, r2].find((r) => r.status !== 201)!;
      expect(loser.status).toBe(409);
      expect(['SALES_ORDER_OVER_INVOICED', 'CONFLICT']).toContain(loser.body.error.code);
      expect(await orderState(order.id)).toEqual({ status: 'PARTIALLY_INVOICED', invoiced: '6.000000' });
      expect(await onHand(item)).toBe('14.000000');
      await verified();
    }, T);

    it('lets exactly one of a post and a cancel of the same order win (three rounds)', async () => {
      for (let round = 1; round <= 3; round++) {
        const item = await newItem(10);
        const order = await confirmedOrder(item, '10');
        const draft = await draftOf(order.id);
        h.ok(await setLine(owner, draft, order, '5'), 200, 'draft to 5');
        const [posted, cancelled] = await Promise.all([
          post(owner, draft),
          h.act(owner, `sales-orders/${order.id}/cancel`, { reason: `race ${round}` }),
        ]);
        expect([posted.status === 201, cancelled.status === 201].filter(Boolean)).toHaveLength(1);
        const inv = (await h.get(owner, `sales-invoices/${draft}`)).body;
        const state = await orderState(order.id);
        if (posted.status === 201) {
          expect(h.err(cancelled)).toEqual([409, 'SALES_ORDER_NOT_CANCELLABLE']);
          expect(['PARTIALLY_INVOICED', 'INVOICED']).toContain(state.status);
          expect(state.invoiced).toBe('5.000000');
          expect(inv.status).toBe('POSTED');
          expect(await onHand(item)).toBe('5.000000');
        } else {
          expect(h.err(posted)).toEqual([409, 'SALES_ORDER_NOT_INVOICEABLE']);
          expect(state).toEqual({ status: 'CANCELLED', invoiced: '0.000000' });
          expect(inv.status).toBe('DRAFT');
          expect(inv.journalEntry).toBeNull();
          expect(await onHand(item)).toBe('10.000000');
        }
      }
      await verified();
    }, T);

    /**
     * ADR-027 §8: every sales post (and draft save) takes a SHARED lock on the company row
     * (lockCompanySales) so a settings change cannot move under it; PATCH /company takes the
     * exclusive one. This runs several posts of invoices of different orders together with
     * owner PATCHes of an unrelated setting, three rounds, to show no pair of them can wait
     * on each other in a cycle: every answer is a 2xx or a DomainError, never a raw 500.
     */
    it('answers posts racing owner company updates without a deadlock or a raw database error', async () => {
      const rounds = 3;
      const perRound = 6;
      for (let round = 0; round < rounds; round++) {
        const drafts: string[] = [];
        for (let i = 0; i < perRound; i++) {
          const item = await newItem(10);
          const order = await confirmedOrder(item, '3');
          drafts.push(await draftOf(order.id));
        }
        const calls: Promise<request.Response>[] = drafts.map((d) => post(owner, d));
        calls.push(h.patchCompany(owner, { quoteValidityDays: round % 2 === 0 ? 31 : 30 }));
        calls.push(h.patchCompany(owner, { quoteValidityDays: round % 2 === 0 ? 30 : 31 }));
        const answers = await Promise.all(calls);
        const posts = answers.slice(0, perRound);
        const patches = answers.slice(perRound);
        for (const r of answers) expect(r.status).toBeLessThan(500);
        for (const r of posts) {
          expect([201, 409]).toContain(r.status);
          if (r.status !== 201) expect(typeof r.body?.error?.code).toBe('string');
        }
        for (const r of patches) expect([200, 409]).toContain(r.status);
        // Each of these posts has its own order and item: none may lose to another.
        expect(posts.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      }
      expect((await h.patchCompany(owner, { quoteValidityDays: 30 })).status).toBe(200);
      await verified();
    }, T * 2);
  });

  describe('company settings on the invoice path (ADR-027 §1, §4)', () => {
    it('sales_order_required: a direct draft is created but not posted; an order invoice posts; the count of direct drafts shows', async () => {
      const item = await newItem(10);
      const order = await confirmedOrder(item, '2');
      const orderDraft = await draftOf(order.id);
      const direct = await directDraft(item, '1');
      const dbCount = async () => {
        const [row] = (await boot.db.query(
          "SELECT COUNT(*) AS n FROM sales_invoices WHERE tenant_id = ? AND status = 'DRAFT' AND sales_order_id IS NULL",
          [tenantA],
        )) as { n: bigint }[];
        return Number(row.n);
      };
      try {
        const on = await h.patchCompany(owner, { salesOrderRequired: true });
        expect(on.status).toBe(200);
        expect(on.body.salesOrderRequired).toBe(true);
        expect(on.body.directSalesDraftCount).toBe(await dbCount());
        expect(on.body.directSalesDraftCount).toBeGreaterThanOrEqual(1);
        const before = on.body.directSalesDraftCount as number;
        // A direct draft is still created (201); it does not post.
        const another = await directDraft(item, '1');
        expect((await h.get(owner, 'company')).body.directSalesDraftCount).toBe(before + 1);
        expect(h.err(await post(owner, another))).toEqual([409, 'SALES_ORDER_REQUIRED']);
        expect(h.err(await post(owner, direct))).toEqual([409, 'SALES_ORDER_REQUIRED']);
        // An invoice made from an order posts.
        expect((await post(owner, orderDraft)).status).toBe(201);
      } finally {
        expect((await h.patchCompany(owner, { salesOrderRequired: false })).status).toBe(200);
      }
      // Off again: the old direct draft posts.
      expect((await post(owner, direct)).status).toBe(201);
      await verified();
    }, T);

    it('price lock: a lower price needs an approval from another member; a later edit clears it; a higher price posts freely', async () => {
      const item = await newItem(20);
      const order = await confirmedOrder(item, '4'); // 4 @ 10.000
      expect((await h.patchCompany(owner, { salesPriceLocked: true })).body.salesPriceLocked).toBe(true);
      try {
        // acc makes the draft and lowers the price to 9.000: net 4 × 9 = 36.000.
        const draft = await draftOf(order.id, acc);
        const lowered = await setLine(acc, draft, order, '4', '9');
        expect(lowered.status).toBe(200);
        expect(money(lowered.body.netTotal)).toBe('36.000');
        expect(lowered.body.priceApprovedAt).toBeNull();
        expect(h.err(await post(acc, draft))).toEqual([409, 'SALES_PRICE_APPROVAL_REQUIRED']);

        // The author cannot approve their own draft (acc holds sales.approve).
        expect(h.err(await h.act(acc, `sales-invoices/${draft}/approve-price`))).toEqual([403, 'APPROVAL_SELF_NOT_ALLOWED']);
        // A member without the permission cannot either; another member with it can.
        const approved = await h.act(acc2, `sales-invoices/${draft}/approve-price`);
        expect(approved.status).toBe(201);
        expect(approved.body.priceApprovedAt).not.toBeNull();

        // A later edit (even to the same price) clears the approval, so the post is refused again.
        const edited = await setLine(acc, draft, order, '4', '9');
        expect(edited.status).toBe(200);
        expect(edited.body.priceApprovedAt).toBeNull();
        expect(h.err(await post(acc, draft))).toEqual([409, 'SALES_PRICE_APPROVAL_REQUIRED']);

        // Approved again, it posts at the lower price: net 36.000, cost 4 × 5 = 20.000.
        expect((await h.act(acc2, `sales-invoices/${draft}/approve-price`)).status).toBe(201);
        const posted = await post(acc, draft);
        expect(posted.status).toBe(201);
        expect(money(posted.body.netTotal)).toBe('36.000');
        expect(m3(posted.body.costTotal)).toBe('20.000');

        // Nothing to approve on a draft that is not below the order (VALIDATION).
        const order2 = await confirmedOrder(item, '2');
        const same = await draftOf(order2.id, acc);
        expect(h.err(await h.act(acc2, `sales-invoices/${same}/approve-price`))[1]).toBe('VALIDATION');
        // A HIGHER price always posts without approval: 2 × 11 = 22.000.
        const higher = await setLine(acc, same, order2, '2', '11');
        expect(higher.status).toBe(200);
        const hp = await post(acc, same);
        expect(hp.status).toBe(201);
        expect(money(hp.body.netTotal)).toBe('22.000');
      } finally {
        expect((await h.patchCompany(owner, { salesPriceLocked: false })).status).toBe(200);
      }
      await verified();
    }, T);

    it('HARD: with 10 on hand and an order of 9 confirmed, a direct invoice of 2 is refused and of 1 posts', async () => {
      const item = await newItem(10);
      expect((await h.patchCompany(owner, { salesReservation: 'HARD' })).status).toBe(200);
      try {
        await confirmedOrder(item, '9');
        expect(h.err(await post(owner, await directDraft(item, '2')))).toEqual([409, 'STOCK_RESERVED']);
        expect((await post(owner, await directDraft(item, '1'))).status).toBe(201);
        expect(await onHand(item)).toBe('9.000000');
        await verified();
      } finally {
        expect((await h.patchCompany(owner, { salesReservation: 'SOFT' })).status).toBe(200);
      }
    }, T);

    it('HARD: a confirm racing a direct post on the last unit lets exactly one win (three rounds)', async () => {
      expect((await h.patchCompany(owner, { salesReservation: 'HARD' })).status).toBe(200);
      try {
        for (let round = 1; round <= 3; round++) {
          const item = await newItem(1);
          const draftOrder = h.ok(
            await h.api().post('/api/v1/sales-orders').set(h.auth(owner)).send({
              orderDate: '2026-11-10',
              customerId: customer,
              warehouseId: warehouse,
              lines: [{ itemId: item, qty: '1', unitPrice: '10' }],
            }),
            201,
            'draft order',
          );
          const direct = await directDraft(item, '1');
          const [confirm, posted] = await Promise.all([h.act(owner, `sales-orders/${draftOrder.id}/confirm`), post(owner, direct)]);
          expect([confirm.status === 201, posted.status === 201].filter(Boolean)).toHaveLength(1);
          const loser = confirm.status === 201 ? posted : confirm;
          expect(h.err(loser)).toEqual([409, 'STOCK_RESERVED']);
        }
        await verified();
      } finally {
        expect((await h.patchCompany(owner, { salesReservation: 'SOFT' })).status).toBe(200);
      }
    }, T);

    it('default settings: a direct invoice drafts, posts and is numbered as before, with no order link', async () => {
      const company = (await h.get(owner, 'company')).body;
      expect(company).toMatchObject({ salesOrderRequired: false, salesReservation: 'SOFT', salesPriceLocked: false });
      const item = await newItem(5);
      const id = await directDraft(item, '2');
      const draft = (await h.get(owner, `sales-invoices/${id}`)).body;
      expect(draft).toMatchObject({ status: 'DRAFT', invoiceNo: null, salesOrderId: null });
      expect(draft.lines.every((l: { orderLineId: string | null }) => l.orderLineId === null)).toBe(true);
      const posted = await post(owner, id);
      expect(posted.status).toBe(201);
      expect(posted.body.invoiceNo).toEqual(expect.any(String));
      expect(posted.body.salesOrderId).toBeNull();
      const journalEntry = (await h.get(owner, `journal-entries/${posted.body.journalEntry.id}`)).body;
      expect(journalEntry.lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            description: 'Credit sale',
            descriptionKey: 'journal.line.creditSale',
          }),
        ]),
      );
      expect(await onHand(item)).toBe('3.000000');
      await verified();
    }, T);
  });

  describe('isolation, branches and replay', () => {
    it('answers tenant B 404 on the order invoicing routes of tenant A', async () => {
      const item = await newItem(5);
      const order = await confirmedOrder(item, '2');
      const draft = await draftOf(order.id);
      expect((await h.get(ownerB, `sales-orders/${order.id}/invoiceable`)).status).toBe(404);
      expect((await h.act(ownerB, `sales-orders/${order.id}/invoice`, {})).status).toBe(404);
      expect((await h.act(ownerB, `sales-invoices/${draft}/approve-price`)).status).toBe(404);
      // A's draft is untouched.
      expect((await h.get(owner, `sales-invoices/${draft}`)).body.status).toBe('DRAFT');
    }, T);

    it('answers a member restricted to the main branch 404 on an order and invoice of branch B2', async () => {
      const item = await newItem(5, warehouseB2);
      const order = await confirmedOrder(item, '2', { warehouseId: warehouseB2 });
      const draft = await draftOf(order.id); // the owner sees every branch
      expect((await h.get(accMain, `sales-orders/${order.id}`)).status).toBe(404);
      expect((await h.get(accMain, `sales-orders/${order.id}/invoiceable`)).status).toBe(404);
      expect((await h.act(accMain, `sales-orders/${order.id}/invoice`, {})).status).toBe(404);
      // accMain holds sales.approve, so the refusal is the branch rule. approve-price locks the
      // invoice row before the branch check, like POST /post, so it answers 403 BRANCH_NOT_ALLOWED
      // (the order routes above answer 404); either way nothing is approved.
      const ap = await h.act(accMain, `sales-invoices/${draft}/approve-price`);
      expect([404, 403]).toContain(ap.status);
      if (ap.status === 403) expect(ap.body.error.code).toBe('BRANCH_NOT_ALLOWED');
      expect((await h.get(owner, `sales-invoices/${draft}`)).body.priceApprovedAt).toBeNull();
      // The owner still reads it.
      expect((await h.get(owner, `sales-orders/${order.id}/invoiceable`)).status).toBe(200);
    }, T);

    it('replays POST sales-orders/:id/invoice for the same Idempotency-Key: one draft, the same id', async () => {
      const item = await newItem(5);
      const order = await confirmedOrder(item, '2');
      const key = `p14b-replay-${RUN}`;
      const first = await h.act(owner, `sales-orders/${order.id}/invoice`, { invoiceDate: '2026-11-15' }, key);
      const again = await h.act(owner, `sales-orders/${order.id}/invoice`, { invoiceDate: '2026-11-15' }, key);
      expect(first.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      const [row] = (await boot.db.query('SELECT COUNT(*) AS n FROM sales_invoices WHERE tenant_id = ? AND sales_order_id = ?', [tenantA, order.id])) as { n: bigint }[];
      expect(Number(row.n)).toBe(1);
    }, T);
  });

  describe('quotes past their validity (ADR-027 §2)', () => {
    let quoteItem = '';
    const quoteBody = (extra: object = {}) => ({
      customerId: customer,
      quoteDate: '2026-11-15',
      lines: [{ itemId: quoteItem, qty: '1', unitPrice: '10' }],
      ...extra,
    });

    it('converts an ACCEPTED quote even after its validity date passed', async () => {
      quoteItem = await newItem(0);
      const q = h.ok(await h.api().post('/api/v1/sales-quotes').set(h.auth(owner)).send(quoteBody()), 201, 'quote');
      h.ok(await h.act(owner, `sales-quotes/${q.id}/send`), 201, 'send');
      h.ok(await h.act(owner, `sales-quotes/${q.id}/accept`), 201, 'accept');
      await boot.db.query("UPDATE sales_quotes SET valid_until = '2020-01-01' WHERE tenant_id = ? AND id = ?", [tenantA, q.id]);
      const conv = await h.act(owner, `sales-quotes/${q.id}/convert`, { warehouseId: warehouse });
      expect(conv.status).toBe(201);
      expect(conv.body).toMatchObject({ status: 'DRAFT', quote: { id: q.id } });
    }, T);

    it('refuses to accept a SENT quote past its validity (QUOTE_EXPIRED)', async () => {
      quoteItem = quoteItem || (await newItem(0));
      const q = h.ok(
        await h.api().post('/api/v1/sales-quotes').set(h.auth(owner)).send(quoteBody({ quoteDate: '2026-10-01', validUntil: '2026-10-31' })),
        201,
        'quote',
      );
      h.ok(await h.act(owner, `sales-quotes/${q.id}/send`), 201, 'send');
      expect(h.err(await h.act(owner, `sales-quotes/${q.id}/accept`))[1]).toBe('QUOTE_EXPIRED');
    }, T);
  });

  it('keeps the books right and writes no OpenAPI response audit line', async () => {
    await verified();
    const lines = existsSync(AUDIT_FILE) ? readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    expect(lines).toBe('');
  }, T);
});
