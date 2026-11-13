/**
 * Ledger review fixes of 2026-11-13 (LEDGER-03/04/05/09/11/14/19/23/24/25/26/27):
 * the chart template's English names and normal balances, sub-account rules,
 * group / postable guards, account deactivation guards, control-account
 * mappings, fiscal-year rules, report date ranges and amount formats, the
 * general-ledger row cap, the PDF / XLSX exports, and tenant isolation.
 * Real MariaDB (erp_test), built API on :3602.
 * Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import ExcelJS from 'exceljs';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';

const API_PORT = 3602;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
/** Every stored amount is printed with exactly three decimals. */
const AMOUNT = /^-?\d+\.\d{3}$/;

let server: ChildProcess;
let db: Connection;

function api() {
  return request(BASE);
}
function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}
function idem() {
  return { 'Idempotency-Key': `k-${RUN}-${Math.random().toString(36).slice(2)}` };
}

/** supertest hands binary bodies (PDF / XLSX) to this parser as a Buffer. */
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
      const res = await api().get('/api/v1/health');
      if (res.status === 200) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}

interface AccountRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  accountType: string;
  normalBalance: 'DEBIT' | 'CREDIT';
  isPostable: boolean;
  isControl: boolean;
  controlType: string | null;
  isActive: boolean;
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface IdBody {
  id: string;
}

const SIDE_FIELDS = [
  'totalDebit',
  'totalCredit',
  'openingDebit',
  'openingCredit',
  'periodDebit',
  'periodCredit',
  'closingDebit',
  'closingCredit',
] as const;
type SideField = (typeof SIDE_FIELDS)[number];
const TOTAL_FIELDS = [
  'debit',
  'credit',
  'openingDebit',
  'openingCredit',
  'periodDebit',
  'periodCredit',
  'closingDebit',
  'closingCredit',
] as const;

type TbRow = Record<SideField, string> & { code: string; balance: string };
interface TbBody {
  rows: TbRow[];
  totals: Record<(typeof TOTAL_FIELDS)[number], string>;
  balanced: boolean;
}

interface GlBody {
  rows: unknown[];
}

interface MappingRow {
  mappingKey: string;
  accountId: string | null;
  account: { id: string; code: string; nameAr: string; nameEn: string | null } | null;
}

function errorOf(res: request.Response): ErrorBody['error'] {
  return (res.body as ErrorBody).error;
}

/** Asserts the HTTP status and the stable error code of a refused request. */
function expectRefused(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(errorOf(res).code).toBe(code);
}

