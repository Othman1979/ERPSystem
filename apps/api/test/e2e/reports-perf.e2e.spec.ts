/**
 * Phase 8 acceptance: "reports work in acceptable time on large test data
 * (e.g. 100k journal lines; the actual limit is proven in the test)".
 *
 * Tenant A gets 50,000 balanced POSTED entries (100,000 lines) over 12 months
 * and 20 accounts, tenant B 500 entries. They are written with batched SQL —
 * posting 50k entries through the API would take tens of minutes; the owner
 * approved this for the performance test only. Expected totals are computed
 * here in integer fils, then each report is timed against its budget and
 * checked against them (and tenant B's rows never count).
 * Measured times are printed and copied into docs/phase-reports/phase-8.md.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 * Aging (DB-14): 32,500 credit invoices; 12,000 are settled by a receipt dated after the date, so they are re-read in chunks; 500 dated after the date never count.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { wholeStatement } from './support/statements.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3204;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
const ENTRIES_A = 50_000;
const ENTRIES_B = 500;

/** Budgets in ms (BUILD_PLAN §17 phase 8). */
const BUDGET = { statementJson: 2_000, ledgerJson: 2_000, ledgerXlsx: 15_000, statementPdf: 10_000, agingJson: 2_000 };

let server: ChildProcess;
let db: Connection;
const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const timings: Record<string, number> = {};

/** Collects a binary body (PDF / XLSX) into a Buffer. */
function binary(res: unknown, cb: (err: Error | null, body: Buffer) => void) {
  const stream = res as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  if (process.env.RUN_PERF !== '1') return;
  const databaseUrl = testDatabaseUrl();
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test', EINVOICE_WORKER: 'off' },
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
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await api().get('/api/v1/health')).status === 200) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('API did not become healthy in time');
    await new Promise((r) => setTimeout(r, 400));
  }
}, 60_000);

afterAll(async () => {
  if (process.env.RUN_PERF !== '1') return;
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
  await db?.end();
  console.log('report timings (ms):', JSON.stringify(timings));
});

/** Deterministic pseudo-random amounts in fils (integers: no float maths). */
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  timings[label] = Math.round(performance.now() - t0);
  return out;
}

const fils = (v: string) => {
  const [i, f = ''] = v.replace('-', '').split('.');
  const n = BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3));
  return v.startsWith('-') ? -n : n;
};

interface Tenant {
  token: string;
  tenantId: bigint;
  companyId: bigint;
  accounts: { id: bigint; code: string }[];
}

async function register(name: string): Promise<Tenant> {
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: name, ownerName: 'Owner', email: `${name.replace(/\s/g, '-').toLowerCase()}@test.dev`, password: PASS });
  expect(reg.status).toBe(201);
  const token = reg.body.accessToken as string;
  expect(
    (await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' }))
      .status,
  ).toBe(201);
  const [t] = (await db.query(
    'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
    [name],
  )) as { tenantId: bigint; companyId: bigint }[];
  // Postable, non-control accounts: no party is needed on their lines.
  const accounts = (await db.query(
    `SELECT id, code FROM accounts WHERE tenant_id = ? AND is_postable = 1 AND is_control = 0 AND is_active = 1 ORDER BY code LIMIT 20`,
    [t.tenantId],
  )) as { id: bigint; code: string }[];
  return { token, tenantId: t.tenantId, companyId: t.companyId, accounts };
}

