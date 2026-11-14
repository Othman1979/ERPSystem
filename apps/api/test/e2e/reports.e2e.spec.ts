/**
 * Phase 8 — reports (BUILD_PLAN §17 phase 8 acceptance): every figure of the
 * income statement, balance sheet, tax / sales / purchases summaries and the
 * dashboard is asserted against a small known data set, and against each
 * other (trial balance ↔ statements, yearProfit ↔ income statement,
 * dashboard ↔ summaries / aging). Tenant B sees none of it.
 *
 * Data set (tenant A), fiscal years 2025 and 2026:
 *  2025-01-01 opening entry      Dr bank 5000 / Cr opening equity
 *  2025-02-01 purchase (credit)  I1 100 @ 10 +16%          net 1000 tax 160
 *  2025-03-01 sale (credit, C1)  I1 10 @ 20 +16%           net 200 tax 32 cost 100
 *  2026-03-05 purchase (credit)  I1 90 @ 10 +16%, I2 40 @ 5 Z     net 1100 tax 144
 *  2026-03-10 sale (credit, C1, due 04-10) I1 20 @ 25 +16%, I2 10 @ 8 Z  net 580 tax 80 cost 250
 *  2026-03-15 sale (cash, C2)    I1 5 @ 30 +16%            net 150 tax 24 cost 50
 *  2026-04-10 purchase return    I1 10, I2 4               net 120 tax 16
 *  2026-05-20 sales return of the 03-10 sale: I1 4        net 100 tax 16 cost 40
 *  2026-05-25 stock out (adjustment) I2 2 @ 5              10 → INVENTORY_ADJUSTMENT
 *  2026-06-01 manual entry       Dr rent 300 / Cr bank
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';

const API_PORT = 3202;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `p8-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0).toFixed(3);
/** Today in the company's timezone (Asia/Amman) and its year: the reports' defaults. */
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Amman', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const YEAR = TODAY.slice(0, 4);
const FY_CODE = ['2025', '2026'].includes(YEAR) ? YEAR : null;

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
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      EINVOICE_WORKER: 'off',
    },
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

type Row = Record<string, string | number | boolean | null>;
type Tree = { id: string; code: string; children?: Tree[] };

