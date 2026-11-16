/**
 * Golden scenarios M1–M3 — production vouchers (ADR-031 §2–§4, §6, §7).
 * Tax-free stock items, prices and costs as written below. Every number is
 * computed by hand in the comments; never change them to make a test pass.
 *
 * Raw materials: R1 bought 10 @ 1.000 and R2 bought 20 @ 0.500 (purchase invoice).
 * Semi-finished S (BOM v1, output 1 PCS): R1 2 + R2 1, applied cost 0.100 per unit.
 * Product P (BOM v1, output 1 PCS): S 1 + R2 2, applied cost 0.250 per unit.
 *
 * M1  Two levels. Produce 4 S from the default (standard) lines:
 *       materials R1 8 × 1.000 = 8.000 and R2 4 × 0.500 = 2.000 → 10.000;
 *       applied 4 × 0.100 = 0.400; output 10.400, unit 10.400 ÷ 4 = 2.600.
 *       Journal: 1104 Dr 10.400 / 1104 Cr 10.000 / 5104 Cr 0.400.
 *       Stock after: R1 2, R2 16, S 4 @ 2.600.
 *     Produce 2 P: materials S 2 × 2.600 = 5.200 and R2 4 × 0.500 = 2.000 → 7.200;
 *       applied 2 × 0.250 = 0.500; output 7.700, unit 7.700 ÷ 2 = 3.850.
 *       Journal: 1104 Dr 7.700 / 1104 Cr 7.200 / 5104 Cr 0.500.
 *       Stock after: R2 12, S 2 @ 2.600, P 2 @ 3.850. 5104 net credit 0.900 in total.
 * M2  Waste and an edited consumption. Q (BOM v1, output 1): R1 3 with 5% waste, applied 0.200.
 *       R1 bought 100 @ 1.000 (stock 102). Produce 10 Q: standard R1 = 3 × 10 × 1.05 = 31.500,
 *       but 32 actually consumed. Materials 32 × 1.000 = 32.000; applied 10 × 0.200 = 2.000;
 *       output 34.000, unit 3.400. Standard 31.500 and actual 32.000 are kept on the line.
 *       Journal: 1104 Dr 34.000 / 1104 Cr 32.000 / 5104 Cr 2.000. R1 stock 70.
 * M3  Reverse the M2 voucher (dated today): the output goes out at 34.000 and R1 comes back at its
 *       cost, 32.000; applied 2.000 back. Stock returns to before (Q 0, R1 102). Journal reversal:
 *       1104 Dr 32.000 / 5104 Dr 2.000 / 1104 Cr 34.000. A second reversal and a reversal of the
 *       reversal are refused. Then produce 10 Q again (standard 31.500 R1, cost 31.500 + 2.000
 *       = 33.500, unit 3.350), sell 4 Q, and a reversal is refused PRODUCTION_OUTPUT_CONSUMED (6 on
 *       hand, 10 needed) even with allow_negative_stock on.
 * After each scenario: stock:verify has no differences and the trial balance is balanced.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const T = 60_000;
/** The current year: the fiscal year and every voucher date sit in it, in January (before today). */
const Y = new Date().getUTCFullYear();

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3735);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('Golden scenarios M1–M3 — production vouchers (ADR-031)', () => {
  let token = '';
  let tenantId = '';
  let W = '';
  let R1 = '';
  let R2 = '';
  let S = '';
  let P = '';
  let Q = '';
  let customer = '';
  let supplier = '';
  let voucherM1S = '';
  let voucherM2Q = '';
  let voucherM3Q = '';

  /** Journal lines as sorted "CODE Dr|Cr amount" strings. */
  async function entryLines(entryId: string) {
    const body = h.ok(await h.get(token, `journal-entries/${entryId}`), 200, 'journal entry');
    return (body.lines as { account: { code: string }; debit: string; credit: string }[])
      .map((l) => {
        const dr = new Decimal(l.debit);
        return `${l.account.code} ${dr.gt(0) ? `Dr ${m3(dr)}` : `Cr ${m3(l.credit)}`}`;
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

  /** Stock on hand of an item in a warehouse, as a fixed 6-dp string. */
  async function onHand(itemId: string, warehouseId: string): Promise<string> {
    const [row] = (await boot.db.query(
      'SELECT qty_on_hand AS q FROM stock_balances WHERE tenant_id = ? AND item_id = ? AND warehouse_id = ?',
      [tenantId, itemId, warehouseId],
    )) as { q: string }[];
    return new Decimal(row?.q ?? 0).toFixed(6);
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

  /** A draft voucher from the default lines (no lines sent), then posted. */
  async function produce(itemId: string, qty: string, date: string, lines?: { itemId: string; qty: string }[]) {
    const body: Record<string, unknown> = { itemId, qty, materialsWarehouseId: W, voucherDate: date };
    if (lines) body.lines = lines;
    const draft = h.ok(await h.api().post('/api/v1/production-vouchers').set(h.auth(token)).send(body), 201, 'create voucher');
    return { draft, posted: await h.act(token, `production-vouchers/${draft.id}/post`) };
  }

  /** A posted purchase of raw materials at the given unit costs. */
  async function purchase(lines: { itemId: string; qty: string; unitCost: string }[], date = `${Y}-01-01`) {
    const bought = h.ok(
      await h.api().post('/api/v1/purchase-invoices').set(h.auth(token)).send({
        invoiceDate: date,
        supplierId: supplier,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines,
      }),
      201,
      'purchase',
    );
    h.ok(await h.act(token, `purchase-invoices/${bought.id}/post`), 201, 'post purchase');
  }

  it(
    'setup: company, warehouse, items R1 R2 (stock), S P Q (manufactured), parties, R1 and R2 bought',
    async () => {
      const reg = await h
        .api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `GoldenPR ${RUN}`, ownerName: 'Owner', email: `gpr-${RUN}@test.dev`, password: PASS });
      expect(reg.status).toBe(201);
      token = reg.body.accessToken;
      const [t] = (await boot.db.query('SELECT id AS tenantId FROM tenants WHERE name = ?', [`GoldenPR ${RUN}`])) as { tenantId: bigint }[];
      tenantId = String(t.tenantId);
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` }), 201, 'fy');
      W = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(token)).send({ code: 'W', nameAr: 'W' }), 201, 'warehouse').id;
      const pcs = ((await h.get(token, 'units')).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      const tax = ((await h.get(token, 'tax-categories')).body as { id: string; code: string }[]).find((x) => x.code === 'STANDARD')!;
      const item = async (code: string, itemKind?: string) =>
        h.ok(
          await h.api()
            .post('/api/v1/items')
            .set(h.auth(token))
            .send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: tax.id, ...(itemKind ? { itemKind } : {}) }),
          201,
          `item ${code}`,
        ).id as string;
      R1 = await item('R1');
      R2 = await item('R2');
      S = await item('S', 'MANUFACTURED');
      P = await item('P', 'MANUFACTURED');
      Q = await item('Q', 'MANUFACTURED');
      const party = async (code: string, partyType: string) =>
        h.ok(await h.api().post('/api/v1/parties').set(h.auth(token)).send({ code, nameAr: code, partyType }), 201, `party ${code}`).id as string;
      customer = await party('C', 'CUSTOMER');
      supplier = await party('S', 'SUPPLIER');
      await purchase([
        { itemId: R1, qty: '10', unitCost: '1' },
        { itemId: R2, qty: '20', unitCost: '0.5' },
      ]);
      await verified();
    },
    T,
  );

  it(
    'M1 level 1: BOM of S (R1 2 + R2 1, applied 0.100); 4 S produced from the standards: 10.000 + 0.400 = 10.400',
    async () => {
      const bom = h.ok(
        await h.api().post('/api/v1/boms').set(h.auth(token)).send({
          itemId: S,
          outputQty: '1',
          appliedCostPerUnit: '0.100',
          lines: [
            { componentItemId: R1, qty: '2' },
            { componentItemId: R2, qty: '1' },
          ],
        }),
        201,
        'bom S',
      );
      h.ok(await h.act(token, `boms/${bom.id}/activate`), 201, 'activate S');

      const { draft, posted } = await produce(S, '4', `${Y}-01-05`);
      expect(draft.status).toBe('DRAFT');
      expect(draft.lines.map((l: { standardQtyBase: string; qtyBase: string }) => [m3(l.standardQtyBase), m3(l.qtyBase)])).toEqual([
        ['8.000', '8.000'],
        ['4.000', '4.000'],
      ]);
      expect(posted.status).toBe(201);
      voucherM1S = posted.body.id;
      expect(posted.body.status).toBe('POSTED');
      expect(posted.body.docNo).toMatch(/^MFG-/);
      expect([m3(posted.body.materialsTotal), m3(posted.body.appliedTotal), m3(posted.body.outputTotal)]).toEqual(['10.000', '0.400', '10.400']);
      expect(new Decimal(posted.body.outputUnitCost).toFixed(6)).toBe('2.600000');
      expect(posted.body.lines.map((l: { totalCost: string }) => m3(l.totalCost))).toEqual(['8.000', '2.000']);
      expect(await entryLines(posted.body.journalEntry.id)).toEqual(['1104 Cr 10.000', '1104 Dr 10.400', '5104 Cr 0.400'].sort());
      expect(await onHand(R1, W)).toBe('2.000000');
      expect(await onHand(R2, W)).toBe('16.000000');
      expect(await onHand(S, W)).toBe('4.000000');
      await verified();
    },
    T,
  );

  it(
    'M1 level 2: BOM of P (S 1 + R2 2, applied 0.250); 2 P produced: 7.200 + 0.500 = 7.700, unit 3.850',
    async () => {
      const bom = h.ok(
        await h.api().post('/api/v1/boms').set(h.auth(token)).send({
          itemId: P,
          outputQty: '1',
          appliedCostPerUnit: '0.250',
          lines: [
            { componentItemId: S, qty: '1' },
            { componentItemId: R2, qty: '2' },
          ],
        }),
        201,
        'bom P',
      );
      h.ok(await h.act(token, `boms/${bom.id}/activate`), 201, 'activate P');

      const { posted } = await produce(P, '2', `${Y}-01-06`);
      expect(posted.status).toBe(201);
      expect([m3(posted.body.materialsTotal), m3(posted.body.appliedTotal), m3(posted.body.outputTotal)]).toEqual(['7.200', '0.500', '7.700']);
      expect(new Decimal(posted.body.outputUnitCost).toFixed(6)).toBe('3.850000');
      expect(await entryLines(posted.body.journalEntry.id)).toEqual(['1104 Cr 7.200', '1104 Dr 7.700', '5104 Cr 0.500'].sort());
      expect(await onHand(R2, W)).toBe('12.000000');
      expect(await onHand(S, W)).toBe('2.000000');
      expect(await onHand(P, W)).toBe('2.000000');
      // 5104 is credited 0.400 (S, M1 level 1) and 0.500 (P): 0.900 in total, a net credit.
      const m1Entry = (await h.get(token, `production-vouchers/${voucherM1S}`)).body.journalEntry.id as string;
      expect((await sumByAccount([m1Entry, posted.body.journalEntry.id]))['5104']).toBe('-0.900');
      await verified();
    },
    T,
  );

  it(
    'M2 waste 5% and an edited consumption: standard 31.500, actual 32.000, the cost uses the actual (34.000, unit 3.400)',
    async () => {
      // Dated after the last R1 movement (5 January), so it is not a backdated posting.
      await purchase([{ itemId: R1, qty: '100', unitCost: '1' }], `${Y}-01-06`);
      expect(await onHand(R1, W)).toBe('102.000000');
      const bom = h.ok(
        await h.api().post('/api/v1/boms').set(h.auth(token)).send({
          itemId: Q,
          outputQty: '1',
          appliedCostPerUnit: '0.200',
          lines: [{ componentItemId: R1, qty: '3', wastePct: '5' }],
        }),
        201,
        'bom Q',
      );
      h.ok(await h.act(token, `boms/${bom.id}/activate`), 201, 'activate Q');

      // The default lines show the standard: 3 × 10 × (1 + 5%) = 31.500.
      const standard = h.ok(await h.api().post('/api/v1/production-vouchers').set(h.auth(token)).send({ itemId: Q, qty: '10', materialsWarehouseId: W, voucherDate: `${Y}-01-07` }), 201, 'standard draft');
      expect([standard.lines[0].standardQtyBase, standard.lines[0].qtyBase].map((v: string) => new Decimal(v).toFixed(6))).toEqual(['31.500000', '31.500000']);
      h.ok(await h.api().delete(`/api/v1/production-vouchers/${standard.id}`).set(h.auth(token)), 200, 'delete standard draft');

      // The actual consumption: 32 R1 were used.
      const { draft, posted } = await produce(Q, '10', `${Y}-01-07`, [{ itemId: R1, qty: '32' }]);
      // The API trims trailing zeros of a decimal string (`31.5`): compare at 6 dp.
      expect([new Decimal(draft.lines[0].standardQtyBase).toFixed(6), new Decimal(draft.lines[0].qtyBase).toFixed(6)]).toEqual(['31.500000', '32.000000']);
      expect(posted.status).toBe(201);
      voucherM2Q = posted.body.id;
      expect([m3(posted.body.materialsTotal), m3(posted.body.appliedTotal), m3(posted.body.outputTotal)]).toEqual(['32.000', '2.000', '34.000']);
      expect(new Decimal(posted.body.outputUnitCost).toFixed(6)).toBe('3.400000');
      expect(await entryLines(posted.body.journalEntry.id)).toEqual(['1104 Cr 32.000', '1104 Dr 34.000', '5104 Cr 2.000'].sort());
      expect(await onHand(R1, W)).toBe('70.000000');
      expect(await onHand(Q, W)).toBe('10.000000');
      await verified();
    },
    T,
  );

  it(
    'M3 reverse: the output leaves, the materials return at their cost, stock and journal return to before; a second reversal and a reversal of it are refused',
    async () => {
      const reversed = h.ok(await h.act(token, `production-vouchers/${voucherM2Q}/reverse`), 201, 'reverse M2');
      voucherM3Q = reversed.id;
      expect(reversed.status).toBe('POSTED');
      expect(reversed.reversalOfId).toBe(voucherM2Q);
      expect(reversed.docNo).toMatch(/^MFG-/);
      expect(await entryLines(reversed.journalEntry.id)).toEqual(['1104 Cr 34.000', '1104 Dr 32.000', '5104 Dr 2.000'].sort());
      expect(await onHand(Q, W)).toBe('0.000000');
      expect(await onHand(R1, W)).toBe('102.000000');

      const original = h.ok(await h.get(token, `production-vouchers/${voucherM2Q}`), 200, 'original');
      expect(original.status).toBe('POSTED');
      expect(original.reversals.map((r: { id: string }) => r.id)).toEqual([voucherM3Q]);

      expect(err(await h.act(token, `production-vouchers/${voucherM2Q}/reverse`))).toEqual([409, 'PRODUCTION_ALREADY_REVERSED']);
      expect(err(await h.act(token, `production-vouchers/${voucherM3Q}/reverse`))).toEqual([409, 'PRODUCTION_REVERSAL_NOT_REVERSIBLE']);

      // The M2 entry and its reversal: 5104 nets to zero.
      const net = await sumByAccount([(await h.get(token, `production-vouchers/${voucherM2Q}`)).body.journalEntry.id, reversed.journalEntry.id]);
      expect(net['5104']).toBe('0.000');
      await verified();
    },
    T,
  );

  it(
    'M3 sold output: after a new production and a sale of 4, a reversal is refused PRODUCTION_OUTPUT_CONSUMED even with allow_negative_stock on',
    async () => {
      // Dated on the reversal's day (today in the company's zone): the reversal is the last movement of Q.
      const today = (await h.get(token, `production-vouchers/${voucherM3Q}`)).body.voucherDate.slice(0, 10) as string;
      // The standard requirements again: 31.500 R1 → 31.500 + 2.000 = 33.500, unit 3.350.
      const { posted } = await produce(Q, '10', today);
      expect(posted.status).toBe(201);
      expect([m3(posted.body.materialsTotal), m3(posted.body.appliedTotal), m3(posted.body.outputTotal)]).toEqual(['31.500', '2.000', '33.500']);
      expect(await onHand(R1, W)).toBe('70.500000');
      const second = posted.body.id as string;

      // Sell 4 of Q: 10 − 4 = 6 on hand.
      const invoice = h.ok(
        await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
          invoiceDate: today,
          customerId: customer,
          warehouseId: W,
          paymentType: 'CREDIT',
          lines: [{ itemId: Q, qty: '4', unitPrice: '10' }],
        }),
        201,
        'sale',
      );
      h.ok(await h.act(token, `sales-invoices/${invoice.id}/post`), 201, 'post sale');
      expect(await onHand(Q, W)).toBe('6.000000');

      // Negative stock allowed for the company: the sold output still blocks the reversal.
      await boot.db.query('UPDATE companies SET allow_negative_stock = 1 WHERE tenant_id = ?', [tenantId]);
      try {
        const refused = await h.act(token, `production-vouchers/${second}/reverse`);
        expect(err(refused)).toEqual([409, 'PRODUCTION_OUTPUT_CONSUMED']);
        expect(refused.body.error.details).toMatchObject({ onHand: '6', required: '10' });
      } finally {
        await boot.db.query('UPDATE companies SET allow_negative_stock = 0 WHERE tenant_id = ?', [tenantId]);
      }
      expect(await onHand(Q, W)).toBe('6.000000');
      await verified();
    },
    T,
  );
});

/** The error code and status of a failed response. */
function err(res: { status: number; body: { error?: { code?: string } } }): [number, string | undefined] {
  return [res.status, res.body?.error?.code];
}
