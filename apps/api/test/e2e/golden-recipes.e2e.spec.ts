/**
 * Golden scenarios R1–R3 — recipes exploded at sale (ADR-032 §1, §7, §8, §11).
 * Tax 16% (STANDARD) on every item; prices excluding tax; every number is computed by hand in
 * the comments below. Never change them to make a test pass.
 *
 * Stock items: I1 bought 10 @ 0.500 (5.000), I2 bought 10 @ 2.000 (20.000), purchase invoice.
 * Recipe SAUCE (BOM v1, output 1 PCS): I1 0.2.
 * Recipe DISH (BOM v1, output 1 PCS): SAUCE 1 + I2 0.25, waste 0. Sale price 3.000 (excl. tax).
 * Recipe TEA: no bill of materials at all.
 *
 * R1  Two levels. Sell 4 DISH @ 3.000 (credit):
 *       explosion: SAUCE 4 → I1 4 × 0.2 = 0.8; DISH direct I2 4 × 0.25 = 1.0.
 *       cost: I1 0.8 × 0.500 = 0.400; I2 1.0 × 2.000 = 2.000; line cost 2.400, unit 2.400 ÷ 4 = 0.600.
 *       revenue 4 × 3.000 = 12.000; tax 16% = 1.920; grand 13.920.
 *       Journal: 1103 Dr 13.920 / 4101 Cr 12.000 / 2102 Cr 1.920 / 5101 Dr 2.400 / 1104 Cr 2.400.
 *       Stock after: I1 9.2, I2 9 (no new cost: the average does not move on an OUT).
 *       Cost card of DISH now: I1 0.2 × 0.500 = 0.100 + I2 0.25 × 2.000 = 0.500 → total 0.600, unit 0.600;
 *       sale price 3.000 net, margin 3.000 − 0.600 = 2.400, 80.00%.
 * R2  Return 1 DISH (credit, from R1): revenue 3.000 and tax 0.480 reversed (16% of 3.000); the
 *       customer is credited 3.480. No stock IN (I1 stays 9.2, I2 stays 9), no COGS reversal, the return
 *       line carries no unit cost. Journal: 4102 Dr 3.000 / 2102 Dr 0.480 / 1103 Cr 3.480.
 * R3  TEA has no bill of materials. Sell 2 TEA @ 1.000: preview flags the missing version; the
 *       line posts at cost 0 with recipe_bom_missing, no movement, no COGS.
 *       revenue 2.000, tax 0.320, grand 2.320. Journal: 1103 Dr 2.320 / 4101 Cr 2.000 / 2102 Cr 0.320.
 * After each scenario: stock:verify has no differences and the trial balance is balanced.
 * Real MariaDB (E2E_DB_NAME) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const T = 60_000;
/** The current year: the fiscal year and every document date sit in it, in January (before today). */
const Y = new Date().getUTCFullYear();

let boot: Booted;
let h: ReturnType<typeof kit>;