/** The first non-empty value under the 'Date' column of the 'Date' header row. */
function firstDateValue(ws: ExcelJS.Worksheet): ExcelJS.CellValue | undefined {
  const rows: ExcelJS.Row[] = [];
  ws.eachRow((row) => {
    rows.push(row);
  });
  const headerAt = rows.findIndex((r) => r.getCell(1).text === 'Date');
  if (headerAt < 0) return undefined;
  let col = 0;
  rows[headerAt].eachCell((cell, colNumber) => {
    if (cell.text === 'Date') col = colNumber;
  });
  if (col === 0) return undefined;
  const dataRow = rows
    .slice(headerAt + 1)
    .find((r) => {
      const v = r.getCell(col).value;
      return v !== null && v !== undefined && v !== '';
    });
  return dataRow?.getCell(col).value;
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
      // The general-ledger JSON answers 413 above this many lines (it shares the
      // XLSX cap in reports.service), so a cap of 5 lets six movement lines hit it.
      REPORT_XLSX_MAX_ROWS: '5',
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

describe('Ledger review fixes (2026-11-13) — chart, mappings, fiscal years, reports', () => {
  let token = '';
  let tokenB = '';
  let fyId = '';
  let customerId = '';
  const acc: Record<string, AccountRow> = {};

  const acct = (code: string) => acc[code].id;

  async function loadAccounts() {
    const res = await api().get('/api/v1/accounts').set(auth(token));
    expect(res.status).toBe(200);
    for (const a of res.body as AccountRow[]) acc[a.code] = a;
  }

  async function postDraft(lines: object[], entryDate: string, description = 't'): Promise<string> {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({ entryDate, description, lines });
    expect(draft.status).toBe(201);
    return (draft.body as IdBody).id;
  }

  async function postEntry(id: string) {
    return api().post(`/api/v1/journal-entries/${id}/post`).set(auth(token)).set(idem());
  }

  it('sets up tenant A: fiscal year, chart, customer, opening entry and six manual entries', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `LC A ${RUN}`,
        ownerName: 'Owner',
        email: `ledger-a-${RUN}@test.dev`,
        password: PASS,
      });
    expect(reg.status).toBe(201);
    token = (reg.body as { accessToken: string }).accessToken;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    fyId = (fy.body as IdBody).id;

    await loadAccounts();
    expect(acc['1103'].isControl).toBe(true);

    const customer = await api()
      .post('/api/v1/parties')
      .set(auth(token))
      .send({ code: 'C1', nameAr: 'عميل', partyType: 'CUSTOMER' });
    expect(customer.status).toBe(201);
    customerId = (customer.body as IdBody).id;

    const opening = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .set(idem())
      .send({
        entryDate: '2025-01-01',
        description: 'opening',
        lines: [
          { accountId: acct('1101'), debit: '1000' },
          { accountId: acct('1102'), debit: '250' },
          { accountId: acct('1103'), debit: '300', partyType: 'CUSTOMER', partyId: customerId },
        ],
      });
    expect(opening.status).toBe(201);

    // Six cash movements of 10 on 1101, one per day from 2025-02-01.
    for (let day = 1; day <= 6; day++) {
      const id = await postDraft(
        [
          { accountId: acct('5204'), debit: '10' },
          { accountId: acct('1101'), credit: '10' },
        ],
        `2025-02-0${day}`,
      );
      expect((await postEntry(id)).status).toBe(201);
    }
  });

  it('LEDGER-14 / LEDGER-26: chart template has English names and the right normal balances', () => {
    for (const a of Object.values(acc)) {
      expect(a.nameEn?.trim()).toBeTruthy();
    }
    expect(acc['1202'].normalBalance).toBe('CREDIT');
    expect(acc['4102'].normalBalance).toBe('DEBIT');
    expect(acc['4103'].normalBalance).toBe('DEBIT');
    expect(acc['4101'].normalBalance).toBe('CREDIT');
    expect(acc['1101'].normalBalance).toBe('DEBIT');
  });

  it('LEDGER-03: sub-accounts under used, mapped, or mismatched parents are refused', async () => {
    const create = (body: object) => api().post('/api/v1/accounts').set(auth(token)).send(body);

    expectRefused(await create({ nameAr: 'x', parentId: acct('1101'), accountType: 'ASSET' }), 409, 'ACCOUNT_IN_USE');
    expectRefused(await create({ nameAr: 'x', parentId: acct('1103'), accountType: 'ASSET' }), 409, 'ACCOUNT_IN_USE');
    expectRefused(await create({ nameAr: 'x', parentId: acct('4101'), accountType: 'REVENUE' }), 409, 'ACCOUNT_IN_USE');
    expectRefused(await create({ nameAr: 'x', parentId: acct('11'), accountType: 'REVENUE' }), 400, 'ACCOUNT_TYPE_MISMATCH');

    const child = await create({ nameAr: 'x', parentId: acct('11'), accountType: 'ASSET' });
    expect(child.status).toBe(201);
    const childBody = child.body as AccountRow;
    expect(childBody.normalBalance).toBe('DEBIT');
    expect(childBody.code).toMatch(/^11-/);

    const creditChild = await create({ nameAr: 'y', parentId: acct('12'), accountType: 'ASSET', normalBalance: 'CREDIT' });
    expect(creditChild.status).toBe(201);
    expect((creditChild.body as AccountRow).normalBalance).toBe('CREDIT');

    expect((await create({ nameAr: 'x', parentId: 'x', accountType: 'ASSET' })).status).toBe(400);
    expectRefused(await create({ code: '1101', nameAr: 'x', accountType: 'ASSET' }), 409, 'DUPLICATE_CODE');

    // The refused attempts changed nothing: cash is still a postable account.
    await loadAccounts();
    expect(acc['1101'].isPostable).toBe(true);
  });

  it('LEDGER-04: a group with children cannot be made postable; ids must be numeric', async () => {
    const patch = (id: string) => api().patch(`/api/v1/accounts/${id}`).set(auth(token)).send({ isPostable: true });
    expectRefused(await patch(acct('11')), 409, 'ACCOUNT_HAS_CHILDREN');
    expect((await patch('abc')).status).toBe(400);
  });

  it('LEDGER-11: deactivation is refused while an account has a balance or a draft line', async () => {
    const setActive = (id: string, isActive: boolean) =>
      api().patch(`/api/v1/accounts/${id}`).set(auth(token)).send({ isActive });

    expectRefused(await setActive(acct('1102'), false), 409, 'ACCOUNT_HAS_BALANCE');

    expect((await setActive(acct('5202'), false)).status).toBe(200);
    expect((await setActive(acct('5202'), true)).status).toBe(200);

    // A draft (not posted) line on 5203 still blocks deactivation.
    await postDraft(
      [
        { accountId: acct('5203'), debit: '5' },
        { accountId: acct('1101'), credit: '5' },
      ],
      '2025-03-01',
      'draft use of 5203',
    );
    expectRefused(await setActive(acct('5203'), false), 409, 'ACCOUNT_HAS_BALANCE');
  });

  it('LEDGER-05: mapping keys accept only fitting accounts and lock while in use', async () => {
    const save = (mappingKey: string, accountId: string) =>
      api().post('/api/v1/account-mappings').set(auth(token)).send({ mappingKey, accountId });

    expectRefused(await save('CUSTOMERS_CONTROL', acct('4101')), 400, 'MAPPING_ACCOUNT_INVALID');
    expectRefused(await save('SALES', acct('1103')), 400, 'MAPPING_ACCOUNT_INVALID');
    expect((await save('SALES', acct('1101'))).status).toBe(400); // cash account
    expect((await save('SALES', acct('4201'))).status).toBe(201);
    expect((await save('SALES', acct('4101'))).status).toBe(201); // restore

    const control = await api()
      .post('/api/v1/accounts')
      .set(auth(token))
      .send({ code: '1106', nameAr: 'عملاء 2', accountType: 'ASSET', isControl: true, controlType: 'CUSTOMERS' });
    expect(control.status).toBe(201);
    await loadAccounts();

    // 1103 has posted lines, so the customers mapping cannot move off it.
    expectRefused(await save('CUSTOMERS_CONTROL', acct('1106')), 409, 'MAPPING_LOCKED');
    expect((await save('CUSTOMERS_CONTROL', acct('1103'))).status).toBe(201);

    const list = await api().get('/api/v1/account-mappings').set(auth(token));
    expect(list.status).toBe(200);
    const row = (list.body as MappingRow[]).find((r) => r.mappingKey === 'CUSTOMERS_CONTROL');
    expect(row?.account?.nameEn).toBeTruthy();
  });

  it('LEDGER-25 / LEDGER-09: fiscal years are at most 12 months, non-overlapping, date-only and unique', async () => {
    const create = (body: object) => api().post('/api/v1/fiscal-years').set(auth(token)).send(body);

    const long = await create({ code: 'LONG', startDate: '2026-01-01', endDate: '2027-06-30' });
    expectRefused(long, 400, 'FISCAL_YEAR_TOO_LONG');
    expect(errorOf(long).details).toMatchObject({ maxEndDate: '2026-12-31' });

    expectRefused(await create({ code: '2025', startDate: '2026-01-01', endDate: '2026-12-31' }), 409, 'DUPLICATE_CODE');
    expectRefused(await create({ code: 'OV', startDate: '2025-06-01', endDate: '2026-05-31' }), 409, 'FISCAL_YEAR_OVERLAP');
    expect(
      (await create({ code: 'TZ', startDate: '2026-01-01T00:00:00+03:00', endDate: '2026-12-31' })).status,
    ).toBe(400);

    const ok = await create({ code: '2026', startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(ok.status).toBe(201);
    expect((ok.body as { periods: unknown[] }).periods).toHaveLength(12);

    expect((await api().post('/api/v1/fiscal-periods/abc/close').set(auth(token))).status).toBe(400);
  });

  // Review of PR #26: P&L accounts close into equity each year without a
  // closing entry, so only the current fiscal year's lines count. 5204 has
  // 60.000 of 2025 expenses and nothing in 2026 (the year now running).
  it('LEDGER-11: a P&L account used only in a prior fiscal year can be deactivated', async () => {
    const setActive = (id: string, isActive: boolean) =>
      api().patch(`/api/v1/accounts/${id}`).set(auth(token)).send({ isActive });
    expect((await setActive(acct('5204'), false)).status).toBe(200);
    expect((await setActive(acct('5204'), true)).status).toBe(200);
    // A balance-sheet account keeps its balance across years: still refused.
    expectRefused(await setActive(acct('1102'), false), 409, 'ACCOUNT_HAS_BALANCE');
  });

  // Review of PR #26: a bulk save is all or nothing.
  it('LEDGER-05: a bulk mapping save with one refused key saves none', async () => {
    const res = await api()
      .post('/api/v1/account-mappings/bulk')
      .set(auth(token))
      .send({
        mappings: [
          { mappingKey: 'SALES', accountId: acct('4201') },
          { mappingKey: 'CUSTOMERS_CONTROL', accountId: acct('4101') },
        ],
      });
    expectRefused(res, 400, 'MAPPING_ACCOUNT_INVALID');
    const list = await api().get('/api/v1/account-mappings').set(auth(token));
    const sales = (list.body as { mappingKey: string; accountId: string | null }[]).find((m) => m.mappingKey === 'SALES');
    expect(sales?.accountId).toBe(acct('4101'));
  });

  it('LEDGER-24: reversed report ranges are refused; TB amounts are three-decimal and balanced', async () => {
    const get = (url: string) => api().get(url).set(auth(token));

    expectRefused(await get('/api/v1/reports/trial-balance?from=2025-12-31&to=2025-01-01'), 400, 'INVALID_DATE_RANGE');
    expectRefused(
      await get(`/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-12-31&to=2025-01-01`),
      400,
      'INVALID_DATE_RANGE',
    );
    expectRefused(
      await get(
        `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}&from=2025-12-31&to=2025-01-01`,
      ),
      400,
      'INVALID_DATE_RANGE',
    );
    expectRefused(
      await get('/api/v1/reports/income-statement?from=2025-12-31&to=2025-01-01'),
      400,
      'INVALID_DATE_RANGE',
    );

    const tbRes = await get('/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31');
    expect(tbRes.status).toBe(200);
    const tb = tbRes.body as TbBody;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.length).toBeGreaterThan(0);
    for (const row of tb.rows) {
      for (const field of SIDE_FIELDS) expect(row[field]).toMatch(AMOUNT);
      expect(row.balance).toMatch(AMOUNT);
    }
    for (const field of TOTAL_FIELDS) expect(tb.totals[field]).toMatch(AMOUNT);

    // The totals are the sums of the rows, exactly.
    const sumOf = (field: SideField) => tb.rows.reduce((s, r) => s.plus(r[field]), new Decimal(0));
    expect(sumOf('totalDebit').eq(tb.totals.debit)).toBe(true);
    expect(sumOf('totalCredit').eq(tb.totals.credit)).toBe(true);

    // Opening balance of the customer = the 300 of the opening entry.
    const ps = await get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}`);
    expect(ps.status).toBe(200);
    expect((ps.body as { openingBalance: string }).openingBalance).toBe('300.000');
  });

  it('LEDGER-19 / DB-14: the general-ledger JSON is capped at REPORT_XLSX_MAX_ROWS lines', async () => {
    const get = (url: string) => api().get(url).set(auth(token));

    // Six movement lines in February to December: above the cap of 5.
    const wide = await get(
      `/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-02-01&to=2025-12-31`,
    );
    expectRefused(wide, 413, 'REPORT_TOO_LARGE');

    // Three movement lines in the first three days: under the cap.
    const narrow = await get(
      `/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-02-01&to=2025-02-03`,
    );
    expect(narrow.status).toBe(200);
    expect((narrow.body as GlBody).rows).toHaveLength(3);
  });

  it('LEDGER-23 / LEDGER-27: party statement PDF is landscape A4; ledger XLSX dates are real dates', async () => {
    const pdf = await api()
      .get(`/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}&format=pdf&lang=ar`)
      .set(auth(token))
      .buffer(true)
      .parse(binary);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    const pdfText = (pdf.body as Buffer).toString('latin1');
    expect(pdfText).toMatch(/\/MediaBox \[0 0 841\.\d+ 595\.\d+\]/);

    const xlsx = await api()
      .get(
        `/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-02-01&to=2025-02-03&format=xlsx&lang=en`,
      )
      .set(auth(token))
      .buffer(true)
      .parse(binary);
    expect(xlsx.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    // Same cast as exports.e2e.spec.ts: exceljs types load() as ArrayBuffer.
    await wb.xlsx.load(xlsx.body as unknown as ArrayBuffer);
    const value = firstDateValue(wb.worksheets[0]);
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe('2025-02-01T00:00:00.000Z');
  });

  it('isolates tenant B from tenant A: accounts, ledger, mappings and fiscal years', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `LC B ${RUN}`,
        ownerName: 'Owner B',
        email: `ledger-b-${RUN}@test.dev`,
        password: PASS,
      });
    expect(reg.status).toBe(201);
    tokenB = (reg.body as { accessToken: string }).accessToken;

    expect(
      (await api().patch(`/api/v1/accounts/${acct('5204')}`).set(auth(tokenB)).send({ isActive: false })).status,
    ).toBe(404);
    expect(
      (await api().get(`/api/v1/reports/general-ledger?accountId=${acct('1101')}`).set(auth(tokenB))).status,
    ).toBe(404);
    expect(
      (
        await api()
          .post('/api/v1/account-mappings')
          .set(auth(tokenB))
          .send({ mappingKey: 'SALES', accountId: acct('4101') })
      ).status,
    ).toBe(404);
    expect((await api().get(`/api/v1/fiscal-years/${fyId}`).set(auth(tokenB))).status).toBe(404);
  });

  it('the trial balance without dates is balanced', async () => {
    const tb = await api().get('/api/v1/reports/trial-balance').set(auth(token));
    expect(tb.status).toBe(200);
    expect((tb.body as TbBody).balanced).toBe(true);
  });
});
