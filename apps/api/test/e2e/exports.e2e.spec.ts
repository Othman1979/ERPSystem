/**
 * Phase 8 — report exports (BUILD_PLAN §15 "?format=json|pdf|xlsx"): every
 * report answers format=pdf with a PDF and format=xlsx with a workbook whose
 * sheet is right-to-left in Arabic (left-to-right in English) and whose
 * numeric cells are exactly the JSON's figures, in order. Above the PDF row
 * limit (REPORT_PDF_MAX_ROWS, set low here) the answer is 413 REPORT_TOO_LARGE.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import ExcelJS from 'exceljs';
import request from 'supertest';

const API_PORT = 3203;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const PDF_MAX_ROWS = 30;

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `p8x-${RUN}-${Math.random().toString(36).slice(2)}` });

/** Collects a binary body (PDF / XLSX) into a Buffer. */
function binary(res: unknown, cb: (err: Error | null, body: Buffer) => void) {
  const stream = res as NodeJS.ReadableStream; // superagent hands the raw response stream
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

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
      REPORT_PDF_MAX_ROWS: String(PDF_MAX_ROWS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr?.on('data', (d) => process.stderr.write(`[api] ${d}`));
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- report JSON of many shapes
type Tree = { id: string; code: string; children?: Tree[] };

/** Every number cell of the first sheet, row by row, as decimal strings. */
async function sheetNumbers(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const nums: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => void (typeof cell.value === 'number' && nums.push(new Decimal(cell.value).toString()))));
  return { nums, rtl: Boolean(ws.views?.[0]?.rightToLeft) };
}

/** JSON figures in export order; '' / null / undefined are empty cells, not numbers. */
const n = (...vs: unknown[]) =>
  vs.filter((v) => v !== '' && v !== null && v !== undefined).map((v) => new Decimal(String(v)).toString());
/** Debit / credit cells are left empty when zero. */
const nz = (v: string) => (new Decimal(v).isZero() ? '' : v);