beforeAll(async () => {
  boot = await bootApi(3736);
  h = kit(boot.base, RUN);
}, 60_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('Golden scenarios R1–R3 — recipes exploded at sale (ADR-032)', () => {
  let token = '';
  let tenantId = '';
  let W = '';
  let I1 = '';
  let I2 = '';
  let SAUCE = '';
  let DISH = '';
  let TEA = '';
  let customer = '';
  let supplier = '';
  let invoiceR1 = '';
  let lineR1 = '';
  let returnR2 = '';

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

  /** A document created as a draft, then posted; returns both responses. */
  async function createAndPost(kind: string, body: object) {
    const created = await h.api().post(`/api/v1/${kind}`).set(h.auth(token)).send(body);
    if (created.status !== 201) throw new Error(`create ${kind} → ${created.status} ${JSON.stringify(created.body)}`);
    const posted = await h.act(token, `${kind}/${created.body.id}/post`);
    return { created, posted };
  }

  it(
    'setup: company, warehouse, items I1 I2 (stock), SAUCE DISH TEA (recipes), parties, I1 and I2 bought',
    async () => {
      const reg = await h
        .api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `GoldenRC ${RUN}`, ownerName: 'Owner', email: `grc-${RUN}@test.dev`, password: PASS });
      expect(reg.status).toBe(201);
      token = reg.body.accessToken;
      const [t] = (await boot.db.query('SELECT id AS tenantId FROM tenants WHERE name = ?', [`GoldenRC ${RUN}`])) as { tenantId: bigint }[];
      tenantId = String(t.tenantId);
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).send({ code: String(Y), startDate: `${Y}-01-01`, endDate: `${Y}-12-31` }), 201, 'fy');
      W = h.ok(await h.api().post('/api/v1/warehouses').set(h.auth(token)).send({ code: 'W', nameAr: 'W' }), 201, 'warehouse').id;
      const pcs = ((await h.get(token, 'units')).body as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
      const tax = ((await h.get(token, 'tax-categories')).body as { id: string; code: string }[]).find((x) => x.code === 'STANDARD')!;
      const item = async (code: string, itemKind?: string, extra: object = {}) =>
        h.ok(
          await h.api()
            .post('/api/v1/items')
            .set(h.auth(token))
            .send({ code, nameAr: code, baseUnitId: pcs, taxCategoryId: tax.id, ...(itemKind ? { itemKind } : {}), ...extra }),
          201,
          `item ${code}`,
        ).id as string;
      I1 = await item('I1');
      I2 = await item('I2');
      SAUCE = await item('SAUCE', 'RECIPE');
      DISH = await item('DISH', 'RECIPE', { salePrice: '3.000', salePriceIncludesTax: false });
      TEA = await item('TEA', 'RECIPE', { salePrice: '1.000', salePriceIncludesTax: false });
      const party = async (code: string, partyType: string) =>
        h.ok(await h.api().post('/api/v1/parties').set(h.auth(token)).send({ code, nameAr: code, partyType }), 201, `party ${code}`).id as string;
      customer = await party('C', 'CUSTOMER');
      supplier = await party('S', 'SUPPLIER');
      const bought = h.ok(
        await h.api().post('/api/v1/purchase-invoices').set(h.auth(token)).send({
          invoiceDate: `${Y}-01-01`,
          supplierId: supplier,
          warehouseId: W,
          paymentType: 'CREDIT',
          lines: [
            { itemId: I1, qty: '10', unitCost: '0.5' },
            { itemId: I2, qty: '10', unitCost: '2' },
          ],
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
    'R1 level 1 and 2: SAUCE = I1 0.2; DISH = SAUCE 1 + I2 0.25 (both ACTIVE, recipes may nest)',
    async () => {
      const sauce = h.ok(
        await h.api().post('/api/v1/boms').set(h.auth(token)).send({ itemId: SAUCE, outputQty: '1', lines: [{ componentItemId: I1, qty: '0.2' }] }),
        201,
        'bom SAUCE',
      );
      h.ok(await h.act(token, `boms/${sauce.id}/activate`), 201, 'activate SAUCE');
      const dish = h.ok(
        await h.api().post('/api/v1/boms').set(h.auth(token)).send({
          itemId: DISH,
          outputQty: '1',
          lines: [
            { componentItemId: SAUCE, qty: '1' },
            { componentItemId: I2, qty: '0.25' },
          ],
        }),
        201,
        'bom DISH',
      );
      h.ok(await h.act(token, `boms/${dish.id}/activate`), 201, 'activate DISH');
      // The cost card of DISH before any sale: I1 0.2 × 0.500 + I2 0.25 × 2.000 = 0.600.
      const card = h.ok(await h.get(token, `boms/${dish.id}/cost`), 200, 'cost card');
      // The API trims trailing zeros of decimal strings, so compare at the stored scale.
      expect(m3(card.totalCost)).toBe('0.600');
      expect(new Decimal(card.unitCost).toFixed(6)).toBe('0.600000');
      expect(m3(card.salePriceNet)).toBe('3.000');
      expect(m3(card.margin)).toBe('2.400');
      expect(new Decimal(card.marginPct).toFixed(2)).toBe('80.00');
      expect(card.zeroCostWarning).toBe(false);
      expect(card.lines.map((l: { qtyBase: string }) => new Decimal(l.qtyBase).toFixed(6))).toEqual(['0.200000', '0.250000']);
      await verified();
    },
    T,
  );

  it(
    'R1 sale: 4 DISH @ 3.000 → components I1 0.8 (0.400) and I2 1.0 (2.000); cost 2.400; revenue 12.000; tax 1.920',
    async () => {
      // The draft shows what the sale will take before it posts (ADR-032 §12).
      const draft = await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
        invoiceDate: `${Y}-01-05`,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: DISH, qty: '4', unitPrice: '3.000' }],
      });
      expect(draft.status).toBe(201);
      invoiceR1 = draft.body.id;
      expect(m3(draft.body.netTotal)).toBe('12.000');
      expect(m3(draft.body.taxTotal)).toBe('1.920');
      expect(m3(draft.body.grandTotal)).toBe('13.920');
      const preview = h.ok(await h.get(token, `sales-invoices/${invoiceR1}/recipe-preview`), 200, 'preview');
      expect(preview.hasWarnings).toBe(false);
      expect(preview.hasShortage).toBe(false);
      expect(preview.lines[0].components.map((c: { qtyBase: string }) => new Decimal(c.qtyBase).toFixed(6))).toEqual(['0.800000', '1.000000']);

      // Post the same draft that the preview read (R2 returns against it).
      const posted = await h.act(token, `sales-invoices/${invoiceR1}/post`);
      expect(posted.status).toBe(201);
      expect(m3(posted.body.costTotal)).toBe('2.400');
      expect(await entryLines(posted.body.journalEntry.id)).toEqual(
        ['1103 Dr 13.920', '4101 Cr 12.000', '2102 Cr 1.920', '5101 Dr 2.400', '1104 Cr 2.400'].sort(),
      );
      const detail = h.ok(await h.get(token, `sales-invoices/${posted.body.id}`), 200, 'invoice');
      const line = detail.lines[0];
      lineR1 = line.id;
      expect(line.recipeBomMissing).toBe(false);
      expect(new Decimal(line.unitCost).toFixed(6)).toBe('0.600000');
      expect(m3(line.costTotal)).toBe('2.400');
      const parts = (line.components as { componentItem: { code: string }; qtyBase: string; totalCost: string }[])
        .map((c) => [c.componentItem.code, new Decimal(c.qtyBase).toFixed(6), m3(c.totalCost)]);
      expect(parts).toEqual([
        ['I1', '0.800000', '0.400'],
        ['I2', '1.000000', '2.000'],
      ]);
      expect(await onHand(I1, W)).toBe('9.200000');
      expect(await onHand(I2, W)).toBe('9.000000');
      expect(await onHand(DISH, W)).toBe('0.000000');
      await verified();
    },
    T,
  );

  it('R2 return of 1 DISH: revenue 3.000 and tax 0.480 reversed; no stock IN, no COGS, no unit cost', async () => {
    const ret = h.ok(
      await h.api().post('/api/v1/sales-returns').set(h.auth(token)).send({
        returnDate: `${Y}-01-06`,
        originalInvoiceId: invoiceR1,
        refundType: 'CREDIT',
        lines: [{ originalLineId: lineR1, qty: '1' }],
      }),
      201,
      'create return',
    );
    returnR2 = ret.id;
    const posted = h.ok(await h.act(token, `sales-returns/${returnR2}/post`), 201, 'post return');
    expect(await entryLines(posted.journalEntryId)).toEqual(['1103 Cr 3.480', '2102 Dr 0.480', '4102 Dr 3.000'].sort());
    expect(await onHand(I1, W)).toBe('9.200000');
    expect(await onHand(I2, W)).toBe('9.000000');
    const rows = (await boot.db.query(
      'SELECT unit_cost AS uc FROM sales_return_lines WHERE tenant_id = ? AND return_id = ?',
      [tenantId, returnR2],
    )) as { uc: string | null }[];
    expect(rows).toEqual([{ uc: null }]);
    await verified();
  });

  it('R3 a recipe with no ACTIVE version: TEA sells at cost 0, flagged, no component, no COGS', async () => {
    const draft = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).send({
        invoiceDate: `${Y}-01-07`,
        customerId: customer,
        warehouseId: W,
        paymentType: 'CREDIT',
        lines: [{ itemId: TEA, qty: '2', unitPrice: '1.000' }],
      }),
      201,
      'draft TEA',
    );
    const preview = h.ok(await h.get(token, `sales-invoices/${draft.id}/recipe-preview`), 200, 'preview TEA');
    expect(preview.hasWarnings).toBe(true);
    expect(preview.lines[0].bomMissing).toBe(true);

    const { posted } = await createAndPost('sales-invoices', {
      invoiceDate: `${Y}-01-07`,
      customerId: customer,
      warehouseId: W,
      paymentType: 'CREDIT',
      lines: [{ itemId: TEA, qty: '2', unitPrice: '1.000' }],
    });
    expect(posted.status).toBe(201);
    expect(m3(posted.body.costTotal)).toBe('0.000');
    expect(await entryLines(posted.body.journalEntry.id)).toEqual(['1103 Dr 2.320', '4101 Cr 2.000', '2102 Cr 0.320'].sort());
    const detail = h.ok(await h.get(token, `sales-invoices/${posted.body.id}`), 200, 'invoice TEA');
    expect(detail.lines[0].recipeBomMissing).toBe(true);
    expect(detail.lines[0].components).toEqual([]);
    await verified();
  });
});
