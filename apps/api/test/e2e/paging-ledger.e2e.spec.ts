/**
 * Journal list and keyset statements (ADR-022, LEDGER-08, LEDGER-19) and the
 * company-wide reports (ADR-003 §13).
 *  - GET /journal-entries: numbered pages, filters, sort stability, bad
 *    parameters, branch scope, tenant B.
 *  - General ledger and party statement: read in pages of 4 following
 *    nextCursor, every line and running balance is identical to one read of
 *    500; the summary comes on the first page; tampered, foreign or stale
 *    cursors answer 400 CURSOR_INVALID.
 *  - A MAIN-only accountant's party statement holds MAIN's lines only (its
 *    opening too); the trial balance, general ledger, income statement and
 *    balance sheet answer 403 ALL_BRANCHES_REQUIRED.
 * Tenant A: branches MAIN and B2; 26 posted journals on MAIN (one before the
 * period, for an opening balance) and 10 on B2, all on the receivables
 * control account against revenue, with the customer as party.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';

const API_PORT = 3237;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `pl-${RUN}-${Math.random().toString(36).slice(2)}` });

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
    env: { ...process.env, DATABASE_URL: databaseUrl, API_PORT: String(API_PORT), NODE_ENV: 'test' },
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

interface EntryRow {
  id: string;
  entryNo: string | null;
  entryDate: string;
  branchId: string | null;
  status: string;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
interface StatementLine {
  lineId: string;
  entryDate: string;
  debit: string;
  credit: string;
  balance: string;
}
interface StatementSummary {
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
}
interface StatementPage {
  summary: StatementSummary | null;
  items: StatementLine[];
  nextCursor: string | null;
}

const ON_MAIN = 25; // in the period, plus one before it
const ON_B2 = 10;

describe('Journal list and keyset statements (ADR-022, ADR-003 §12–§13)', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let customerId = '';
  let receivables = '';
  let revenue = '';
  let b2EntryId = '';
  let mainEntryId = '';

  const period = 'from=2025-03-01&to=2025-03-31';

  async function postJournal(branch: string, entryDate: string, amount: string) {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(owner))
      .set('X-Branch-Id', branch)
      .send({
        entryDate,
        description: `paging ${RUN}`,
        lines: [
          { accountId: receivables, debit: amount, partyType: 'CUSTOMER', partyId: customerId },
          { accountId: revenue, credit: amount },
        ],
      });
    if (draft.status !== 201) throw new Error(`draft ${draft.status} ${JSON.stringify(draft.body)}`);
    const posted = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(owner))
      .set('X-Branch-Id', branch)
      .set(idem());
    if (posted.status !== 201) throw new Error(`post ${posted.status} ${JSON.stringify(posted.body)}`);
    return draft.body.id as string;
  }

  /** Every page of a statement read `limit` lines at a time. */
  async function readAll(token: string, url: string, limit: number) {
    const pages: StatementPage[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await api()
        .get(`${url}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .set(auth(token));
      if (res.status !== 200) throw new Error(`${url}: ${res.status} ${JSON.stringify(res.body)}`);
      pages.push(res.body as StatementPage);
      cursor = (res.body as StatementPage).nextCursor;
    } while (cursor);
    return { pages, items: pages.flatMap((p) => p.items) };
  }

  it('setup: tenant A with MAIN and B2, 36 posted journals, a MAIN-only accountant, tenant B', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PLedger ${RUN}`, ownerName: 'Owner', email: `pledger-owner-${RUN}@test.dev`, password: PASS });
    expect(reg.status).toBe(201);
    owner = reg.body.accessToken;
    const other = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `PLedger B ${RUN}`, ownerName: 'Owner B', email: `pledger-b-${RUN}@test.dev`, password: PASS });
    expect(other.status).toBe(201);
    tenantB = other.body.accessToken;

    const [t] = (await db.query(
      'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
      [`PLedger ${RUN}`],
    )) as { tenantId: bigint; companyId: bigint }[];
    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [t.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [t.tenantId, t.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);

    await api()
      .post('/api/v1/fiscal-years')
      .set(auth(owner))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    const accounts = await api().get('/api/v1/accounts').set(auth(owner));
    const flat: { id: string; code: string }[] = [];
    const walk = (ns: { id: string; code: string; children?: unknown[] }[]) => {
      for (const n of ns) {
        flat.push(n);
        if (n.children) walk(n.children as typeof ns);
      }
    };
    walk(accounts.body as never[]);
    receivables = flat.find((a) => a.code === '1103')!.id;
    revenue = flat.find((a) => a.code === '4101')!.id;
    customerId = (
      await api().post('/api/v1/parties').set(auth(owner)).send({ code: 'C1', nameAr: `Cust ${RUN}`, partyType: 'CUSTOMER' })
    ).body.id;

    // Before the period: the opening balance of MAIN.
    await postJournal(mainId, '2025-02-15', '100.000');
    for (let i = 0; i < ON_MAIN; i += 1) {
      const id = await postJournal(mainId, `2025-03-0${1 + (i % 5)}`, `${i + 1}.000`);
      if (i === 0) mainEntryId = id;
    }
    for (let i = 0; i < ON_B2; i += 1) {
      const id = await postJournal(b2Id, `2025-03-0${1 + (i % 5)}`, `${(i + 1) * 10}.000`);
      if (i === 0) b2EntryId = id;
    }

    const member = await addMember(BASE, owner, {
      email: `pledger-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 180_000);

  describe('GET /journal-entries (LEDGER-08)', () => {
    const list = async (token: string, query = '') => {
      const res = await api().get(`/api/v1/journal-entries${query}`).set(auth(token));
      if (res.status !== 200) throw new Error(`${query}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as Page<EntryRow>;
    };
    const total = 1 + ON_MAIN + ON_B2;

    it('numbered pages with the total, filters and search', async () => {
      expect(await list(owner, '?pageSize=10')).toMatchObject({ page: 1, pageSize: 10, total });
      expect((await list(owner, '?pageSize=10&page=4')).items).toHaveLength(total - 30);
      expect(await list(owner, '?pageSize=10&page=5')).toMatchObject({ items: [], total });
      expect((await list(owner, '?status=POSTED')).total).toBe(total);
      expect((await list(owner, '?status=DRAFT')).total).toBe(0);
      expect((await list(owner, '?sourceType=MANUAL_JOURNAL')).total).toBe(total);
      expect((await list(owner, `?${period}`)).total).toBe(ON_MAIN + ON_B2);
      expect((await list(owner, '?from=2025-02-01&to=2025-02-28')).total).toBe(1);
      const one = (await api().get(`/api/v1/journal-entries/${mainEntryId}`).set(auth(owner))).body as EntryRow;
      expect((await list(owner, `?q=${encodeURIComponent(one.entryNo!)}`)).items.map((r) => r.id)).toEqual([one.id]);
    });

    it('sort is stable across pages', async () => {
      for (const sort of ['-entryDate', 'entryDate', 'entryNo']) {
        const all = (await list(owner, `?sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged: string[] = [];
        for (let page = 1; page <= 6; page += 1) {
          paged.push(...(await list(owner, `?sort=${sort}&pageSize=7&page=${page}`)).items.map((r) => r.id));
        }
        expect(paged).toEqual(all);
        expect(new Set(all).size).toBe(total);
      }
    }, 60_000);

    it.each([['page=0'], ['pageSize=101'], ['sort=amount'], ['sourceType=SALES_INVOICE'], ['from=2025-3-1'], ['foo=1']])(
      'bad parameter %s → 400 VALIDATION',
      async (query) => {
        const res = await api().get(`/api/v1/journal-entries?${query}`).set(auth(owner));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION');
      },
    );

    it("a MAIN-only accountant lists MAIN's entries and gets 404 for B2's", async () => {
      const page = await list(accountant, '?pageSize=100');
      expect(page.total).toBe(1 + ON_MAIN);
      expect(page.items.every((r) => r.branchId === mainId)).toBe(true);
      const b2 = await api().get(`/api/v1/journal-entries/${b2EntryId}`).set(auth(accountant));
      expect(b2.status).toBe(404);
      expect(b2.body.error.code).toBe('NOT_FOUND');
      expect((await api().get(`/api/v1/journal-entries/${mainEntryId}`).set(auth(accountant))).status).toBe(200);
    });

    it("tenant B sees none of A's entries", async () => {
      expect(await list(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await api().get(`/api/v1/journal-entries/${mainEntryId}`).set(auth(tenantB))).status).toBe(404);
    });
  });

  describe('General ledger (keyset, LEDGER-19)', () => {
    const url = () => `/api/v1/reports/general-ledger?accountId=${receivables}&${period}`;

    it('pages of 4 give the same lines and running balances as one read; summary on the first page only', async () => {
      const one = await readAll(owner, url(), 500);
      expect(one.pages).toHaveLength(1);
      expect(one.items).toHaveLength(ON_MAIN + ON_B2);
      const paged = await readAll(owner, url(), 4);
      expect(paged.pages.length).toBe(Math.ceil((ON_MAIN + ON_B2) / 4));
      expect(paged.items).toEqual(one.items);
      const summary = paged.pages[0].summary!;
      expect(paged.pages.slice(1).every((p) => p.summary === null)).toBe(true);
      // MAIN 100 before the period; the period adds 1..25 (MAIN) and 10..100 (B2).
      expect(summary.openingBalance).toBe('100.000');
      expect(summary.totalDebit).toBe('875.000'); // 325 + 550
      expect(summary.closingBalance).toBe('975.000');
      expect(paged.items[paged.items.length - 1].balance).toBe(summary.closingBalance);
      expect(paged.pages[paged.pages.length - 1].nextCursor).toBeNull();
    });

    it('the export still reads the whole statement', async () => {
      const xlsx = await api().get(`${url()}&format=xlsx`).set(auth(owner));
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    });

    it('tampered, stale or foreign cursors answer 400 CURSOR_INVALID', async () => {
      const first = (await api().get(`${url()}&limit=4`).set(auth(owner))).body as StatementPage;
      const cursor = first.nextCursor!;
      const [v, payload, mac] = cursor.split('.');
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { c: { balance: string } };
      body.c.balance = '999999.000';
      const forged = `${v}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${mac}`;
      for (const [label, query] of [
        ['forged balance', `${url()}&limit=4&cursor=${encodeURIComponent(forged)}`],
        ['other period', `/api/v1/reports/general-ledger?accountId=${receivables}&from=2025-03-02&to=2025-03-31&limit=4&cursor=${encodeURIComponent(cursor)}`],
        ['garbage', `${url()}&limit=4&cursor=abc`],
      ] as const) {
        const res = await api().get(query).set(auth(owner));
        expect({ label, status: res.status, code: res.body.error?.code }).toEqual({ label, status: 400, code: 'CURSOR_INVALID' });
      }
      const tooBig = await api().get(`${url()}&limit=501`).set(auth(owner));
      expect(tooBig.status).toBe(400);
      expect(tooBig.body.error.code).toBe('VALIDATION');
    });
  });

  describe('Party statement (keyset, branch-scoped)', () => {
    const url = () => `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}&${period}`;

    it('the owner reads every branch; pages match one read', async () => {
      const one = await readAll(owner, url(), 500);
      const paged = await readAll(owner, url(), 4);
      expect(paged.items).toEqual(one.items);
      expect(one.items).toHaveLength(ON_MAIN + ON_B2);
      expect(paged.pages[0].summary).toMatchObject({ openingBalance: '100.000', closingBalance: '975.000' });
    });

    it("a MAIN-only accountant reads MAIN's lines and opening only, in pages too", async () => {
      const one = await readAll(accountant, url(), 500);
      const paged = await readAll(accountant, url(), 4);
      expect(paged.items).toEqual(one.items);
      expect(one.items).toHaveLength(ON_MAIN);
      expect(paged.pages[0].summary).toMatchObject({
        openingBalance: '100.000',
        totalDebit: '325.000',
        closingBalance: '425.000',
      });
    });

    it("the owner's cursor is refused for the accountant (another branch scope)", async () => {
      const first = (await api().get(`${url()}&limit=4`).set(auth(owner))).body as StatementPage;
      const res = await api()
        .get(`${url()}&limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`)
        .set(auth(accountant));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
    });

    it("tenant B gets nothing of A's party (and A's cursor is refused)", async () => {
      const first = (await api().get(`${url()}&limit=4`).set(auth(owner))).body as StatementPage;
      const res = await api().get(`${url()}&limit=4&cursor=${encodeURIComponent(first.nextCursor!)}`).set(auth(tenantB));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CURSOR_INVALID');
      const fresh = await api().get(url()).set(auth(tenantB));
      expect(fresh.status).toBe(200);
      expect((fresh.body as StatementPage).items).toEqual([]);
    });
  });

  describe('Company-wide reports (ADR-003 §13)', () => {
    it.each([
      ['trial balance', '/api/v1/reports/trial-balance?from=2025-01-01&to=2025-12-31'],
      ['general ledger', '/api/v1/reports/general-ledger?accountId=ACCT&from=2025-01-01&to=2025-12-31'],
      ['income statement', '/api/v1/reports/income-statement?from=2025-01-01&to=2025-12-31'],
      ['balance sheet', '/api/v1/reports/balance-sheet?asOf=2025-12-31'],
    ])('%s: 403 ALL_BRANCHES_REQUIRED for the MAIN-only accountant, 200 for the owner', async (_label, raw) => {
      const url = raw.replace('ACCT', receivables);
      const refused = await api().get(url).set(auth(accountant));
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
      expect((await api().get(url).set(auth(owner))).status).toBe(200);
    });

    it('the trial balance stays balanced', async () => {
      const tb = await api().get('/api/v1/reports/trial-balance').set(auth(owner));
      expect(tb.body.balanced).toBe(true);
    });
  });
});