describe('Phase 8 — report exports', () => {
  let token = '';
  const acc: Record<string, string> = {};
  const id: Record<string, string> = {};

  const json = async (url: string) => {
    const res = await api().get(url).set(auth(token));
    expect(res.status).toBe(200);
    return res.body as J;
  };
  const file = (url: string) => api().get(url).set(auth(token)).buffer(true).parse(binary);
  const postDoc = async (kind: string, body: object) => {
    const created = await api().post(`/api/v1/${kind}`).set(auth(token)).send(body);
    expect(created.status).toBe(201);
    const posted = await api().post(`/api/v1/${kind}/${created.body.id}/post`).set(auth(token)).set(idem());
    expect(posted.status).toBe(201);
    return posted.body as { id: string; lines: { id: string }[] };
  };

  it('setup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `P8X ${RUN}`, ownerName: 'Owner', email: `p8x-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;
    expect(
      (await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' }))
        .status,
    ).toBe(201);
    const walk = (ns: Tree[]) => ns.forEach((x) => ((acc[x.code] = x.id), x.children && walk(x.children)));
    walk((await json('/api/v1/accounts')) as unknown as Tree[]);
    id.wh = (await api().post('/api/v1/warehouses').set(auth(token)).send({ code: 'W', nameAr: 'المستودع' })).body.id;
    const pcs = ((await json('/api/v1/units')) as unknown as { id: string; code: string }[]).find((u) => u.code === 'PCS')!.id;
    id.item = (await api().post('/api/v1/items').set(auth(token)).send({ code: 'I1', nameAr: 'صنف', baseUnitId: pcs, minStock: '100' })).body.id;
    id.c1 = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'C1', nameAr: 'عميل', partyType: 'CUSTOMER' })).body.id;
    id.s1 = (await api().post('/api/v1/parties').set(auth(token)).send({ code: 'S1', nameAr: 'مورد', partyType: 'SUPPLIER' })).body.id;

    await postDoc('purchase-invoices', {
      invoiceDate: '2026-03-05', supplierId: id.s1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [{ itemId: id.item, qty: '50', unitCost: '10' }],
    });
    const si = await postDoc('sales-invoices', {
      invoiceDate: '2026-03-10', customerId: id.c1, warehouseId: id.wh, paymentType: 'CREDIT',
      lines: [{ itemId: id.item, qty: '10', unitPrice: '25.5' }],
    });
    await postDoc('sales-returns', {
      returnDate: '2026-04-10', originalInvoiceId: si.id, refundType: 'CREDIT',
      lines: [{ originalLineId: si.lines[0].id, qty: '2' }],
    });
    // 40 one-dinar expense lines: a general ledger longer than the PDF limit.
    const je = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2026-05-01',
        description: 'many lines',
        lines: [
          ...Array.from({ length: PDF_MAX_ROWS + 10 }, (_, i) => ({ accountId: acc['5204'], debit: '1', description: `l${i}` })),
          { accountId: acc['1102'], credit: String(PDF_MAX_ROWS + 10) },
        ],
      });
    expect(je.status).toBe(201);
    expect((await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem())).status).toBe(201);
  });

  /** Each report: its URL and the figures its JSON puts in the sheet, in order. */
  const reports: { name: string; url: () => string; expected: (d: J) => string[] }[] = [
    {
      name: 'trial balance',
      url: () => '/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31',
      expected: (d) => [
        ...d.rows.flatMap((r: J) => n(r.totalDebit, r.totalCredit, r.balance)),
        ...n(d.totals.debit, d.totals.credit),
      ],
    },
    {
      name: 'general ledger',
      url: () => `/api/v1/reports/general-ledger?accountId=${acc['1103']}&from=2026-03-01`,
      expected: (d) => [
        ...n(d.openingBalance),
        ...d.rows.flatMap((r: J) => n(nz(r.debit), nz(r.credit), r.balance)),
        ...n(
          d.rows.reduce((s: Decimal, r: J) => s.plus(r.debit), new Decimal(0)),
          d.rows.reduce((s: Decimal, r: J) => s.plus(r.credit), new Decimal(0)),
          d.closingBalance,
        ),
      ],
    },
    {
      name: 'party statement',
      url: () => `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${id.c1}`,
      expected: (d) => [
        ...n(d.openingBalance),
        ...d.rows.flatMap((r: J) => n(nz(r.debit), nz(r.credit), r.balance)),
        ...n(d.totalDebit, d.totalCredit, d.closingBalance),
      ],
    },
    {
      name: 'aging',
      url: () => '/api/v1/reports/aging?partyType=CUSTOMER&asOf=2026-06-30',
      expected: (d) =>
        [...d.rows, d.totals].flatMap((r: J) =>
          n(r.notDue, r.d1_30, r.d31_60, r.d61_90, r.d90plus, r.total, r.unapplied, r.balance),
        ),
    },
    {
      name: 'stock balances',
      url: () => '/api/v1/stock/balances',
      expected: (d) => (d as unknown as J[]).flatMap((r) => n(r.qtyOnHand, r.minStock)),
    },
    {
      name: 'stock valuation',
      url: () => '/api/v1/stock/valuation',
      expected: (d) => [...d.rows.flatMap((r: J) => n(r.qty, r.avgCost, r.value)), ...n(d.totalValue)],
    },
    {
      name: 'item ledger',
      url: () => `/api/v1/stock/items/${id.item}/ledger?from=2026-03-06`,
      expected: (d) => [
        ...n(d.opening.value, d.opening.qty),
        ...d.rows.flatMap((r: J) => n(r.qtyIn, r.qtyOut, r.unitCost, r.totalCost, r.balanceQtyAfter)),
        ...n(d.totals.qtyIn, d.totals.qtyOut),
      ],
    },
    {
      name: 'income statement',
      url: () => '/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31',
      expected: (d) => [
        ...d.revenue.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.revenue.total),
        ...d.costOfSales.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.costOfSales.total, d.grossProfit),
        ...d.expenses.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.expenses.total, d.netProfit),
      ],
    },
    {
      name: 'balance sheet',
      url: () => '/api/v1/reports/balance-sheet?asOf=2026-12-31',
      expected: (d) => [
        ...d.assets.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.assets.total),
        ...d.liabilities.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.liabilities.total),
        ...d.equity.rows.flatMap((r: J) => n(r.amount)),
        ...n(d.priorYears, d.yearProfit, new Decimal(d.equity.total).plus(d.priorYears).plus(d.yearProfit), d.totalLiabilitiesAndEquity),
      ],
    },
    {
      name: 'tax summary',
      url: () => '/api/v1/reports/tax-summary?from=2026-01-01&to=2026-12-31',
      expected: (d) => [...d.rows, d.totals].flatMap((r: J) => n(r.outputBase, r.outputTax, r.inputBase, r.inputTax, r.payable)),
    },
    {
      name: 'sales summary by month',
      url: () => '/api/v1/reports/sales-summary?from=2026-01-01&to=2026-12-31&groupBy=month',
      expected: (d) =>
        [...d.rows, d.totals].flatMap((r: J) => n(r.invoiceCount, r.returnCount, r.net, r.tax, r.grand, r.cost, r.margin)),
    },
    {
      name: 'sales summary by item',
      url: () => '/api/v1/reports/sales-summary?from=2026-01-01&to=2026-12-31&groupBy=item',
      expected: (d) => [...d.rows, d.totals].flatMap((r: J) => n(r.qty, r.net, r.tax, r.grand, r.cost, r.margin)),
    },
    {
      name: 'purchases summary by supplier',
      url: () => '/api/v1/reports/purchases-summary?from=2026-01-01&to=2026-12-31&groupBy=supplier',
      expected: (d) => [...d.rows, d.totals].flatMap((r: J) => n(r.invoiceCount, r.returnCount, r.net, r.tax, r.grand)),
    },
  ];

  const withFormat = (url: string, q: string) => `${url}${url.includes('?') ? '&' : '?'}${q}`;

  it.each(reports.map((r) => [r.name, r] as const))('%s: format=pdf is a PDF', async (_name, r) => {
    const res = await file(withFormat(r.url(), 'format=pdf'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+\.pdf"$/);
    expect((res.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it.each(reports.map((r) => [r.name, r] as const))('%s: format=xlsx is RTL with the JSON figures', async (_name, r) => {
    const data = await json(r.url());
    const res = await file(withFormat(r.url(), 'format=xlsx&lang=ar'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const sheet = await sheetNumbers(res.body as Buffer);
    expect(sheet.rtl).toBe(true);
    const expected = r.expected(data);
    expect(expected.length).toBeGreaterThan(0);
    expect(sheet.nums).toEqual(expected);
  });

  it('lang=en gives a left-to-right sheet and an English PDF', async () => {
    const xlsx = await file('/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31&format=xlsx&lang=en');
    expect(xlsx.status).toBe(200);
    expect((await sheetNumbers(xlsx.body as Buffer)).rtl).toBe(false);
    const pdf = await file('/api/v1/reports/balance-sheet?asOf=2026-12-31&format=pdf&lang=en');
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('format=json (and no format) is the JSON unchanged; bad format / lang are 400', async () => {
    const plain = await json('/api/v1/reports/trial-balance');
    expect(await json('/api/v1/reports/trial-balance?format=json&lang=en')).toEqual(plain);
    expect((await api().get('/api/v1/reports/trial-balance?format=csv').set(auth(token))).status).toBe(400);
    expect((await api().get('/api/v1/reports/tax-summary?lang=fr').set(auth(token))).status).toBe(400);
  });

  it('a PDF over the row limit is 413 REPORT_TOO_LARGE; the XLSX still works', async () => {
    const url = `/api/v1/reports/general-ledger?accountId=${acc['5204']}`;
    expect((await json(url)).rows.length).toBe(PDF_MAX_ROWS + 10);
    const pdf = await file(`${url}&format=pdf`);
    expect(pdf.status).toBe(413);
    const err = JSON.parse((pdf.body as Buffer).toString('utf8')) as { error: { code: string; details: { limit: number } } };
    expect(err.error.code).toBe('REPORT_TOO_LARGE');
    expect(err.error.details.limit).toBe(PDF_MAX_ROWS);
    const xlsx = await file(`${url}&format=xlsx`);
    expect(xlsx.status).toBe(200);
    expect((await sheetNumbers(xlsx.body as Buffer)).nums.length).toBeGreaterThan(PDF_MAX_ROWS);
  });
});
