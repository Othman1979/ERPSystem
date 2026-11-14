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
import { wholeStatement } from './support/statements.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

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
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
      // The general-ledger export answers 413 above this many lines (the XLSX
      // cap, ADR-022 §6), so a cap of 5 lets six movement lines hit it.
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
    database: TEST_DB_NAME,
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
    const ps = await wholeStatement(BASE, `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}`, token);
    expect(ps.status).toBe(200);
    expect((ps.body as { openingBalance: string }).openingBalance).toBe('300.000');
  });

  it('LEDGER-19 / DB-14: the general-ledger export is capped at REPORT_XLSX_MAX_ROWS lines; the JSON is paged', async () => {
    const get = (url: string) => api().get(url).set(auth(token));

    // Six movement lines in February to December: above the cap of 5 for an export (ADR-022 §6)...
    const wide = `/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-02-01&to=2025-12-31`;
    expectRefused(await get(`${wide}&format=xlsx`), 413, 'REPORT_TOO_LARGE');
    // ...while the JSON reads them in pages (ADR-022 §4).
    expect((await wholeStatement(BASE, wide, token)).body.rows).toHaveLength(6);

    // Three movement lines in the first three days: under the cap.
    const narrow = await wholeStatement(
      BASE,
      `/api/v1/reports/general-ledger?accountId=${acct('1101')}&from=2025-02-01&to=2025-02-03`,
      token,
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

/**
 * LEDGER-03 under concurrency (PR #26 locks the parent account FOR UPDATE when a
 * child is created; a posting reads its accounts LOCK IN SHARE MODE). A child
 * account under P and a posting to P are raced on separate connections:
 * exactly one of them wins, never both.
 *
 *  - the posting lands while P is still postable → the child is refused
 *    (409 ACCOUNT_IN_USE, reason HAS_LINES) and P stays a postable leaf;
 *  - or the child is created first → P is a group and the posting is refused
 *    (400 ACCOUNT_NOT_POSTABLE), leaving no journal line on P.
 *
 * The posting is an opening entry (`/journal-entries/opening`): it creates and
 * posts in one request. A manual draft would already hold a line on P, and a
 * draft line alone makes the child refusal certain, so it could not race.
 * Own tenants A and B, so the totals of the suite above are untouched. Both
 * tenants race in the same round, which also shows the lock never crosses
 * tenants.
 */
describe('LEDGER-03 race — a child account under P against a posting to P', () => {
  const ROUNDS = 14;
  /** [child delay, posting delay] in ms: the child is usually the faster request, so it is held back by 0-48 ms to let the posting win too. */
  const STAGGER: [number, number][] = [
    [0, 0],
    [8, 0],
    [16, 0],
    [24, 0],
    [32, 0],
    [0, 8],
    [48, 0],
  ];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  interface Side {
    label: string;
    token: string;
    tenantId: bigint;
    /** The postable-turned-group parent of every P: "Current assets". */
    group: string;
  }

  async function setupSide(label: string): Promise<Side> {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `LC race ${label} ${RUN}`,
        ownerName: `Owner ${label}`,
        email: `ledger-race-${label.toLowerCase()}-${RUN}@test.dev`,
        password: PASS,
      });
    expect(reg.status).toBe(201);
    const token = (reg.body as { accessToken: string }).accessToken;
    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    const accounts = (await api().get('/api/v1/accounts').set(auth(token))).body as AccountRow[];
    const group = accounts.find((a) => a.code === '11');
    expect(group?.isPostable).toBe(false);
    const [tenant] = (await db.query('SELECT id FROM tenants WHERE name = ?', [`LC race ${label} ${RUN}`])) as {
      id: bigint;
    }[];
    return { label, token, tenantId: tenant.id, group: group!.id };
  }

  const newParent = async (side: Side) => {
    const res = await api()
      .post('/api/v1/accounts')
      .set(auth(side.token))
      .send({ nameAr: 'P', parentId: side.group, accountType: 'ASSET' });
    expect(res.status).toBe(201);
    expect((res.body as AccountRow).isPostable).toBe(true);
    return (res.body as IdBody).id;
  };

  const createChild = (side: Side, parentId: string) =>
    api().post('/api/v1/accounts').set(auth(side.token)).send({ nameAr: 'child', parentId, accountType: 'ASSET' });

  /** One opening line on P; the entry plugs the other side to the opening-balance equity. */
  const postTo = (side: Side, accountId: string) =>
    api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(side.token))
      .set(idem())
      .send({ entryDate: '2025-01-01', description: 'race', lines: [{ accountId, debit: '10' }] });

  const fire = async (delayMs: number, send: () => PromiseLike<request.Response>): Promise<request.Response> => {
    if (delayMs > 0) await sleep(delayMs);
    return send();
  };

  async function count(sql: string, params: unknown[]): Promise<number> {
    const [row] = (await db.query(sql, params)) as { n: bigint | number }[];
    return Number(row.n);
  }

  type Who = 'posting' | 'child';

  /**
   * A fresh postable P, the two requests run by `run`, then the database says who won.
   * The invariant is checked whoever it was: never both.
   */
  async function race(
    side: Side,
    where: string,
    run: (parentId: string) => Promise<[request.Response, request.Response]>,
  ): Promise<Who> {
    const parentId = await newParent(side);
    const [child, posting] = await run(parentId);
    // A deadlock or lock wait timeout is neither of the two outcomes: say what InnoDB saw.
    for (const [who, res] of [['child', child], ['posting', posting]] as const) {
      if (res.status >= 400 && errorOf(res).code === 'CONFLICT') {
        throw new Error(`${where}: the ${who} request got CONFLICT (a lock conflict)\n${await lastDeadlock()}`);
      }
    }

    const lines = await count('SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ? AND account_id = ?', [
      side.tenantId,
      parentId,
    ]);
    const children = await count('SELECT COUNT(*) AS n FROM accounts WHERE tenant_id = ? AND parent_id = ?', [
      side.tenantId,
      parentId,
    ]);
    const postable = await count('SELECT is_postable AS n FROM accounts WHERE tenant_id = ? AND id = ?', [
      side.tenantId,
      parentId,
    ]);

    // Never both: a used account must not gain a child, and a group must not hold a line.
    expect({ where, stranded: lines > 0 && children > 0 }).toEqual({ where, stranded: false });

    if (posting.status === 201) {
      expectRefused(child, 409, 'ACCOUNT_IN_USE');
      expect(errorOf(child).details).toMatchObject({ reason: 'HAS_LINES' });
      expect({ where, lines, children, postable }).toEqual({ where, lines: 1, children: 0, postable: 1 });
      return 'posting';
    }
    expect({ where, child: child.status }).toEqual({ where, child: 201 });
    expectRefused(posting, 400, 'ACCOUNT_NOT_POSTABLE');
    expect({ where, lines, children, postable }).toEqual({ where, lines: 0, children: 1, postable: 0 });
    return 'child';
  }

  /** InnoDB's report of the latest deadlock it rolled back, for a failure message. */
  async function lastDeadlock(): Promise<string> {
    const [row] = (await db.query('SHOW ENGINE INNODB STATUS')) as { Status: string }[];
    const text = row.Status;
    const from = text.indexOf('LATEST DETECTED DEADLOCK');
    const to = text.indexOf('\n------------\nTRANSACTIONS');
    return from < 0 ? 'no deadlock recorded' : text.slice(from, to > from ? to : from + 6000);
  }

  /** A third connection of the test's own, for holding a lock. */
  async function connect(): Promise<Connection> {
    const url = new URL(testDatabaseUrl());
    return mariadb.createConnection({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: TEST_DB_NAME,
    });
  }

  /** A lock read that has not come back after this long is queued behind the held lock. */
  const QUEUED_AFTER_MS = 150;

  /**
   * How many statements that look like `pattern` have been running for a while. A lock read on one
   * indexed row returns at once unless it waits for a lock, and the only lock held on P is ours.
   * (INNODB_TRX does not list a transaction that has done nothing but wait, on MariaDB 10.4, so the
   * process list is used; TIME_MS exists on every MariaDB.)
   */
  async function waiting(pattern: string): Promise<number> {
    return count(
      `SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST
        WHERE db = '${TEST_DB_NAME}' AND id <> CONNECTION_ID() AND time_ms >= ? AND info LIKE ?`,
      [QUEUED_AFTER_MS, pattern],
    );
  }

  async function until(condition: () => Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
      await sleep(10);
    }
  }

  /** The child creation takes P FOR UPDATE; the posting reads its accounts LOCK IN SHARE MODE. */
  const CHILD_WAIT = '%FROM accounts%WHERE tenant_id = ? AND id = ? FOR UPDATE%';
  const POSTING_WAIT = '%FROM accounts%LOCK IN SHARE MODE%';

  /**
   * The contention is made, not hoped for: a third connection holds P FOR UPDATE, the request that
   * must win is fired first and waited for until the database shows it queued on P, then the other
   * is fired and waited for the same way, and only then is the lock released. Both sit in the lock
   * queue in a known order, so the first one in is the one that has to win.
   */
  async function heldRace(side: Side, parentId: string, first: Who): Promise<[request.Response, request.Response]> {
    const lock = await connect();
    try {
      await lock.beginTransaction();
      await lock.query('SELECT id FROM accounts WHERE tenant_id = ? AND id = ? FOR UPDATE', [side.tenantId, parentId]);
      const patterns = { child: CHILD_WAIT, posting: POSTING_WAIT };
      const send = {
        child: async () => createChild(side, parentId),
        posting: async () => postTo(side, parentId),
      };
      const responses = {} as Record<Who, Promise<request.Response>>;
      for (const who of first === 'child' ? (['child', 'posting'] as const) : (['posting', 'child'] as const)) {
        const before = await waiting(patterns[who]);
        responses[who] = send[who]();
        await until(async () => (await waiting(patterns[who])) > before, `the ${who} request to queue on P`);
      }
      await lock.commit();
      const [child, posting] = await Promise.all([responses.child, responses.posting]);
      return [child, posting];
    } finally {
      await lock.rollback().catch(() => undefined);
      await lock.end().catch(() => undefined);
    }
  }

  let a: Side;
  let b: Side;

  it('sets up two tenants with a fiscal year each', async () => {
    a = await setupSide('A');
    b = await setupSide('B');
  });

  it('the account lock reads go through the PRIMARY key and look at one row per id', async () => {
    // On MariaDB 10.11 the posting's read went through accounts_tenant_id_id_key while the child creation
    // held the PRIMARY record: a deadlock. Every statement that locks an account row now starts at the
    // clustered record (FORCE INDEX (PRIMARY)); this shows the plan on the version CI runs, and that it stays cheap.
    const parentId = await newParent(a);
    const plans = (await Promise.all([
      db.query('EXPLAIN SELECT id FROM accounts FORCE INDEX (PRIMARY) WHERE tenant_id = ? AND id = ? FOR UPDATE', [a.tenantId, parentId]),
      db.query(
        'EXPLAIN SELECT id, code FROM accounts FORCE INDEX (PRIMARY) WHERE tenant_id = ? AND company_id = ? AND id IN (?, ?) ORDER BY id LOCK IN SHARE MODE',
        [a.tenantId, a.tenantId, parentId, a.group],
      ),
    ])) as { type: string; key: string; rows: bigint | number }[][];
    for (const [plan] of plans) {
      expect(plan.key).toBe('PRIMARY');
      expect(['const', 'range', 'eq_ref']).toContain(plan.type);
      expect(Number(plan.rows)).toBeLessThanOrEqual(2);
    }
  });

  it('held lock, both orders, both tenants: the request queued first wins, the other is refused', async () => {
    for (const side of [a, b]) {
      for (const first of ['child', 'posting', 'posting', 'child'] as const) {
        const where = `tenant ${side.label}, ${first} first`;
        const won = await race(side, where, (parentId) => heldRace(side, parentId, first));
        expect({ where, won }).toEqual({ where, won: first });
      }
    }
  }, 120_000);

  it('free race: exactly one wins every round, in both tenants at once; tenant B cannot touch A\'s account', async () => {
    // No lock is held here: the real scheduler decides who wins, and "never both" must hold anyway.
    // (The deterministic test above is what proves both outcomes happen.)
    for (let round = 0; round < ROUNDS; round++) {
      const [childDelay, postDelay] = STAGGER[round % STAGGER.length];
      const run = (side: Side) => (parentId: string) =>
        Promise.all([
          fire(childDelay, () => createChild(side, parentId)),
          fire(postDelay, () => postTo(side, parentId)),
        ]);
      await Promise.all([
        race(a, `tenant A, round ${round}`, run(a)),
        race(b, `tenant B, round ${round}`, run(b)),
      ]);
    }

    // Tenant B never reaches tenant A's accounts, with or without a race.
    const parentA = await newParent(a);
    expect((await createChild(b, parentA)).status).toBe(404);
    expect((await postTo(b, parentA)).status).toBe(404);
    expect(await count('SELECT COUNT(*) AS n FROM accounts WHERE tenant_id = ? AND parent_id = ?', [a.tenantId, parentA])).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ? AND account_id = ?', [a.tenantId, parentA])).toBe(0);
    // ... and A's P is still a plain postable account.
    const stillOk = await postTo(a, parentA);
    expect(stillOk.status).toBe(201);
    expectRefused(await createChild(a, parentA), 409, 'ACCOUNT_IN_USE');

    for (const side of [a, b]) {
      const tb = await api().get('/api/v1/reports/trial-balance').set(auth(side.token));
      expect(tb.status).toBe(200);
      expect((tb.body as TbBody).balanced).toBe(true);
    }
  }, 120_000);
});