describe('Phase 8 — reports', () => {
  let token = '';
  let tokenB = '';
  const acc: Record<string, string> = {};
  const id: Record<string, string> = {};

  const get = async (url: string, t = token) => {
    const res = await api().get(url).set(auth(t));
    expect(res.status).toBe(200);
    return res.body;
  };
  const postDoc = async (kind: string, body: object) => {
    const created = await api().post(`/api/v1/${kind}`).set(auth(token)).send(body);
    expect(created.status).toBe(201);
    const posted = await api().post(`/api/v1/${kind}/${created.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);
    return posted.body as { id: string; lines: { id: string; itemId: string }[] };
  };
  const lineOf = (doc: { lines: { id: string; itemId: string }[] }, itemId: string) =>
    doc.lines.find((l) => l.itemId === itemId)!.id;
  const amounts = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, m3(r[k] as string)]));

  // ------------------------------------------------------------------ data

  it('setup: two tenants, two fiscal years, documents', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P8 ${RUN}`, ownerName: 'Owner', email: `p8-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P8 B ${RUN}`, ownerName: 'Owner B', email: `p8b-${RUN}@test.dev`, password: PASS });
    expect(regB.status).toBe(201);
    tokenB = regB.body.accessToken;

    for (const y of ['2025', '2026']) {
      const fy = await api()
        .post('/api/v1/fiscal-years')
        .set(auth(token))
        .send({ code: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
      expect(fy.status).toBe(201);
    }
    const walk = (ns: Tree[]) => ns.forEach((n) => ((acc[n.code] = n.id), n.children && walk(n.children)));
    walk(await get('/api/v1/accounts'));

    const taxes = (await get('/api/v1/tax-categories')) as { id: string; code: string }[];
    id.std = taxes.find((t) => t.code === 'STANDARD')!.id;
    id.zero = taxes.find((t) => t.code === 'ZERO')!.id;
    expect((await api().patch(`/api/v1/tax-categories/${id.std}`).set(auth(token)).send({ einvoiceCode: 'S' })).status).toBe(200);
    expect((await api().patch(`/api/v1/tax-categories/${id.zero}`).set(auth(token)).send({ einvoiceCode: 'Z' })).status).toBe(200);

    id.wh = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'المستودع' })).body.id;
    const pcs = ((await get('/api/v1/units')) as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    const item = async (code: string, extra: object) => {
      const res = await api().post('/api/v1/items').set(auth(token)).send({ code, nameAr: `صنف ${code}`, baseUnitId: pcs, ...extra });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    id.i1 = await item('I1', { minStock: '500' });
    id.i2 = await item('I2', { minStock: '10', taxCategoryId: id.zero });
    id.i3 = await item('I3', { minStock: '5' }); // never moves: no balance row
    const party = async (code: string, partyType: string) => {
      const res = await api().post('/api/v1/parties').set(auth(token)).send({ code, nameAr: `طرف ${code}`, partyType });
      expect(res.status).toBe(201);
      return res.body.id as string;
    };
    id.c1 = await party('C1', 'CUSTOMER');
    id.c2 = await party('C2', 'CUSTOMER');
    id.s1 = await party('S1', 'SUPPLIER');

    // 2025
    const opening = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .set(idem())
      .send({ entryDate: '2025-01-01', description: 'opening', lines: [{ accountId: acc['1102'], debit: '5000' }] });
    expect(opening.status).toBe(201);
    await postDoc('purchase-invoices', {
      invoiceDate: '2025-02-01', supplierId: id.s1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [{ itemId: id.i1, qty: '100', unitCost: '10' }],
    });
    await postDoc('sales-invoices', {
      invoiceDate: '2025-03-01', customerId: id.c1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [{ itemId: id.i1, qty: '10', unitPrice: '20' }],
    });

    // 2026
    const pi = await postDoc('purchase-invoices', {
      invoiceDate: '2026-03-05', supplierId: id.s1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [
        { itemId: id.i1, qty: '90', unitCost: '10' },
        { itemId: id.i2, qty: '40', unitCost: '5' },
      ],
    });
    const si = await postDoc('sales-invoices', {
      invoiceDate: '2026-03-10', dueDate: '2026-04-10', customerId: id.c1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [
        { itemId: id.i1, qty: '20', unitPrice: '25' },
        { itemId: id.i2, qty: '10', unitPrice: '8' },
      ],
    });
    await postDoc('sales-invoices', {
      invoiceDate: '2026-03-15', customerId: id.c2, warehouseId: id.wh, paymentType: 'CASH', cashAccountId: acc['1101'],
      lines: [{ itemId: id.i1, qty: '5', unitPrice: '30' }],
    });
    await postDoc('purchase-returns', {
      returnDate: '2026-04-10', originalInvoiceId: pi.id, warehouseId: id.wh, refundType: 'CREDIT',
      lines: [
        { originalLineId: lineOf(pi, id.i1), qty: '10' },
        { originalLineId: lineOf(pi, id.i2), qty: '4' },
      ],
    });
    await postDoc('sales-returns', {
      returnDate: '2026-05-20', originalInvoiceId: si.id, refundType: 'CREDIT',
      lines: [{ originalLineId: lineOf(si, id.i1), qty: '4' }],
    });
    await postDoc('stock-adjustments', {
      adjustmentDate: '2026-05-25', adjustmentType: 'OUT', warehouseId: id.wh,
      lines: [{ itemId: id.i2, qty: '2' }],
    });
    const je = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2026-06-01',
        description: 'rent',
        lines: [
          { accountId: acc['5202'], debit: '300' },
          { accountId: acc['1102'], credit: '300' },
        ],
      });
    expect(je.status).toBe(201);
    expect((await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);

    // Books and stock are consistent before any report is read.
    expect((await get('/api/v1/reports/trial-balance')).balanced).toBe(true);
    expect((await get('/api/v1/stock/verify')).mismatches).toEqual([]);
  });

  // --------------------------------------------------------- income statement

  it('income statement 2026, account tree with group subtotals', async () => {
    // Default period = the fiscal year containing today (the calendar year without one).
    const def = await get('/api/v1/reports/income-statement');
    expect([def.from, def.to, def.fiscalYear?.code ?? null]).toEqual([`${YEAR}-01-01`, `${YEAR}-12-31`, FY_CODE]);

    const is = await get('/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31');
    expect(is.fiscalYear.code).toBe('2026');

    const rev = Object.fromEntries((is.revenue.rows as Row[]).map((r) => [r.code, [m3(r.amount as string), r.isGroup, r.depth]]));
    expect(rev).toEqual({
      '4': ['630.000', true, 0],
      '4101': ['730.000', false, 1],
      '4102': ['-100.000', false, 1], // contra revenue: Cr − Dr is negative
    });
    expect(is.revenue.total).toBe('630.000');
    expect((is.costOfSales.rows as Row[]).map((r) => [r.kind, r.code, r.amount])).toEqual([
      ['COGS', '5101', '260.000'],
      ['INVENTORY_ADJUSTMENT', '5102', '10.000'],
    ]);
    expect(is.costOfSales.total).toBe('270.000');
    expect(is.grossProfit).toBe('360.000');
    expect((is.expenses.rows as Row[]).map((r) => [r.code, r.amount, r.isGroup])).toEqual([
      ['5', '300.000', true],
      ['52', '300.000', true],
      ['5202', '300.000', false],
    ]);
    expect(is.expenses.total).toBe('300.000');
    expect(is.netProfit).toBe('60.000');
  });

  it('income statement totals equal the trial balance of the same period', async () => {
    const q = 'from=2026-01-01&to=2026-12-31';
    const [is, tb] = await Promise.all([
      get(`/api/v1/reports/income-statement?${q}`),
      get(`/api/v1/reports/trial-balance?${q}`),
    ]);
    const rows = tb.rows as { accountType: string; code: string; totalDebit: string; totalCredit: string }[];
    const crMinusDr = (types: string[]) =>
      rows.filter((r) => types.includes(r.accountType)).reduce((s, r) => s.plus(r.totalCredit).minus(r.totalDebit), new Decimal(0));
    expect(m3(crMinusDr(['REVENUE']))).toBe(is.revenue.total);
    expect(m3(crMinusDr(['EXPENSE']).neg())).toBe(m3(new Decimal(is.costOfSales.total).plus(is.expenses.total)));
    expect(m3(crMinusDr(['REVENUE', 'EXPENSE']))).toBe(is.netProfit);
    expect(m3(new Decimal(is.grossProfit).minus(is.expenses.total))).toBe(is.netProfit);

    // 2025: sale 200 − cost 100.
    const is25 = await get('/api/v1/reports/income-statement?from=2025-01-01&to=2025-12-31');
    expect([is25.revenue.total, is25.costOfSales.total, is25.netProfit]).toEqual(['200.000', '100.000', '100.000']);
    // Only `to` given → from = start of its fiscal year.
    const q1 = await get('/api/v1/reports/income-statement?to=2026-03-31');
    expect([q1.from, q1.netProfit]).toEqual(['2026-01-01', '430.000']);
    expect((await api().get('/api/v1/reports/income-statement?from=2026-02-01&to=2026-01-01').set(auth(token))).status).toBe(400);
  });

  // ------------------------------------------------------------ balance sheet

  it('balance sheet is balanced, with prior years and the year profit', async () => {
    const bs = await get('/api/v1/reports/balance-sheet?asOf=2026-12-31');
    expect(bs.yearStart).toBe('2026-01-01');
    const leaves = (rows: Row[]) => Object.fromEntries(rows.filter((r) => !r.isGroup).map((r) => [r.code, r.amount]));
    expect(leaves(bs.assets.rows)).toEqual({
      '1101': '174.000',
      '1102': '4700.000',
      '1103': '776.000',
      '1104': '1610.000',
      '1105': '288.000',
    });
    expect(bs.assets.total).toBe('7548.000');
    expect(leaves(bs.liabilities.rows)).toEqual({ '2101': '2268.000', '2102': '120.000' });
    expect(bs.liabilities.total).toBe('2388.000');
    expect(leaves(bs.equity.rows)).toEqual({ '3103': '5000.000' });
    expect(bs.equity.total).toBe('5000.000');
    expect(bs.priorYears).toBe('100.000');
    expect(bs.yearProfit).toBe('60.000');
    expect(bs.totalLiabilitiesAndEquity).toBe('7548.000');
    expect(bs.difference).toBe('0.000');
    expect(bs.balanced).toBe(true);

    // Inventory account = stock valuation (Σ item_costs.total_value).
    expect((await get('/api/v1/stock/valuation')).totalValue).toBe('1610.000');

    // End of 2025: nothing before its fiscal year; its profit is the year's.
    const bs25 = await get('/api/v1/reports/balance-sheet?asOf=2025-12-31');
    expect([bs25.assets.total, bs25.liabilities.total, bs25.priorYears, bs25.yearProfit, bs25.balanced]).toEqual([
      '6292.000',
      '1192.000',
      '0.000',
      '100.000',
      true,
    ]);
  });

  it('yearProfit equals the income statement net from the year start to asOf', async () => {
    for (const asOf of ['2026-03-31', '2026-05-20', '2026-12-31']) {
      const [bs, is] = await Promise.all([
        get(`/api/v1/reports/balance-sheet?asOf=${asOf}`),
        get(`/api/v1/reports/income-statement?from=2026-01-01&to=${asOf}`),
      ]);
      expect(bs.yearProfit).toBe(is.netProfit);
      expect(bs.priorYears).toBe('100.000');
      expect(bs.balanced).toBe(true);
    }
    // Default asOf = today in the company's timezone.
    const today = await get('/api/v1/reports/balance-sheet');
    expect([today.asOf, today.yearStart, today.fiscalYear?.code ?? null, today.balanced]).toEqual([TODAY, `${YEAR}-01-01`, FY_CODE, true]);
  });

  // -------------------------------------------------------------- tax summary

  it('tax summary: output − input per category and rate; ledger difference 0', async () => {
    const tax = await get('/api/v1/reports/tax-summary?from=2026-01-01&to=2026-12-31');
    const keys = [
      'salesBase', 'salesTax', 'salesReturnsBase', 'salesReturnsTax', 'outputBase', 'outputTax',
      'purchasesBase', 'purchasesTax', 'purchaseReturnsBase', 'purchaseReturnsTax', 'inputBase', 'inputTax', 'payable',
    ];
    const rows = tax.rows as Row[];
    expect(rows.map((r) => [r.code, m3(r.rate as string), r.einvoiceCode])).toEqual([
      ['STANDARD', '16.000', 'S'],
      ['ZERO', '0.000', 'Z'],
    ]);
    expect(amounts(rows[0], keys)).toEqual({
      salesBase: '650.000', salesTax: '104.000', salesReturnsBase: '100.000', salesReturnsTax: '16.000',
      outputBase: '550.000', outputTax: '88.000',
      purchasesBase: '900.000', purchasesTax: '144.000', purchaseReturnsBase: '100.000', purchaseReturnsTax: '16.000',
      inputBase: '800.000', inputTax: '128.000', payable: '-40.000',
    });
    expect(amounts(rows[1], keys)).toEqual({
      salesBase: '80.000', salesTax: '0.000', salesReturnsBase: '0.000', salesReturnsTax: '0.000',
      outputBase: '80.000', outputTax: '0.000',
      purchasesBase: '200.000', purchasesTax: '0.000', purchaseReturnsBase: '20.000', purchaseReturnsTax: '0.000',
      inputBase: '180.000', inputTax: '0.000', payable: '0.000',
    });
    expect(amounts(tax.totals, ['outputBase', 'outputTax', 'inputBase', 'inputTax', 'payable'])).toEqual({
      outputBase: '630.000', outputTax: '88.000', inputBase: '980.000', inputTax: '128.000', payable: '-40.000',
    });
    expect(tax.ledger).toEqual({ output: '88.000', input: '128.000' });
    expect(tax.ledgerDifference).toEqual({ output: '0.000', input: '0.000' });

    // The trial balance's tax accounts moved by the same amounts.
    const tb = await get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31');
    const tbRow = (code: string) => (tb.rows as { code: string; balance: string }[]).find((r) => r.code === code)!;
    expect(m3(tbRow('2102').balance)).toBe('88.000');
    expect(m3(tbRow('1105').balance)).toBe('128.000');
  });

  it('tax summary counts the sales return in its own month', async () => {
    const march = await get('/api/v1/reports/tax-summary?from=2026-03-01&to=2026-03-31');
    const mStd = (march.rows as Row[]).find((r) => r.code === 'STANDARD')!;
    expect(amounts(mStd, ['outputBase', 'outputTax', 'inputBase', 'inputTax', 'payable'])).toEqual({
      outputBase: '650.000', outputTax: '104.000', inputBase: '900.000', inputTax: '144.000', payable: '-40.000',
    });
    const may = await get('/api/v1/reports/tax-summary?from=2026-05-01&to=2026-05-31');
    expect((may.rows as Row[]).map((r) => [r.code, m3(r.outputBase as string), m3(r.outputTax as string), m3(r.payable as string)])).toEqual([
      ['STANDARD', '-100.000', '-16.000', '-16.000'],
    ]);
    expect(may.ledgerDifference).toEqual({ output: '0.000', input: '0.000' });
    const april = await get('/api/v1/reports/tax-summary?from=2026-04-01&to=2026-04-30');
    expect(april.totals.inputTax).toBe('-16.000');
    expect(april.ledgerDifference).toEqual({ output: '0.000', input: '0.000' });
  });

  // --------------------------------------------------- sales / purchases summary

  it('sales summary per month, day, customer and item = invoices − returns', async () => {
    const q = 'from=2026-01-01&to=2026-12-31';
    const cols = ['net', 'tax', 'grand', 'cost', 'margin'];
    const line = (r: Row) => [r.key, r.invoiceCount, r.returnCount, ...cols.map((c) => m3(r[c] as string))];

    const month = await get(`/api/v1/reports/sales-summary?${q}&groupBy=month`);
    expect((month.rows as Row[]).map(line)).toEqual([
      ['2026-03', 2, 0, '730.000', '104.000', '834.000', '300.000', '430.000'],
      ['2026-05', 0, 1, '-100.000', '-16.000', '-116.000', '-40.000', '-60.000'],
    ]);
    const totals = ['630.000', '88.000', '718.000', '260.000', '370.000'];
    expect(line({ key: 'T', ...month.totals })).toEqual(['T', 2, 1, ...totals]);

    const day = await get(`/api/v1/reports/sales-summary?${q}&groupBy=day`);
    expect((day.rows as Row[]).map(line)).toEqual([
      ['2026-03-10', 1, 0, '580.000', '80.000', '660.000', '250.000', '330.000'],
      ['2026-03-15', 1, 0, '150.000', '24.000', '174.000', '50.000', '100.000'],
      ['2026-05-20', 0, 1, '-100.000', '-16.000', '-116.000', '-40.000', '-60.000'],
    ]);
    expect(line({ key: 'T', ...day.totals })).toEqual(['T', 2, 1, ...totals]);

    const customer = await get(`/api/v1/reports/sales-summary?${q}&groupBy=customer`);
    expect((customer.rows as Row[]).map((r) => [r.code, ...line(r).slice(1)])).toEqual([
      ['C1', 1, 1, '480.000', '64.000', '544.000', '210.000', '270.000'],
      ['C2', 1, 0, '150.000', '24.000', '174.000', '50.000', '100.000'],
    ]);

    const item = await get(`/api/v1/reports/sales-summary?${q}&groupBy=item`);
    expect((item.rows as Row[]).map((r) => [r.code, m3(r.qty as string), ...cols.map((c) => m3(r[c] as string))])).toEqual([
      ['I1', '21.000', '550.000', '88.000', '638.000', '210.000', '340.000'],
      ['I2', '10.000', '80.000', '0.000', '80.000', '50.000', '30.000'],
    ]);
    expect(cols.map((c) => m3(item.totals[c]))).toEqual(totals);
    expect(item.totals.invoiceCount).toBeNull();

    // Same documents as the books: net = revenue, cost = the COGS line.
    const is = await get(`/api/v1/reports/income-statement?${q}`);
    expect(month.totals.net).toBe(is.revenue.total);
    expect(month.totals.cost).toBe(is.costOfSales.rows[0].amount);

    // Against the posted documents themselves.
    // One page of 100 holds every posted invoice of this tenant (ADR-022).
    const page = (await get('/api/v1/sales-invoices?status=POSTED&pageSize=100')) as {
      total: number;
      items: { invoiceDate: string; netTotal: string; taxTotal: string; grandTotal: string }[];
    };
    expect(page.items.length).toBe(page.total);
    const invoices = page.items;
    const in2026 = invoices.filter((i) => i.invoiceDate.startsWith('2026'));
    const returns = (await get('/api/v1/sales-returns?status=POSTED')) as { netTotal: string; grandTotal: string }[];
    expect(m3(in2026.reduce((s, i) => s.plus(i.netTotal), new Decimal(0)).minus(returns.reduce((s, r) => s.plus(r.netTotal), new Decimal(0))))).toBe('630.000');
    expect(m3(in2026.reduce((s, i) => s.plus(i.grandTotal), new Decimal(0)).minus(returns.reduce((s, r) => s.plus(r.grandTotal), new Decimal(0))))).toBe('718.000');
  });

  it('purchases summary per supplier, month, day and item', async () => {
    const q = 'from=2026-01-01&to=2026-12-31';
    const cols = ['net', 'tax', 'grand'];
    const line = (r: Row) => [r.key, r.invoiceCount, r.returnCount, ...cols.map((c) => m3(r[c] as string))];

    const supplier = await get(`/api/v1/reports/purchases-summary?${q}&groupBy=supplier`);
    expect((supplier.rows as Row[]).map((r) => [r.code, ...line(r).slice(1)])).toEqual([['S1', 1, 1, '980.000', '128.000', '1108.000']]);
    expect(supplier.rows[0].cost).toBeUndefined();

    const month = await get(`/api/v1/reports/purchases-summary?${q}&groupBy=month`);
    expect((month.rows as Row[]).map(line)).toEqual([
      ['2026-03', 1, 0, '1100.000', '144.000', '1244.000'],
      ['2026-04', 0, 1, '-120.000', '-16.000', '-136.000'],
    ]);
    const day = await get(`/api/v1/reports/purchases-summary?${q}&groupBy=day`);
    expect((day.rows as Row[]).map((r) => r.key)).toEqual(['2026-03-05', '2026-04-10']);
    expect(line({ key: 'T', ...day.totals })).toEqual(['T', 1, 1, '980.000', '128.000', '1108.000']);

    const item = await get(`/api/v1/reports/purchases-summary?${q}&groupBy=item`);
    expect((item.rows as Row[]).map((r) => [r.code, m3(r.qty as string), ...cols.map((c) => m3(r[c] as string))])).toEqual([
      ['I1', '80.000', '800.000', '128.000', '928.000'],
      ['I2', '36.000', '180.000', '0.000', '180.000'],
    ]);
    // Default groupBy is month, default period the current fiscal year.
    const def = await get('/api/v1/reports/purchases-summary');
    expect([def.groupBy, def.from, def.to]).toEqual(['month', `${YEAR}-01-01`, `${YEAR}-12-31`]);
    expect((await api().get('/api/v1/reports/purchases-summary?groupBy=customer').set(auth(token))).status).toBe(400);
  });

  // ---------------------------------------------------------------- dashboard

  it('dashboard figures equal the reports they come from', async () => {
    const d = await get('/api/v1/dashboard/summary?date=2026-03-15');
    expect(d.date).toBe('2026-03-15');
    expect(d.salesToday).toEqual({ from: '2026-03-15', to: '2026-03-15', count: 1, returnCount: 0, net: '150.000', tax: '24.000', grand: '174.000' });
    expect(d.salesMonth).toEqual({ from: '2026-03-01', to: '2026-03-15', count: 2, returnCount: 0, net: '730.000', tax: '104.000', grand: '834.000' });

    const month = await get('/api/v1/reports/sales-summary?from=2026-03-01&to=2026-03-15&groupBy=day');
    expect([d.salesMonth.net, d.salesMonth.tax, d.salesMonth.grand]).toEqual([month.totals.net, month.totals.tax, month.totals.grand]);

    // Receivables: 2025 invoice 232 (overdue) + the 03-10 invoice 660 (due 04-10).
    expect(d.receivables).toEqual({ total: '892.000', overdue: '232.000' });
    const aging = await get('/api/v1/reports/aging?partyType=CUSTOMER&asOf=2026-03-15');
    expect(d.receivables.total).toBe(aging.totals.balance);
    expect(m3(new Decimal(aging.totals.total).minus(aging.totals.notDue))).toBe(d.receivables.overdue);

    // I1 149 < 500, I3 never moved (0 < 5); I2 24 ≥ 10.
    expect(d.belowMinimum.count).toBe(2);
    expect((d.belowMinimum.items as Row[]).map((r) => [r.code, m3(r.qtyOnHand as string), m3(r.minStock as string), m3(r.shortage as string)])).toEqual([
      ['I1', '149.000', '500.000', '351.000'],
      ['I3', '0.000', '5.000', '5.000'],
    ]);

    // A return day: the dashboard nets it.
    const r = await get('/api/v1/dashboard/summary?date=2026-05-20');
    expect(r.salesToday).toMatchObject({ count: 0, returnCount: 1, net: '-100.000', tax: '-16.000', grand: '-116.000' });
    expect(r.receivables.total).toBe('776.000');

    // Default date = today in the company's timezone (Asia/Amman).
    expect((await get('/api/v1/dashboard/summary')).date).toBe(TODAY);
  });

  // ------------------------------------------------------- existing reports' fixes

  it('stock: low stock compares the item total, item ledger has an opening balance', async () => {
    // A second warehouse holds 600 of I1: its total (749) is no longer below 500.
    // The TRIAL plan allows one warehouse, so the second is inserted directly (as in phase 4).
    const [{ tenantId, companyId }] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`P8 ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const now = new Date();
    const ins = await db.query(
      'INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [tenantId, companyId, 'W2', 'مستودع 2', now, now],
    );
    const w2 = String((ins as { insertId: bigint }).insertId);
    await postDoc('stock-adjustments', {
      adjustmentDate: '2026-06-02', adjustmentType: 'IN', warehouseId: w2,
      lines: [{ itemId: id.i1, qty: '600', unitCost: '10' }],
    });
    const low = (await get(`/api/v1/stock/balances?lowStock=true&warehouseId=${id.wh}`)) as { itemCode: string }[];
    expect(low.map((r) => r.itemCode)).toEqual([]);
    const all = (await get('/api/v1/stock/balances?warehouseId=&itemId=&lowStock=')) as { itemCode: string }[];
    expect(all.length).toBe(3); // I1 × 2 warehouses, I2
    expect((await get('/api/v1/dashboard/summary?date=2026-06-02')).belowMinimum.count).toBe(1); // I3 only

    const ledger = await get(`/api/v1/stock/items/${id.i1}/ledger?warehouseId=${id.wh}&from=2026-01-01&to=2026-12-31`);
    expect(ledger.opening).toEqual({ qty: '90', value: '900.000' }); // 2025: 100 in − 10 out at 10
    expect(ledger.rows.length).toBe(5);
    const none = await get(`/api/v1/stock/items/${id.i1}/ledger`);
    expect(none.opening).toEqual({ qty: '0', value: '0.000' });

    // General ledger / party statement opening balances (DB aggregates).
    const gl = await get(`/api/v1/reports/general-ledger?accountId=${acc['1103']}&from=2026-01-01`);
    expect(m3(gl.openingBalance)).toBe('232.000');
    expect(m3(gl.closingBalance)).toBe('776.000');
    const ps = await get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${id.c1}&from=2026-01-01`);
    expect(m3(ps.openingBalance)).toBe('232.000');
    expect(m3(ps.closingBalance)).toBe('776.000');
  });

  // --------------------------------------------------------------- isolation

  it('tenant B sees nothing of A, and gets 404 for A ids', async () => {
    const is = await get('/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31', tokenB);
    expect([is.revenue.rows, is.revenue.total, is.netProfit]).toEqual([[], '0.000', '0.000']);
    const bs = await get('/api/v1/reports/balance-sheet?asOf=2026-12-31', tokenB);
    expect([bs.assets.rows, bs.assets.total, bs.priorYears, bs.balanced]).toEqual([[], '0.000', '0.000', true]);
    const tax = await get('/api/v1/reports/tax-summary?from=2026-01-01&to=2026-12-31', tokenB);
    expect([tax.rows, tax.totals.payable, tax.ledgerDifference]).toEqual([[], '0.000', { output: '0.000', input: '0.000' }]);
    for (const url of ['sales-summary', 'purchases-summary']) {
      const s = await get(`/api/v1/reports/${url}?from=2026-01-01&to=2026-12-31&groupBy=item`, tokenB);
      expect([s.rows, s.totals.net]).toEqual([[], '0.000']);
    }
    const d = await get('/api/v1/dashboard/summary?date=2026-03-15', tokenB);
    expect([d.salesMonth.count, d.salesMonth.net, d.receivables.total, d.belowMinimum.count]).toEqual([0, '0.000', '0.000', 0]);

    expect((await api().get(`/api/v1/reports/general-ledger?accountId=${acc['1103']}`).set(auth(tokenB))).status).toBe(404);
    expect((await api().get(`/api/v1/stock/items/${id.i1}/ledger`).set(auth(tokenB))).status).toBe(404);
    const ps = await get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${id.c1}`, tokenB);
    expect([ps.rows, ps.closingBalance]).toEqual([[], '0.000']); // LEDGER-24: 3 decimals
    expect(await get('/api/v1/stock/valuation', tokenB)).toEqual({ rows: [], totalValue: '0.000' });
  });
});