/** Writes `count` balanced entries; returns the expected Dr/Cr per account in fils. */
async function seed(t: Tenant, count: number, seedNo: number) {
  const rnd = lcg(seedNo);
  const periods = (await db.query(
    `SELECT fp.id, fp.start_date FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.tenant_id = ? ORDER BY fp.start_date`,
    [t.tenantId],
  )) as { id: bigint; start_date: Date }[];
  expect(periods.length).toBe(12);
  const totals = new Map<string, { dr: bigint; cr: bigint }>();
  const add = (code: string, dr: bigint, cr: bigint) => {
    const x = totals.get(code) ?? { dr: 0n, cr: 0n };
    totals.set(code, { dr: x.dr + dr, cr: x.cr + cr });
  };
  const now = new Date();
  const BATCH = 2_000;
  for (let start = 0; start < count; start += BATCH) {
    const n = Math.min(BATCH, count - start);
    const entries: unknown[] = [];
    const plan: { no: string; a: number; b: number; amt: bigint; date: string }[] = [];
    for (let k = 0; k < n; k++) {
      const i = start + k;
      const month = i % 12;
      const day = 1 + (i % 28);
      const a = rnd() % t.accounts.length;
      let b = rnd() % t.accounts.length;
      if (b === a) b = (b + 1) % t.accounts.length;
      const amt = BigInt(1 + (rnd() % 2_000_000)); // 0.001 … 2,000.000 JOD
      const no = `PERF-${RUN}-${seedNo}-${i}`;
      const date = `2025-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const money = `${amt / 1000n}.${String(amt % 1000n).padStart(3, '0')}`;
      entries.push(t.tenantId, t.companyId, no, date, periods[month].id, 'MANUAL_JOURNAL', 'POST', 'POSTED', 'perf', money, money, now, now, now, 'JOURNAL');
      plan.push({ no, a, b, amt, date });
    }
    await db.query(
      `INSERT INTO journal_entries (tenant_id, company_id, entry_no, entry_date, fiscal_period_id, source_type, posting_kind,
         status, description, total_debit, total_credit, posted_at, created_at, updated_at, voucher_type)
       VALUES ${plan.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',')}`,
      entries,
    );
    const ids = (await db.query(`SELECT id, entry_no FROM journal_entries WHERE tenant_id = ? AND entry_no LIKE ?`, [
      t.tenantId,
      `PERF-${RUN}-${seedNo}-%`,
    ])) as { id: bigint; entry_no: string }[];
    const idOf = new Map(ids.map((r) => [r.entry_no, r.id]));
    const lines: unknown[] = [];
    for (const p of plan) {
      const money = `${p.amt / 1000n}.${String(p.amt % 1000n).padStart(3, '0')}`;
      const id = idOf.get(p.no)!;
      // entry_date: the line's copy of its entry's date (LEDGER-19).
      lines.push(t.tenantId, id, 1, t.accounts[p.a].id, money, '0', p.date, now);
      lines.push(t.tenantId, id, 2, t.accounts[p.b].id, '0', money, p.date, now);
      add(t.accounts[p.a].code, p.amt, 0n);
      add(t.accounts[p.b].code, 0n, p.amt);
    }
    await db.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit, entry_date, created_at)
       VALUES ${plan.flatMap(() => ['(?,?,?,?,?,?,?,?)', '(?,?,?,?,?,?,?,?)']).join(',')}`,
      lines,
    );
  }
  return totals;
}

// Opt-in (it writes 100k rows to erp_test): RUN_PERF=1 pnpm --filter api test -- test/e2e/reports-perf.e2e.spec.ts
const perf = process.env.RUN_PERF === '1' ? describe : describe.skip;

