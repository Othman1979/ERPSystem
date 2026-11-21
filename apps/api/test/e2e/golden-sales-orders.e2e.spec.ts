/**
 * Golden scenarios S12–S14 — sales invoices made from sales orders (ADR-027 §9).
 * NEW scenarios: S1–S11 (golden.e2e.spec.ts), T1–T6 and P1–P7 are untouched.
 * Tax 16%, prices exclusive of tax, every stock item bought at 5.000. All numbers
 * are hand-computed here; never change them to make a test pass.
 *
 * S12  Order of 10 X @ 10.000, invoiced 6 then 4 (credit, 2026-11-15); the same on a
 *      twin item Y bought and priced alike by two DIRECT invoices of 6 and 4.
 *      Invoice of 6: net 6 × 10 = 60.000, tax 60 × 16% = 9.600, total 69.600, cost 6 × 5 = 30.000
 *        → 1103 Dr 69.600, 4101 Cr 60.000, 2102 Cr 9.600, 5101 Dr 30.000, 1104 Cr 30.000.
 *      Invoice of 4: net 40.000, tax 6.400, total 46.400, cost 20.000
 *        → 1103 Dr 46.400, 4101 Cr 40.000, 2102 Cr 6.400, 5101 Dr 20.000, 1104 Cr 20.000.
 *      Together: revenue 100.000, tax 16.000, receivable 116.000, COGS 50.000, inventory 50.000;
 *      the order's entries and the direct ones sum to the same figures per account. The order
 *      ends INVOICED with invoicedQty 10 on its line (6 after the first invoice).
 * S13  Order of 10 Z @ 10.000, invoice 6 posted (PARTIALLY_INVOICED), then closed with a reason.
 *      Reserved = 10 − 6 = 4 before the close and 0 after it; a new invoice from the closed order
 *      is refused (SALES_ORDER_NOT_INVOICEABLE, 409).
 * S14  Company sales_reservation HARD; H on hand 10, a confirmed order of 8 reserves 8, so 2 are
 *      available. A direct invoice of 3 > 2 is refused (STOCK_RESERVED, 409); a direct invoice of
 *      2 posts (net 2 × 10 = 20.000, tax 3.200, total 23.200, cost 2 × 5 = 10.000). The company
 *      goes back to SOFT.
 * After each scenario: stock:verify has no differences and the trial balance is balanced.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const T = 60_000;

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3724);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('Golden scenarios S12–S14 — invoices from sales orders (ADR-027)', () => {
  let token = '';
  let W = '';
  let X = '';
  let Y = '';
  let Z = '';
  let H = '';
  let customer = '';

  /** Journal lines as sorted "CODE Dr|Cr amount" strings. */
  async function entryLines(entryId: string) {
    const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
    return (body.lines as { account: { code: string }; debit: string; credit: string; partyId?: string | null }[])
      .map((l) => {
        const dr = new Decimal(l.debit);
        const party = l.partyId === customer ? ' customer' : '';
        return `${l.account.code} ${dr.gt(0) ? `Dr ${m3(dr)}` : `Cr ${m3(l.credit)}`}${party}`;
      })
      .sort();
  }

  /** Net (Dr − Cr) per account code over several entries, as fixed strings. */
  async function sumByAccount(entryIds: string[]) {
    const totals = new Map<string, Decimal>();
    for (const id of entryIds) {
      const body = h.ok(await h.get(token, `journal-entries/${id}`), 200, 'journal entry');
      for (const l of body.lines as { account: { code: string }; debit: string; credit: string }[]) {
        totals.set(l.account.code, (totals.get(l.account.code) ?? new Decimal(0)).plus(l.debit).minus(l.credit));
      }
    }
    return Object.fromEntries([...totals].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, m3(v)]));
  }

  /** After every scenario (CLAUDE.md): stock:verify clean and the trial balance balanced. */
  async function verified() {
    const verify = await h.get(token, 'stock/verify');
    expect(verify.status).toBe(200);
    expect(verify.body.mismatches).toEqual([]);
    const tb = await h.get(token, 'reports/trial-balance');
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
  }

  const orderOf = async (itemId: string, qty: string) => {
    const created = h.ok(
      await h.api().post('/api/v1/sales-orders').set(h.auth(token)).send({
        orderDate: '2026-11-10',
        customerId: customer,
        warehouseId: W,
        lines: [{ itemId, qty, unitPrice: '10' }],
      }),
      201,
      'create order',
    );
    return h.ok(await h.act(token, `sales-orders/${created.id}/confirm`), 201, 'confirm order') as { id: string; status: string };
  };

  /** A draft invoice from the order, its quantity set to `qty`, posted. */
  async function invoiceFromOrder(orderId: string, qty: string) {
    const draft = h.ok(await h.act(token, `sales-orders/${orderId}/invoice`, { invoiceDate: '2026-11-15' }), 201, 'invoice from order');
    const inv = await h.get(token, `sales-invoices/${draft.id}`);
    const line = (inv.body.lines as { itemId: string; orderLineId: string; unitPrice: string }[])[0];
    h.ok(
      await h.updateLocked(token, 'SALES_INVOICE', draft.id, {
        invoiceDate: '2026-11-15',
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: line.itemId, qty, unitPrice: line.unitPrice, orderLineId: line.orderLineId }],
      }),
      200,
      'set invoice qty',
    );
    return h.act(token, `sales-invoices/${draft.id}/post`);
  }

  async function directInvoice(itemId: string, qty: string) {
    const created = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
        invoiceDate: '2026-11-15',
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId, qty, unitPrice: '10' }],
      }),
      201,
      'create direct invoice',
    );
    return h.act(token, `sales-invoices/${created.id}/post`);
  }

  const reservedOf = async (itemId: string) => {
    const res = await h.get(token, `sales-orders/reservation?warehouseId=${W}&itemIds=${itemId}`);
    expect(res.status).toBe(200);
    return (res.body.items as { itemId: string; reserved: string }[]).find((r) => r.itemId === itemId)!.reserved;
  };

  it(
    'setup: company, warehouse, items X Y Z H (16%), a customer, 10 of each bought at 5.000',
    async () => {
      const reg = await h
        .api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `GoldenSO ${RUN}`, ownerName: 'Owner', email: `gso-${RUN}@test.dev`, password: PASS });
      expect(reg.status).toBe(201);
      token = reg.body.accessToken;
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' }), 201, 'fy');
      W = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(token)).send({ code: 'W', nameAr: 'W' }), 201, 'warehouse').id;
      const pcs = ((await h.get(token, 'units')).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      const tax16 = ((await h.get(token, 'tax-categories')).body as { id: string; rate: string }[]).find((t) => new Decimal(t.rate).eq(16))!;
      const item = async (code: string) =>
        h.ok(await h.api().post('/api/v1/items').set(h.auth(token)).send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: tax16.id }), 201, `item ${code}`).id as string;
      X = await item('X');
      Y = await item('Y');
      Z = await item('Z');
      H = await item('H');
      const party = async (code: string, partyType: string) =>
        h.ok(await h.api().post('/api/v1/parties').set(h.auth(token)).send({ code, nameAr: code, partyType }), 201, `party ${code}`).id as string;
      customer = await party('C', 'CUSTOMER');
      const supplier = await party('S', 'SUPPLIER');
      const bought = h.ok(
        await h.api().post('/api/v1/purchase-invoices').set(h.auth(token)).send({
          invoiceDate: '2026-11-01',
          supplierId: supplier,
          warehouseId: W,
          paymentType: 'CREDIT',
          lines: [X, Y, Z, H].map((itemId) => ({ itemId, qty: '10', unitCost: '5' })),
        }),
        201,
        'purchase',
      );
      h.ok(await h.act(token, `purchase-invoices/${bought.id}/post`), 201, 'post purchase');
      await verified();
    },
    T,
  );

  it(
    'S12 order of 10: invoices of 6 and 4 give the journal of two direct invoices of 6 and 4; the order ends INVOICED',
    async () => {
      const order = await orderOf(X, '10');
      expect(order.status).toBe('CONFIRMED');

      const first = await invoiceFromOrder(order.id, '6');
      expect(first.status).toBe(201);
      expect(m3(first.body.costTotal)).toBe('30.000');
      expect(await entryLines(first.body.journalEntryId)).toEqual(
        ['1103 Dr 69.600 customer', '4101 Cr 60.000', '2102 Cr 9.600', '5101 Dr 30.000', '1104 Cr 30.000'].sort(),
      );
      const afterFirst = (await h.get(token, `sales-orders/${order.id}`)).body;
      expect(afterFirst.status).toBe('PARTIALLY_INVOICED');
      expect(new Decimal(afterFirst.lines[0].invoicedQty).toFixed(6)).toBe('6.000000');
      const left = (await h.get(token, `sales-orders/${order.id}/invoiceable`)).body;
      expect(left.lines[0].remainingBase).toBe('4.000000');

      const second = await invoiceFromOrder(order.id, '4');
      expect(second.status).toBe(201);
      expect(m3(second.body.costTotal)).toBe('20.000');
      expect(await entryLines(second.body.journalEntryId)).toEqual(
        ['1103 Dr 46.400 customer', '4101 Cr 40.000', '2102 Cr 6.400', '5101 Dr 20.000', '1104 Cr 20.000'].sort(),
      );
      const done = (await h.get(token, `sales-orders/${order.id}`)).body;
      expect(done.status).toBe('INVOICED');
      expect(new Decimal(done.lines[0].invoicedQty).toFixed(6)).toBe('10.000000');
      expect(await reservedOf(X)).toBe('0.000000');

      // The twin item Y through two direct invoices of 6 and 4 at the same price and cost.
      const d1 = await directInvoice(Y, '6');
      const d2 = await directInvoice(Y, '4');
      expect([d1.status, d2.status]).toEqual([201, 201]);
      const viaOrder = await sumByAccount([first.body.journalEntryId, second.body.journalEntryId]);
      const direct = await sumByAccount([d1.body.journalEntryId, d2.body.journalEntryId]);
      expect(direct).toEqual(viaOrder);
      // Hand-computed totals: receivable 116.000, revenue 100.000, tax 16.000, COGS 50.000, inventory 50.000.
      expect(viaOrder).toEqual({ '1103': '116.000', '1104': '-50.000', '2102': '-16.000', '4101': '-100.000', '5101': '50.000' });
      await verified();
    },
    T,
  );

  it(
    'S13 order of 10, 6 invoiced, then closed with a reason: nothing reserved, no new invoice',
    async () => {
      const order = await orderOf(Z, '10');
      expect(await reservedOf(Z)).toBe('10.000000');
      const posted = await invoiceFromOrder(order.id, '6');
      expect(posted.status).toBe(201);
      expect(await reservedOf(Z)).toBe('4.000000'); // 10 - 6
      const closed = await h.act(token, `sales-orders/${order.id}/close`, { reason: 'The customer took 6 only' });
      expect(closed.status).toBe(201);
      expect(closed.body.status).toBe('CLOSED');
      expect(await reservedOf(Z)).toBe('0.000000');
      const refused = await h.act(token, `sales-orders/${order.id}/invoice`, {});
      expect(h.err(refused)).toEqual([409, 'SALES_ORDER_NOT_INVOICEABLE']);
      await verified();
    },
    T,
  );

  it(
    'S14 HARD reservation: on hand 10, a confirmed order of 8; a direct invoice of 3 is refused, of 2 posts',
    async () => {
      h.ok(await h.patchCompany(token, { salesReservation: 'HARD' }), 200, 'HARD');
      try {
        const order = await orderOf(H, '8');
        expect(order.status).toBe('CONFIRMED');
        expect(await reservedOf(H)).toBe('8.000000');
        const refused = await directInvoice(H, '3');
        expect(h.err(refused)).toEqual([409, 'STOCK_RESERVED']);
        const posted = await directInvoice(H, '2');
        expect(posted.status).toBe(201);
        expect(m3(posted.body.costTotal)).toBe('10.000');
        expect(await entryLines(posted.body.journalEntryId)).toEqual(
          ['1103 Dr 23.200 customer', '4101 Cr 20.000', '2102 Cr 3.200', '5101 Dr 10.000', '1104 Cr 10.000'].sort(),
        );
        await verified();
      } finally {
        h.ok(await h.patchCompany(token, { salesReservation: 'SOFT' }), 200, 'back to SOFT');
      }
      expect((await h.get(token, 'company')).body.salesReservation).toBe('SOFT');
    },
    T,
  );
});
