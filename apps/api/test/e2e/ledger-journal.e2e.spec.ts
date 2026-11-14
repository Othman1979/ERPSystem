/**
 * Ledger review regression tests (2026-11-13 review): LEDGER-01, LEDGER-02,
 * LEDGER-06, LEDGER-09, LEDGER-10, LEDGER-16, LEDGER-22, DB-08, DB-20, and
 * D-1 / D-2 / D-3. Covers delete-vs-post races, gapless numbering under
 * concurrency, single reversal under concurrent requests, reversal rules,
 * control-account party rules, opening-entry dating, input validation (400,
 * never 500), period close vs. posting races, tenant isolation, and balanced
 * trial balances.
 *
 * Real MariaDB (erp_test), built API on :3601. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { Decimal } from 'decimal.js';

const API_PORT = 3601;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';
/** Timeout for tests that issue concurrent requests or many sequential ones. */
const T = 60_000;

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

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL!.replace(/\/[^/?]+(\?|$)/, '/erp_test$1');
  server = spawn('node', ['dist/main.js'], {
    cwd: path.resolve(import.meta.dirname, '..', '..'),
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      API_PORT: String(API_PORT),
      NODE_ENV: 'test',
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

// ---- types and small helpers -------------------------------------------------

interface Account {
  id: string;
  code: string;
}

interface Tenant {
  token: string;
  tenantId: string;
  /** code -> account id */
  accounts: Record<string, string>;
  /** periodNo -> fiscal period id (fiscal year 2025) */
  periodIds: Record<number, string>;
  customerId: string;
}

interface EntryLine {
  accountId: string;
  debit?: string;
  credit?: string;
  partyType?: 'CUSTOMER' | 'SUPPLIER' | null;
  partyId?: string;
}

interface EntryBody {
  id: string;
  entryNo: string | null;
  status: string;
  description: string | null;
  postingKind?: string;
  reversalOfId?: string | null;
  entryDate?: string;
  lines: { debit: string; credit: string }[];
  reversals?: { id: string }[];
}

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

/** The two tenants of the suite. Filled by the setup test. */
const A: Tenant = { token: '', tenantId: '', accounts: {}, periodIds: {}, customerId: '' };
const B: Tenant = { token: '', tenantId: '', accounts: {}, periodIds: {}, customerId: '' };

function acct(t: Tenant, code: string): string {
  const id = t.accounts[code];
  if (!id) throw new Error(`account ${code} not loaded for tenant`);
  return id;
}

/** Two-line balanced entry: debit one account, credit another. */
function pair(t: Tenant, debitCode: string, creditCode: string, amount: string): EntryLine[] {
  return [
    { accountId: acct(t, debitCode), debit: amount },
    { accountId: acct(t, creditCode), credit: amount },
  ];
}

function bodyOf<T>(res: request.Response): T {
  return res.body as T;
}

function sql<T>(text: string, params: unknown[] = []): Promise<T[]> {
  return db.query<T[]>(text, params);
}

/** Exact decimal normal form with 3 places, for amount comparisons. */
const m3 = (v: string | number) => new Decimal(v).toFixed(3);

async function registerTenant(name: string, tag: string): Promise<string> {
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({
      tenantName: `${name} ${RUN}`,
      ownerName: `Owner ${tag}`,
      email: `ledger-${tag}-${RUN}@test.dev`,
      password: PASS,
    });
  expect(reg.status).toBe(201);
  return bodyOf<{ accessToken: string }>(reg).accessToken;
}

/** Fiscal year 2025, account lookup, for one tenant. */
async function loadTenant(t: Tenant): Promise<void> {
  const fy = await api()
    .post('/api/v1/fiscal-years')
    .set(auth(t.token))
    .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
  expect(fy.status).toBe(201);
  for (const p of bodyOf<{ periods: { id: string; periodNo: number }[] }>(fy).periods) {
    t.periodIds[p.periodNo] = p.id;
  }

  const accounts = await api().get('/api/v1/accounts').set(auth(t.token));
  expect(accounts.status).toBe(200);
  for (const a of bodyOf<Account[]>(accounts)) t.accounts[a.code] = a.id;
  expect(t.accounts['1101']).toBeDefined();
  expect(t.accounts['1103']).toBeDefined();
}

async function makeDraft(
  token: string,
  lines: EntryLine[],
  entryDate = '2025-03-15',
): Promise<request.Response> {
  return api()
    .post('/api/v1/journal-entries')
    .set(auth(token))
    .send({ entryDate, description: 't', lines });
}

async function post(token: string, id: string): Promise<request.Response> {
  return api().post(`/api/v1/journal-entries/${id}/post`).set(auth(token)).set(idem());
}

/** Creates a draft and posts it; asserts the post succeeded. */
async function draftAndPost(token: string, lines: EntryLine[], entryDate = '2025-03-15') {
  const draft = await makeDraft(token, lines, entryDate);
  expect(draft.status).toBe(201);
  const posted = await post(token, bodyOf<EntryBody>(draft).id);
  expect(posted.status).toBe(201);
  return bodyOf<EntryBody>(posted);
}

async function reverse(
  token: string,
  id: string,
  body: { reversalDate: string; description?: string },
): Promise<request.Response> {
  return api().post(`/api/v1/journal-entries/${id}/reverse`).set(auth(token)).set(idem()).send(body);
}

async function getEntry(token: string, id: string): Promise<request.Response> {
  return api().get(`/api/v1/journal-entries/${id}`).set(auth(token));
}

async function openingEntry(token: string, lines: EntryLine[], entryDate = '2025-01-01', description?: string) {
  return api()
    .post('/api/v1/journal-entries/opening')
    .set(auth(token))
    .set(idem())
    .send({ entryDate, lines, ...(description !== undefined ? { description } : {}) });
}

/** Postings numbered JV-... for one tenant, in entry_no order, as their numeric suffixes. */
async function postedJvNumbers(tenantId: string): Promise<number[]> {
  const rows = await sql<{ entry_no: string }>(
    "SELECT entry_no FROM journal_entries WHERE tenant_id = ? AND status = 'POSTED' AND entry_no LIKE 'JV-%' ORDER BY entry_no",
    [tenantId],
  );
  return rows.map((r) => Number(r.entry_no.split('-').pop()));
}

/** Gapless: the numbers are exactly 1..n. */
function expectGapless(numbers: number[]): void {
  expect(numbers).toEqual(numbers.map((_, i) => i + 1));
}

// ---- suite -------------------------------------------------------------------

describe('Ledger review — journal engine (erp_test)', () => {
  /** Ids shared between sequential tests. */
  let postedId = '';
  let manualReversalId = '';

  it(
    'setup: tenants A and B with fiscal year 2025, accounts, and a customer for A',
    async () => {
      A.token = await registerTenant('Ledger A', 'a');
      B.token = await registerTenant('Ledger B', 'b');
      await loadTenant(A);
      await loadTenant(B);

      const tenantRow = await sql<{ tenant_id: bigint }>(
        'SELECT tenant_id FROM fiscal_periods WHERE id = ?',
        [A.periodIds[1]],
      );
      A.tenantId = String(tenantRow[0].tenant_id);

      const customer = await api()
        .post('/api/v1/parties')
        .set(auth(A.token))
        .send({ code: 'C1', nameAr: 'عميل', partyType: 'CUSTOMER' });
      expect(customer.status).toBe(201);
      A.customerId = bodyOf<{ id: string }>(customer).id;
    },
    T,
  );

  // LEDGER-01: a delete racing a post must end in exactly one consistent state.
  it(
    'LEDGER-01: delete racing post never returns 500 or leaves a half state; numbering stays gapless',
    async () => {
      for (let round = 0; round < 8; round++) {
        const draft = await makeDraft(A.token, pair(A, '5204', '1101', '10.000'));
        expect(draft.status).toBe(201);
        const id = bodyOf<EntryBody>(draft).id;

        const [p, d] = await Promise.all([
          post(A.token, id),
          api().delete(`/api/v1/journal-entries/${id}`).set(auth(A.token)),
        ]);
        expect(p.status).not.toBe(500);
        expect(d.status).not.toBe(500);

        const after = await getEntry(A.token, id);
        const postWon = p.status === 201 && d.status === 409;
        const deleteWon = d.status === 200 && (p.status === 404 || p.status === 409);
        expect({ round, postWon: postWon || deleteWon }).toEqual({ round, postWon: true });

        if (postWon) {
          expect(errorCode(d)).toBe('ENTRY_NOT_DRAFT');
          expect(after.status).toBe(200);
          expect(bodyOf<EntryBody>(after).status).toBe('POSTED');
        } else {
          expect(after.status).toBe(404);
        }
      }

      // Either side may win every round; a delete after a post always loses.
      const settled = await makeDraft(A.token, pair(A, '5204', '1101', '1.000'));
      const settledId = bodyOf<EntryBody>(settled).id;
      expect((await post(A.token, settledId)).status).toBe(201);
      const lateDelete = await api().delete(`/api/v1/journal-entries/${settledId}`).set(auth(A.token));
      expect(lateDelete.status).toBe(409);
      expect(errorCode(lateDelete)).toBe('ENTRY_NOT_DRAFT');
      expect(bodyOf<EntryBody>(await getEntry(A.token, settledId)).status).toBe('POSTED');

      const numbers = await postedJvNumbers(A.tenantId);
      expect(numbers.length).toBeGreaterThan(0);
      expectGapless(numbers);
    },
    T,
  );

  // DB-08: concurrent posts get distinct, gapless numbers.
  it(
    'DB-08: 10 concurrent posts all succeed with distinct entry numbers and no gaps',
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const draft = await makeDraft(A.token, pair(A, '5202', '1102', '1.000'));
        expect(draft.status).toBe(201);
        ids.push(bodyOf<EntryBody>(draft).id);
      }

      const results = await Promise.all(ids.map((id) => post(A.token, id)));
      results.forEach((r) => expect(r.status).toBe(201));
      const entryNos = results.map((r) => bodyOf<EntryBody>(r).entryNo);
      expect(new Set(entryNos).size).toBe(10);

      expectGapless(await postedJvNumbers(A.tenantId));
    },
    T,
  );

  // DB-08 (shared sequence): invoice and receipt posts take their JV number at
  // the end of the posting transaction, yet all three kinds draw from one
  // gapless JV sequence under concurrency.
  it(
    'DB-08: concurrent sales-invoice, receipt and manual posts share one gapless JV sequence',
    async () => {
      const wh = await api().post('/api/v1/warehouses').set(auth(A.token)).send({ code: 'W1', nameAr: 'W1' });
      expect(wh.status).toBe(201);
      const warehouseId = bodyOf<{ id: string }>(wh).id;

      const units = await api().get('/api/v1/units').set(auth(A.token));
      expect(units.status).toBe(200);
      const pcs = bodyOf<{ id: string; code: string }[]>(units).find((u) => u.code === 'PCS')!.id;

      const svc = await api()
        .post('/api/v1/items')
        .set(auth(A.token))
        .send({ code: 'SV1', nameAr: 'Service', baseUnitId: pcs, itemKind: 'SERVICE' });
      expect(svc.status).toBe(201);
      const itemId = bodyOf<{ id: string }>(svc).id;

      // GET /accounts returns a tree; walk it the same way phase6 does.
      const accounts = await api().get('/api/v1/accounts').set(auth(A.token));
      expect(accounts.status).toBe(200);
      const flat: { id: string; controlType?: string | null }[] = [];
      const walk = (ns: { id: string; controlType?: string | null; children?: unknown[] }[]) => {
        for (const n of ns) {
          flat.push(n);
          if (n.children) walk(n.children as typeof ns);
        }
      };
      walk(accounts.body as never[]);
      const cashAccountId = flat.find((a) => a.controlType === 'CASH')!.id;

      const box = await api()
        .post('/api/v1/cash-boxes')
        .set(auth(A.token))
        .send({ code: 'CB1', name: 'Main box', accountId: cashAccountId });
      expect(box.status).toBe(201);

      const invoiceIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const inv = await api()
          .post('/api/v1/sales-invoices')
          .set(auth(A.token))
          .send({
            invoiceDate: '2025-03-20',
            customerId: A.customerId,
            warehouseId,
            paymentType: 'CREDIT',
            lines: [{ itemId, qty: '1', unitPrice: '10.000' }],
          });
        expect(inv.status).toBe(201);
        invoiceIds.push(bodyOf<{ id: string }>(inv).id);
      }

      const manualIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const draft = await makeDraft(A.token, pair(A, '5202', '1102', '1.000'));
        expect(draft.status).toBe(201);
        manualIds.push(bodyOf<EntryBody>(draft).id);
      }

      const [invoiceRes, receiptRes, manualRes] = await Promise.all([
        Promise.all(
          invoiceIds.map((id) => api().post(`/api/v1/sales-invoices/${id}/post`).set(auth(A.token)).set(idem())),
        ),
        Promise.all(
          [0, 1, 2].map(() =>
            api()
              .post('/api/v1/receipts')
              .set(auth(A.token))
              .set(idem())
              .send({
                receiptDate: '2025-03-21',
                partyType: 'CUSTOMER',
                partyId: A.customerId,
                cashAccountId,
                amount: '2.000',
              }),
          ),
        ),
        Promise.all(manualIds.map((id) => post(A.token, id))),
      ]);
      [...invoiceRes, ...receiptRes, ...manualRes].forEach((r) => expect(r.status).toBe(201));

      const receiptIds = receiptRes.map((r) => bodyOf<{ id: string }>(r).id);
      const invoiceEntries = await sql<{ entry_no: string }>(
        'SELECT je.entry_no FROM sales_invoices si JOIN journal_entries je ON je.id = si.journal_entry_id WHERE si.tenant_id = ? AND si.id IN (?, ?, ?, ?)',
        [A.tenantId, ...invoiceIds],
      );
      const receiptEntries = await sql<{ entry_no: string }>(
        'SELECT je.entry_no FROM receipts rc JOIN journal_entries je ON je.id = rc.journal_entry_id WHERE rc.tenant_id = ? AND rc.id IN (?, ?, ?)',
        [A.tenantId, ...receiptIds],
      );
      expect(invoiceEntries).toHaveLength(4);
      expect(receiptEntries).toHaveLength(3);

      const numbers: (string | null)[] = [
        ...invoiceEntries.map((r) => r.entry_no),
        ...receiptEntries.map((r) => r.entry_no),
        ...manualRes.map((r) => bodyOf<EntryBody>(r).entryNo),
      ];
      expect(numbers).toHaveLength(10);
      expect(new Set(numbers).size).toBe(10);
      numbers.forEach((n) => expect(n).toMatch(/^JV-/));

      expectGapless(await postedJvNumbers(A.tenantId));
    },
    T,
  );

  // LEDGER-02 / D-1: a concurrent reversal burst yields exactly one reversal.
  it(
    'LEDGER-02 / D-1: concurrent reversals of an opening entry and of a manual entry create exactly one reversal',
    async () => {
      const open = await openingEntry(A.token, [{ accountId: acct(A, '1101'), debit: '500' }]);
      expect(open.status).toBe(201);
      const openId = bodyOf<EntryBody>(open).id;

      const burst = await Promise.all(
        Array.from({ length: 5 }, () => reverse(A.token, openId, { reversalDate: '2025-02-01' })),
      );
      expect(burst.filter((r) => r.status === 201)).toHaveLength(1);
      const losers = burst.filter((r) => r.status !== 201);
      expect(losers).toHaveLength(4);
      losers.forEach((r) => {
        expect(r.status).toBe(409);
        expect(errorCode(r)).toBe('ENTRY_ALREADY_REVERSED');
      });

      const detail = await getEntry(A.token, openId);
      expect(bodyOf<EntryBody>(detail).reversals).toHaveLength(1);
      const [count] = await sql<{ n: number | bigint }>(
        'SELECT COUNT(*) n FROM journal_entries WHERE tenant_id = ? AND reversal_of_id = ?',
        [A.tenantId, openId],
      );
      expect(Number(count.n)).toBe(1);

      // Same burst against a posted manual entry.
      const manual = await draftAndPost(A.token, pair(A, '5204', '1101', '20.000'));
      const manualBurst = await Promise.all(
        Array.from({ length: 3 }, () => reverse(A.token, manual.id, { reversalDate: '2025-03-20' })),
      );
      const winners = manualBurst.filter((r) => r.status === 201);
      expect(winners).toHaveLength(1);
      manualReversalId = bodyOf<EntryBody>(winners[0]).id;
      manualBurst
        .filter((r) => r.status !== 201)
        .forEach((r) => {
          expect(r.status).toBe(409);
          expect(errorCode(r)).toBe('ENTRY_ALREADY_REVERSED');
        });

      const manualDetail = await getEntry(A.token, manual.id);
      expect(bodyOf<EntryBody>(manualDetail).reversals).toHaveLength(1);
      const [manualCount] = await sql<{ n: number | bigint }>(
        'SELECT COUNT(*) n FROM journal_entries WHERE tenant_id = ? AND reversal_of_id = ?',
        [A.tenantId, manual.id],
      );
      expect(Number(manualCount.n)).toBe(1);
    },
    T,
  );

  // Reversal rules and LEDGER-22 (no inherited description on a reversal).
  it(
    'reversal rules: no reversal of a reversal, no reversal of a draft, date not before original; reversal has null description',
    async () => {
      const reversalOfReversal = await reverse(A.token, manualReversalId, { reversalDate: '2025-04-01' });
      expect(reversalOfReversal.status).toBe(409);
      expect(errorCode(reversalOfReversal)).toBe('REVERSAL_NOT_REVERSIBLE');

      const draft = await makeDraft(A.token, pair(A, '5204', '1101', '4.000'));
      const reversalOfDraft = await reverse(A.token, bodyOf<EntryBody>(draft).id, { reversalDate: '2025-04-01' });
      expect(reversalOfDraft.status).toBe(409);
      expect(errorCode(reversalOfDraft)).toBe('ENTRY_NOT_POSTED');

      const original = await draftAndPost(A.token, pair(A, '5204', '1101', '15.000'), '2025-03-15');
      postedId = original.id;

      const tooEarly = await reverse(A.token, original.id, { reversalDate: '2025-03-01' });
      expect(tooEarly.status).toBe(400);
      expect(errorCode(tooEarly)).toBe('REVERSAL_BEFORE_ORIGINAL');

      const ok = await reverse(A.token, original.id, { reversalDate: '2025-03-15' });
      expect(ok.status).toBe(201);
      const rev = bodyOf<EntryBody>(ok);
      expect(rev.postingKind).toBe('REVERSAL');
      expect(rev.description).toBeNull(); // LEDGER-22
      // The first line was a debit of 15; the reversal credits it.
      expect(m3(rev.lines[0].credit)).toBe(m3('15.000'));
      expect(m3(rev.lines[0].debit)).toBe(m3('0'));
    },
    T,
  );

  // D-2: party only on control accounts, and required on them.
  it(
    'D-2: party is rejected on non-control accounts and required on control accounts; the correct form posts',
    async () => {
      const partyOnRevenue = await makeDraft(A.token, [
        { accountId: acct(A, '4101'), credit: '10', partyType: 'CUSTOMER', partyId: A.customerId },
        { accountId: acct(A, '1103'), debit: '10', partyType: 'CUSTOMER', partyId: A.customerId },
      ]);
      expect(partyOnRevenue.status).toBe(201);
      const r1 = await post(A.token, bodyOf<EntryBody>(partyOnRevenue).id);
      expect(r1.status).toBe(400);
      expect(errorCode(r1)).toBe('PARTY_ON_NON_CONTROL_ACCOUNT');

      const controlWithoutParty = await makeDraft(A.token, pair(A, '1103', '4101', '10'));
      const r2 = await post(A.token, bodyOf<EntryBody>(controlWithoutParty).id);
      expect(r2.status).toBe(400);
      expect(errorCode(r2)).toBe('PARTY_REQUIRED');

      const openingWithParty = await openingEntry(A.token, [
        { accountId: acct(A, '1101'), debit: '10', partyType: 'CUSTOMER', partyId: A.customerId },
      ]);
      expect(openingWithParty.status).toBe(400);
      expect(errorCode(openingWithParty)).toBe('PARTY_ON_NON_CONTROL_ACCOUNT');

      const correct = await makeDraft(A.token, [
        { accountId: acct(A, '1103'), debit: '10', partyType: 'CUSTOMER', partyId: A.customerId },
        { accountId: acct(A, '4101'), credit: '10' },
      ]);
      const posted = await post(A.token, bodyOf<EntryBody>(correct).id);
      expect(posted.status).toBe(201);
    },
    T,
  );

  // D-3 and LEDGER-22 for opening entries.
  it(
    'D-3: opening entry must be dated on the fiscal year start; description is null when not sent',
    async () => {
      const midYear = await openingEntry(
        A.token,
        [{ accountId: acct(A, '1101'), debit: '100' }],
        '2025-07-15',
      );
      expect(midYear.status).toBe(400);
      expect(errorCode(midYear)).toBe('OPENING_DATE_NOT_YEAR_START');
      expect(bodyOf<ErrorBody>(midYear).error.details?.fiscalYearStart).toBe('2025-01-01');

      const ok = await openingEntry(A.token, [{ accountId: acct(A, '1101'), debit: '1' }]);
      expect(ok.status).toBe(201);
      expect(bodyOf<EntryBody>(ok).description).toBeNull(); // LEDGER-22
    },
    T,
  );

  // LEDGER-09: malformed input is a 400 (or 404 for foreign ids), never a 500.
  it(
    'LEDGER-09: malformed input and foreign ids return 4xx, never 500',
    async () => {
      const cases: [string, () => Promise<request.Response>][] = [
        [
          'debit abc',
          () => makeDraft(A.token, [{ accountId: acct(A, '1101'), debit: 'abc' }, { accountId: acct(A, '4101'), credit: '10' }]),
        ],
        [
          'debit 1e1',
          () => makeDraft(A.token, [{ accountId: acct(A, '1101'), debit: '1e1' }, { accountId: acct(A, '4101'), credit: '10' }]),
        ],
        [
          'debit with 4 decimals',
          () => makeDraft(A.token, [{ accountId: acct(A, '1101'), debit: '10.0005' }, { accountId: acct(A, '4101'), credit: '10' }]),
        ],
        [
          'accountId x1',
          () => makeDraft(A.token, [{ accountId: 'x1', debit: '10' }, { accountId: acct(A, '4101'), credit: '10' }]),
        ],
        [
          'entryDate with offset',
          () => makeDraft(A.token, pair(A, '5204', '1101', '10'), '2025-03-15T00:00:00+03:00'),
        ],
        ['GET entry abc', () => api().get('/api/v1/journal-entries/abc').set(auth(A.token))],
        [
          'general-ledger accountId zz',
          () => api().get('/api/v1/reports/general-ledger').query({ accountId: 'zz' }).set(auth(A.token)),
        ],
        [
          'general-ledger without accountId',
          () => api().get('/api/v1/reports/general-ledger').query({ from: '2025-01-01' }).set(auth(A.token)),
        ],
        [
          'party-statement without partyId',
          () => api().get('/api/v1/reports/party-statement').query({ partyType: 'CUSTOMER' }).set(auth(A.token)),
        ],
        [
          'trial-balance with offset date',
          () => api().get('/api/v1/reports/trial-balance').query({ from: '2025-03-01T00:00+03:00' }).set(auth(A.token)),
        ],
      ];

      for (const [label, run] of cases) {
        const res = await run();
        expect({ label, status: res.status }).toEqual({ label, status: 400 });
      }

      // Tenant B's account id used in tenant A's draft is a 404, not a 500.
      const foreign = await makeDraft(A.token, [
        { accountId: acct(B, '1101'), debit: '10' },
        { accountId: acct(A, '4101'), credit: '10' },
      ]);
      expect(foreign.status).toBe(404);
      expect(errorCode(foreign)).toBe('NOT_FOUND');

      const badId = await api().get('/api/v1/journal-entries/abc').set(auth(A.token));
      expect(errorCode(badId)).toBe('VALIDATION');
    },
    T,
  );

  // DB-20: a period close racing postings. Every post is 201 or PERIOD_CLOSED
  // and no posting is stamped after the close.
  it(
    'DB-20: period close racing 12 posts; posted_at never after closed_at; late post is PERIOD_CLOSED',
    async () => {
      const mayId = A.periodIds[5];
      const drafts: string[] = [];
      for (let i = 0; i < 13; i++) {
        const draft = await makeDraft(A.token, pair(A, '5204', '1101', '2.000'), '2025-05-10');
        expect(draft.status).toBe(201);
        drafts.push(bodyOf<EntryBody>(draft).id);
      }
      const racing = drafts.slice(0, 12);
      const late = drafts[12];

      // Start the posts first and the close a moment later, so some posts
      // usually commit before the close and some after; either way the
      // invariant below must hold.
      const postsInFlight = racing.map((id) => post(A.token, id));
      await new Promise((r) => setTimeout(r, 20));
      const [close, ...posts] = await Promise.all([
        api().post(`/api/v1/fiscal-periods/${mayId}/close`).set(auth(A.token)),
        ...postsInFlight,
      ]);
      expect([200, 201]).toContain(close.status);
      for (const r of posts) {
        const ok = r.status === 201;
        const closed = r.status === 409 && errorCode(r) === 'PERIOD_CLOSED';
        expect(ok || closed).toBe(true);
      }

      const [period] = await sql<{ closed_at: Date | null }>(
        'SELECT closed_at FROM fiscal_periods WHERE tenant_id = ? AND id = ?',
        [A.tenantId, mayId],
      );
      expect(period.closed_at).not.toBeNull();
      const closedAt = new Date(period.closed_at!).getTime();

      const posted = await sql<{ posted_at: Date }>(
        "SELECT posted_at FROM journal_entries WHERE tenant_id = ? AND fiscal_period_id = ? AND status = 'POSTED'",
        [A.tenantId, mayId],
      );
      // Every entry in the period was posted before the period closed.
      expect(posted.length).toBe(posts.filter((r) => r.status === 201).length);
      for (const row of posted) {
        expect(new Date(row.posted_at).getTime()).toBeLessThanOrEqual(closedAt);
      }

      const lateRes = await post(A.token, late);
      expect(lateRes.status).toBe(409);
      expect(errorCode(lateRes)).toBe('PERIOD_CLOSED');

      const reopen = await api().post(`/api/v1/fiscal-periods/${mayId}/open`).set(auth(A.token));
      expect([200, 201]).toContain(reopen.status);
    },
    T,
  );

  // Tenant isolation: B cannot reach A's journal data.
  it(
    'isolation: tenant B cannot read, delete, post, reverse or report on tenant A journal data',
    async () => {
      const aDraft = await makeDraft(A.token, pair(A, '5204', '1101', '3.000'));
      expect(aDraft.status).toBe(201);
      const draftId = bodyOf<EntryBody>(aDraft).id;

      const getRes = await getEntry(B.token, draftId);
      expect(getRes.status).toBe(404);

      const del = await api().delete(`/api/v1/journal-entries/${draftId}`).set(auth(B.token));
      expect(del.status).toBe(404);

      const postRes = await post(B.token, draftId);
      expect(postRes.status).toBe(404);

      const revRes = await reverse(B.token, postedId, { reversalDate: '2025-04-01' });
      expect(revRes.status).toBe(404);

      // A's draft survived B's delete and post attempts.
      const still = await getEntry(A.token, draftId);
      expect(still.status).toBe(200);
      expect(bodyOf<EntryBody>(still).status).toBe('DRAFT');

      const gl = await api()
        .get('/api/v1/reports/general-ledger')
        .query({ accountId: acct(A, '5204'), from: '2025-01-01', to: '2025-12-31' })
        .set(auth(B.token));
      expect(gl.status).toBe(404);

      const listB = await api().get('/api/v1/journal-entries').set(auth(B.token));
      expect(listB.status).toBe(200);
      const idsB = bodyOf<{ items: EntryBody[] }>(listB).items.map((e) => e.id);
      expect(idsB).not.toContain(draftId);
      expect(idsB).not.toContain(postedId);
    },
    T,
  );

  // Review of PR #26: reversals of DIFFERENT entries never block each other
  // (no gap lock on reversal_of_id), and each gets its own reversal.
  it(
    'concurrent reversals of different entries all succeed',
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        const draft = await makeDraft(A.token, pair(A, '5204', '1101', '3.000'), '2025-06-10');
        const id = bodyOf<EntryBody>(draft).id;
        expect((await post(A.token, id)).status).toBe(201);
        ids.push(id);
      }
      const results = await Promise.all(ids.map((id) => reverse(A.token, id, { reversalDate: '2025-06-11' })));
      expect(results.map((r) => r.status)).toEqual(ids.map(() => 201));
      for (const id of ids) {
        const [n] = await sql<{ n: bigint }>('SELECT COUNT(*) AS n FROM journal_entries WHERE reversal_of_id = ?', [id]);
        expect(Number(n.n)).toBe(1);
      }
    },
    T,
  );

  // Review of PR #26 (D-2): an account mapped as CUSTOMERS_CONTROL without its
  // own control flags (a legacy chart) still requires a party on every line.
  it(
    'a legacy mapped control account requires a party',
    async () => {
      const id = A.accounts['1103'];
      await sql('UPDATE accounts SET is_control = 0, control_type = NULL WHERE tenant_id = ? AND id = ?', [A.tenantId, id]);
      try {
        const noParty = await makeDraft(A.token, pair(A, '1103', '4101', '4.000'), '2025-06-12');
        const res = await post(A.token, bodyOf<EntryBody>(noParty).id);
        expect(res.status).toBe(400);
        expect(errorCode(res)).toBe('PARTY_REQUIRED');
      } finally {
        await sql("UPDATE accounts SET is_control = 1, control_type = 'CUSTOMERS' WHERE tenant_id = ? AND id = ?", [A.tenantId, id]);
      }
    },
    T,
  );

  // Books stay balanced.
  it(
    'trial balance for A is balanced with 3-decimal totals, with and without a date range',
    async () => {
      const plain = await api().get('/api/v1/reports/trial-balance').set(auth(A.token));
      expect(plain.status).toBe(200);
      const ranged = await api()
        .get('/api/v1/reports/trial-balance')
        .query({ from: '2025-01-01', to: '2025-12-31' })
        .set(auth(A.token));
      expect(ranged.status).toBe(200);

      for (const res of [plain, ranged]) {
        const tb = bodyOf<{ balanced: boolean; totals: { debit: string; credit: string } }>(res);
        expect(tb.balanced).toBe(true);
        expect(tb.totals.debit).toBe(tb.totals.credit);
        expect(tb.totals.debit).toMatch(/^-?\d+\.\d{3}$/);
      }
    },
    T,
  );
});

/** Error code from a standard error body, or undefined when the body has none. */
function errorCode(res: request.Response): string | undefined {
  return bodyOf<Partial<ErrorBody>>(res).error?.code;
}