perf('Reports on 100,000 journal lines', () => {
  let A: Tenant;
  let B: Tenant;
  let expected: Map<string, { dr: bigint; cr: bigint }>;
  let busiest = { id: 0n, code: '' };

  it('seeds tenant A with 100k lines and tenant B with 1k', async () => {
    A = await register(`PERF ${RUN}`);
    B = await register(`PERF B ${RUN}`);
    expected = await seed(A, ENTRIES_A, 1);
    await seed(B, ENTRIES_B, 2);
    const [{ n }] = (await db.query('SELECT COUNT(*) AS n FROM journal_lines WHERE tenant_id = ?', [A.tenantId])) as { n: bigint }[];
    expect(Number(n)).toBeGreaterThanOrEqual(ENTRIES_A * 2);
    busiest = A.accounts[0];
  }, 600_000);

  it('trial balance (JSON) matches every account to the fils, within budget', async () => {
    const res = await timed('trialBalanceJson', () => api().get('/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31').set(auth(A.token)));
    expect(res.status).toBe(200);
    expect(timings.trialBalanceJson).toBeLessThan(BUDGET.statementJson);
    const rows = res.body.rows as { code: string; totalDebit: string; totalCredit: string }[];
    for (const [code, x] of expected) {
      const r = rows.find((row) => row.code === code)!;
      expect(fils(r.totalDebit)).toBe(x.dr);
      expect(fils(r.totalCredit)).toBe(x.cr);
    }
    expect(res.body.balanced).toBe(true);
  }, 60_000);

  it('income statement and balance sheet (JSON) within budget, balanced', async () => {
    const is = await timed('incomeStatementJson', () =>
      api().get('/api/v1/reports/income-statement?from=2025-01-01&to=2025-12-31').set(auth(A.token)),
    );
    expect(is.status).toBe(200);
    expect(timings.incomeStatementJson).toBeLessThan(BUDGET.statementJson);
    const bs = await timed('balanceSheetJson', () => api().get('/api/v1/reports/balance-sheet?asOf=2025-12-31').set(auth(A.token)));
    expect(bs.status).toBe(200);
    expect(timings.balanceSheetJson).toBeLessThan(BUDGET.statementJson);
    expect(bs.body.balanced).toBe(true);
  }, 60_000);

  it('general ledger of the busiest account: JSON and XLSX within budget', async () => {
    // The screen's first page (ADR-022 §4: keyset, with the period summary)...
    const url = `/api/v1/reports/general-ledger?accountId=${busiest.id}&from=2025-01-01&to=2025-12-31`;
    const json = await timed('ledgerJson', () => api().get(url).set(auth(A.token)));
    expect(json.status).toBe(200);
    expect(timings.ledgerJson).toBeLessThan(BUDGET.ledgerJson);
    // ...and the next page, which continues from the cursor's carried balance.
    const next = await timed('ledgerJsonNextPage', () =>
      api().get(`${url}&cursor=${encodeURIComponent(json.body.nextCursor)}`).set(auth(A.token)),
    );
    expect(next.status).toBe(200);
    expect(timings.ledgerJsonNextPage).toBeLessThan(BUDGET.ledgerJson);
    // Page N: 4,900 lines in, the page still seeks in the line index (LEDGER-19).
    let cursor: string = next.body.nextCursor;
    for (let n = 3; n < 50; n += 1) {
      cursor = (await api().get(`${url}&cursor=${encodeURIComponent(cursor)}`).set(auth(A.token))).body.nextCursor;
    }
    const deep = await timed('ledgerJsonPage50', () =>
      api().get(`${url}&cursor=${encodeURIComponent(cursor)}`).set(auth(A.token)),
    );
    expect(deep.status).toBe(200);
    expect(deep.body.items).toHaveLength(100);
    expect(timings.ledgerJsonPage50).toBeLessThan(BUDGET.ledgerJson);
    const whole = await wholeStatement(BASE, url, A.token);
    const rowsCount = (whole.body.rows as unknown[]).length;
    expect(rowsCount).toBeGreaterThan(1_000);
    expect(whole.body.closingBalance).toBe(json.body.summary.closingBalance);
    timings.ledgerRows = rowsCount;

    const xlsx = await timed('ledgerXlsx', () =>
      api()
        .get(`/api/v1/reports/general-ledger?accountId=${busiest.id}&from=2025-01-01&to=2025-12-31&format=xlsx`)
        .set(auth(A.token))
        .buffer(true)
        .parse(binary),
    );
    expect(xlsx.status).toBe(200);
    expect(timings.ledgerXlsx).toBeLessThan(BUDGET.ledgerXlsx);
  }, 120_000);

  it('trial balance PDF within budget', async () => {
    const pdf = await timed('trialBalancePdf', () =>
      api()
        .get('/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31&format=pdf')
        .set(auth(A.token))
        .buffer(true)
        .parse(binary),
    );
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(timings.trialBalancePdf).toBeLessThan(BUDGET.statementPdf);
  }, 60_000);

  it('aging (JSON) over 32,500 credit invoices, 12,000 settled after the date, within budget', async () => {
    const AGING_INVOICES = 20_000; // first set: 19,900 settled, 100 owe 6.000
    const AGING_SETTLED = 19_900;
    const LATE_SETTLED = 12_000; // settled now by a receipt dated after asOf
    const AFTER_DATE = 500; // dated after asOf: never counted
    const CHUNK = 1_000;
    const now = new Date();

    // Customer and warehouse for tenant A (company from the seeding test).
    await db.query(
      `INSERT INTO parties (tenant_id, company_id, code, name_ar, party_type, national_id_kind, is_cash_customer, is_active, created_at, updated_at)
       VALUES (?, ?, 'AGE-C', 'Aging customer', 'CUSTOMER', 'NIN', 0, 1, NOW(3), NOW(3))`,
      [A.tenantId, A.companyId],
    );
    await db.query(
      `INSERT INTO warehouses (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at)
       VALUES (?, ?, 'AGE-W', 'Aging warehouse', 1, NOW(3), NOW(3))`,
      [A.tenantId, A.companyId],
    );
    const [customer] = (await db.query(`SELECT id FROM parties WHERE tenant_id = ? AND code = 'AGE-C'`, [A.tenantId])) as {
      id: bigint;
    }[];
    const [warehouse] = (await db.query(`SELECT id FROM warehouses WHERE tenant_id = ? AND code = 'AGE-W'`, [A.tenantId])) as {
      id: bigint;
    }[];

    // Multi-row INSERTs of POSTED credit invoices (10.000 each, no journal lines).
    const insertInvoices = async (prefix: string, count: number, dateOf: (n: number) => string, paidOf: (n: number) => string) => {
      for (let start = 0; start < count; start += CHUNK) {
        const rows: string[] = [];
        const params: unknown[] = [];
        for (let n = start; n < Math.min(start + CHUNK, count); n++) {
          const day = dateOf(n);
          rows.push('(?,?,?,?,DATE_ADD(?, INTERVAL 30 DAY),?,?,?,?,?,?,?,?,?,?)');
          params.push(
            A.tenantId,
            A.companyId,
            `${prefix}${n + 1}`,
            day,
            day,
            customer.id,
            warehouse.id,
            'CREDIT',
            'POSTED',
            '10.000',
            '0.000',
            '10.000',
            paidOf(n),
            now,
            now,
          );
        }
        await db.query(
          `INSERT INTO sales_invoices (tenant_id, company_id, invoice_no, invoice_date, due_date, customer_id, warehouse_id,
             payment_type, status, net_total, tax_total, grand_total, paid_amount, created_at, updated_at)
           VALUES ${rows.join(',')}`,
          params,
        );
      }
    };

    // Invoice n (0-based) of the 2025 sets is dated 2025-01-01 + (n % 350) days.
    const date2025 = (n: number) => new Date(Date.UTC(2025, 0, 1 + (n % 350))).toISOString().slice(0, 10);

    // 1) 20,000 invoices: the first 19,900 are fully paid; the last 100 owe 6.000 each.
    await insertInvoices('AGE-', AGING_INVOICES, date2025, (n) => (n < AGING_SETTLED ? '10.000' : '4.000'));
    // 2) 12,000 invoices settled now, but by a receipt dated after asOf (step 3).
    await insertInvoices('AGE-L-', LATE_SETTLED, date2025, () => '10.000');
    // 3) 500 invoices dated after asOf: never counted at 2025-12-31.
    await insertInvoices('AGE-F-', AFTER_DATE, () => '2026-01-05', () => '10.000');

    // Receipt dated after asOf (12,500 x 10.000 = 125,000.000).
    const [cash] = (await db.query(`SELECT id FROM accounts WHERE tenant_id = ? AND company_id = ? LIMIT 1`, [
      A.tenantId,
      A.companyId,
    ])) as { id: bigint }[];
    await db.query(
      `INSERT INTO receipts (tenant_id, company_id, receipt_no, receipt_date, party_type, party_id, cash_account_id, amount, status, created_at)
       VALUES (?, ?, 'AGE-R1', '2026-01-10', 'CUSTOMER', ?, ?, '125000.000', 'POSTED', NOW(3))`,
      [A.tenantId, A.companyId, customer.id, cash.id],
    );
    const [receipt] = (await db.query(`SELECT id FROM receipts WHERE tenant_id = ? AND receipt_no = 'AGE-R1'`, [A.tenantId])) as {
      id: bigint;
    }[];

    // One active allocation per new invoice: 10.000 of the receipt against it.
    const lateInvoices = (await db.query(
      `SELECT id FROM sales_invoices WHERE tenant_id = ? AND (invoice_no LIKE 'AGE-L-%' OR invoice_no LIKE 'AGE-F-%')`,
      [A.tenantId],
    )) as { id: bigint }[];
    expect(lateInvoices.length).toBe(LATE_SETTLED + AFTER_DATE);
    for (let start = 0; start < lateInvoices.length; start += CHUNK) {
      const part = lateInvoices.slice(start, start + CHUNK);
      await db.query(
        `INSERT INTO allocations (tenant_id, company_id, receipt_id, party_type, party_id, document_type, document_id, amount, created_at)
         VALUES ${part.map(() => '(?,?,?,?,?,?,?,?,NOW(3))').join(',')}`,
        part.flatMap((inv) => [A.tenantId, A.companyId, receipt.id, 'CUSTOMER', customer.id, 'SALES_INVOICE', inv.id, '10.000']),
      );
    }

    const res = await timed('agingJson', () => api().get('/api/v1/reports/aging?partyType=CUSTOMER&asOf=2025-12-31').set(auth(A.token)));
    expect(res.status).toBe(200);
    expect(timings.agingJson).toBeLessThan(BUDGET.agingJson);

    const rows = res.body.rows as Record<string, string>[];
    const row = rows.find((r) => r.code === 'AGE-C');
    expect(row).toBeDefined();
    expect(row!.total).toBe('120600.000'); // 100 x 6.000 + 12,000 settled after the date x 10.000 (the 500 dated 2026 are excluded)
    expect(row!.unapplied).toBe('-120600.000'); // no journal lines: the invoices' amount is unapplied
    expect(row!.balance).toBe('0.000');
    const buckets = ['notDue', 'd1_30', 'd31_60', 'd61_90', 'd90plus'] as const;
    const bucketSum = buckets.reduce((s, b) => s + fils(row![b]), 0n);
    expect(bucketSum).toBe(fils(row!.total));

    // Tenant B never sees tenant A's customer.
    const other = await api().get('/api/v1/reports/aging?partyType=CUSTOMER&asOf=2025-12-31').set(auth(B.token));
    expect(other.status).toBe(200);
    expect((other.body.rows as { code: string }[]).some((r) => r.code === 'AGE-C')).toBe(false);
  }, 120_000);
});
