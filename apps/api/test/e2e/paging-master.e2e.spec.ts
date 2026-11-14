/**
 * Paging of the master-data and e-invoice lists, and the platform admin's
 * tenant list (ADR-022 §2–§3, ADR-003 §10). One describe block per endpoint:
 *  - GET /parties: paging, q, partyType (exact match) and isActive, sort
 *    stability, bad parameters, and tenant B. Parties are master data, so the
 *    MAIN-only accountant sees every party;
 *  - GET /einvoice/submissions and /:id: paging, status, document type and the
 *    createdAt range (`to` inclusive of the day), q on the document number,
 *    `counts` over the branch scope, the MAIN-only accountant's scope, tenant B;
 *  - GET /admin/tenants: a platform admin's paging, status, q and sort; an
 *    owner gets 403.
 * Submissions are not created through e-invoicing (that needs the JoFotara
 * mock): rows are inserted by SQL for tenant A, on MAIN, on B2 and one with no
 * branch (pre-backfill rows stay visible to every branch, ADR-003 §10).
 * Real MariaDB (erp_test) + built API. Run `pnpm build` first.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import mariadb, { type Connection } from 'mariadb';
import request from 'supertest';
import { addMember } from './support/members.js';

const API_PORT = 3236;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;
let db: Connection;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const pad = (n: number) => String(n).padStart(2, '0');
/** A UTC instant as a DATETIME(3) literal, so the driver does not shift it. */
const sqlUtc = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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

interface PageBody<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** Registers an owner (a new tenant with its company) and returns its token and ids. */
async function registerTenant(name: string, email: string) {
  const reg = await api()
    .post('/api/v1/auth/register')
    .send({ tenantName: name, ownerName: 'Owner', email, password: PASS });
  expect(reg.status).toBe(201);
  const [t] = (await db.query(
    'SELECT t.id AS tenantId, c.id AS companyId FROM tenants t JOIN companies c ON c.tenant_id = t.id WHERE t.name = ?',
    [name],
  )) as { tenantId: bigint; companyId: bigint }[];
  return { token: reg.body.accessToken as string, tenantId: t.tenantId, companyId: t.companyId };
}

// ---------------------------------------------------------------- parties

const PARTY_COUNT = 30;
const PARTY_TYPES = ['CUSTOMER', 'SUPPLIER', 'BOTH'] as const;

/** The i-th party: fixed by index, so every expectation is computed from the same table. */
function partySpec(i: number) {
  return {
    code: `PT${RUN}-${pad(i)}`,
    // Every 7th party shares one Arabic name: equal sort keys test the id tie-break.
    nameAr: i % 7 === 0 ? `Shared ${RUN}` : `Party ${RUN} ${pad(i)}`,
    nameEn: `English ${RUN} ${pad(i)}`,
    partyType: PARTY_TYPES[i % 3],
    isActive: i % 5 !== 0,
    phone: i % 4 === 0 ? `TEL-${RUN}-${pad(i)}` : undefined,
    taxNumber: i === 9 ? `TAX-${RUN}-9` : undefined,
  };
}
const SPECS = Array.from({ length: PARTY_COUNT }, (_, i) => partySpec(i));

interface PartyRow {
  id: string;
  code: string;
  nameAr: string;
  partyType: string;
  isActive: boolean;
}

// ---------------------------------------------------------- e-invoice rows

const SUBMISSION_STATUSES = ['PENDING', 'SENDING', 'ACCEPTED', 'REJECTED', 'FAILED', 'UNKNOWN'] as const;
const SUBMISSION_COUNT = 30;

/**
 * The i-th submission: 18 on MAIN, 11 on B2, one with no branch (the last).
 * Creation times fall on four days, at 23:00 or 09:00 UTC, so `to` must include
 * the whole day, and some pairs share a createdAt (i and i + 12).
 */
function submissionSpec(i: number) {
  const type = i % 4 === 3 ? ('SALES_RETURN' as const) : ('SALES_INVOICE' as const);
  return {
    i,
    type,
    status: SUBMISSION_STATUSES[i % 6],
    createdMs: Date.UTC(2025, 2, 1 + (i % 4), i % 3 === 0 ? 23 : 9, 0),
    documentNo: `${RUN}-${type === 'SALES_RETURN' ? 'RET' : 'INV'}-${pad(i)}`,
    branch: i < 18 ? ('MAIN' as const) : i === SUBMISSION_COUNT - 1 ? null : ('B2' as const),
  };
}
const SUBS = Array.from({ length: SUBMISSION_COUNT }, (_, i) => submissionSpec(i));

interface SubmissionRow {
  id: string;
  documentType: string;
  documentNo: string;
  status: string;
  createdAt: string;
}
interface SubmissionPage extends PageBody<SubmissionRow> {
  counts: Record<string, number>;
}

/** Status counts of the given specs, the shape `counts` is expected to have. */
function tally(rows: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

// --------------------------------------------------------- platform admin

const ADMIN_TENANT_COUNT = 12;
const ADMIN_TENANT_STATUSES = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'PAST_DUE'] as const;
const adminName = (i: number) => `Admin ${RUN} t${pad(i)}`;

interface TenantRow {
  id: string;
  name: string;
  status: string;
  members: number;
  branches: number;
}

describe('Paging of the master-data, e-invoice and platform admin lists', () => {
  let owner = '';
  let accountant = '';
  let tenantB = '';
  let mainId = '';
  let b2Id = '';
  let partyIds: string[] = [];
  const subIds = new Map<number, string>();
  let adminToken = '';
  let ownerOfTenantA = '';

  // Generic reads. A failed status throws, so a broken setup stops the test.
  const get = async <T>(token: string, path: string): Promise<T> => {
    const res = await api().get(path).set(auth(token));
    if (res.status !== 200) throw new Error(`GET ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as T;
  };
  /** Every page of a numbered list, `size` rows at a time. */
  const allPages = async <T>(token: string, path: string, query: string, size: number) => {
    const rows: T[] = [];
    for (let page = 1; ; page += 1) {
      const body = await get<PageBody<T>>(token, `${path}?${query}&pageSize=${size}&page=${page}`);
      rows.push(...body.items);
      if (body.items.length < size) return { rows, total: body.total };
    }
  };
  const partiesPath = '/api/v1/parties';
  const partyList = (token: string, query = '') => get<PageBody<PartyRow>>(token, `${partiesPath}?${query}`);
  const subsPath = '/api/v1/einvoice/submissions';
  const subList = (token: string, query = '') => get<SubmissionPage>(token, `${subsPath}?${query}`);

  it('setup: tenant A with MAIN and B2, 30 parties and 30 submissions, a MAIN-only ACCOUNTANT, tenant B', async () => {
    const a = await registerTenant(`Lists ${RUN}`, `lists-owner-${RUN}@test.dev`);
    owner = a.token;
    ownerOfTenantA = a.token;
    tenantB = (await registerTenant(`Lists B ${RUN}`, `lists-b-${RUN}@test.dev`)).token;

    const [main] = (await db.query("SELECT id FROM branches WHERE tenant_id = ? AND code = 'MAIN'", [a.tenantId])) as {
      id: bigint;
    }[];
    mainId = String(main.id);
    // TRIAL allows one branch; add B2 directly (as paging-branches.e2e does).
    const now = new Date();
    const ins = (await db.query(
      'INSERT INTO branches (tenant_id, company_id, code, name_ar, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      [a.tenantId, a.companyId, 'B2', 'فرع 2', now, now],
    )) as { insertId: bigint };
    b2Id = String(ins.insertId);
    await db.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE code = 'BASIC') WHERE id = ?", [a.tenantId]);

    // Parties: company master data, created by the owner.
    partyIds = [];
    for (const spec of SPECS) {
      const res = await api().post('/api/v1/parties').set(auth(owner)).send({ ...spec, partyType: spec.partyType });
      if (res.status !== 201) throw new Error(`party ${spec.code}: ${res.status} ${JSON.stringify(res.body)}`);
      partyIds.push(res.body.id as string);
    }
    // Submissions: rows as the enqueue step writes them (ids, UUID and ICV fixed).
    for (const s of SUBS) {
      const branchId = s.branch === 'MAIN' ? mainId : s.branch === 'B2' ? b2Id : null;
      const ins = (await db.query(
        `INSERT INTO einvoice_submissions
           (tenant_id, company_id, document_type, document_id, branch_id, document_no, uuid, icv,
            environment, status, attempt_count, next_attempt_at, reuse_xml, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'SANDBOX', ?, 0, ?, 0, ?, ?)`,
        [
          a.tenantId,
          a.companyId,
          s.type,
          900_000 + s.i,
          branchId,
          s.documentNo,
          randomUUID(),
          500 + s.i,
          s.status,
          sqlUtc(s.createdMs),
          sqlUtc(s.createdMs),
          sqlUtc(s.createdMs),
        ],
      )) as { insertId: bigint };
      subIds.set(s.i, String(ins.insertId));
    }

    const member = await addMember(BASE, owner, {
      email: `lists-acct-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      defaultBranchId: mainId,
      branchIds: [mainId],
    });
    accountant = member.token;
  }, 120_000);

  describe('GET /parties', () => {
    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await partyList(owner, `q=${RUN}&pageSize=20`);
      expect(first).toMatchObject({ page: 1, pageSize: 20, total: PARTY_COUNT });
      expect(first.items).toHaveLength(20);
      const second = await partyList(owner, `q=${RUN}&pageSize=20&page=2`);
      expect(second.items).toHaveLength(PARTY_COUNT - 20);
      const past = await partyList(owner, `q=${RUN}&pageSize=20&page=3`);
      expect(past).toMatchObject({ items: [], page: 3, total: PARTY_COUNT });
      const defaults = await partyList(owner, `q=${RUN}`);
      expect(defaults).toMatchObject({ page: 1, pageSize: 20, total: PARTY_COUNT });
    });

    it('default order is code ascending', async () => {
      const rows = (await partyList(owner, `q=${RUN}&pageSize=100`)).items.map((r) => r.code);
      expect(rows).toEqual(SPECS.map((s) => s.code).sort());
    });

    it('the response keeps the party fields', async () => {
      const row = (await partyList(owner, `q=${RUN}&pageSize=100`)).items[0];
      expect(Object.keys(row)).toEqual(expect.arrayContaining(['id', 'code', 'nameAr', 'nameEn', 'partyType', 'isActive', 'companyId']));
    });

    it('partyType is an exact match: CUSTOMER does not pull in BOTH', async () => {
      for (const type of PARTY_TYPES) {
        const body = await partyList(owner, `q=${RUN}&partyType=${type}&pageSize=100`);
        const expected = SPECS.filter((s) => s.partyType === type).length;
        expect(body.total).toBe(expected);
        expect(body.items.every((r) => r.partyType === type)).toBe(true);
      }
    });

    it('isActive narrows the total; a combined filter narrows both', async () => {
      expect((await partyList(owner, `q=${RUN}&isActive=false`)).total).toBe(SPECS.filter((s) => !s.isActive).length);
      expect((await partyList(owner, `q=${RUN}&isActive=true`)).total).toBe(SPECS.filter((s) => s.isActive).length);
      const combined = SPECS.filter((s) => s.partyType === 'SUPPLIER' && s.isActive).length;
      expect((await partyList(owner, `q=${RUN}&partyType=SUPPLIER&isActive=true`)).total).toBe(combined);
    });

    it('search matches code, names, phone and tax number', async () => {
      const byPhone = await partyList(owner, `q=${encodeURIComponent(`TEL-${RUN}`)}`);
      expect(byPhone.total).toBe(SPECS.filter((s) => s.phone).length);
      const byTax = await partyList(owner, `q=${encodeURIComponent(`TAX-${RUN}`)}`);
      expect(byTax.items.map((r) => r.id)).toEqual([partyIds[9]]);
      const byCode = await partyList(owner, `q=${encodeURIComponent(`PT${RUN}-07`)}`);
      expect(byCode.items.map((r) => r.id)).toEqual([partyIds[7]]);
      const byName = await partyList(owner, `q=${encodeURIComponent(`Shared ${RUN}`)}`);
      expect(byName.total).toBe(SPECS.filter((s) => s.nameAr.startsWith('Shared')).length);
      expect((await partyList(owner, `q=${encodeURIComponent(`zz-${RUN}-none`)}`)).total).toBe(0);
      expect((await partyList(owner, 'q=%20%20')).total).toBe(PARTY_COUNT); // blank search = no search
    });

    it('sort is stable: pages of 7 read the same rows as one page, with unique ids', async () => {
      for (const sort of ['code', '-code', 'nameAr', '-nameAr']) {
        const one = (await partyList(owner, `q=${RUN}&sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages<PartyRow>(owner, partiesPath, `q=${RUN}&sort=${sort}`, 7);
        expect(paged.total).toBe(PARTY_COUNT);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(PARTY_COUNT);
      }
    });

    it.each([
      ['page=0'],
      ['page=-1'],
      ['page=1.5'],
      ['page=abc'],
      ['page=10001'],
      ['pageSize=0'],
      ['pageSize=101'],
      ['sort=name'],
      ['sort=--code'],
      [`q=${'x'.repeat(101)}`],
      ['partyType=VENDOR'],
      ['isActive=yes'],
      ['tenantId=1'], // not a parameter: the tenant comes from the token
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${partiesPath}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('empty filter values are "not given" (the web sends them)', async () => {
      const res = await api().get(`${partiesPath}?partyType=&isActive=`).set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(PARTY_COUNT);
    });

    it('is not branch-filtered: the MAIN-only accountant sees every party', async () => {
      const all = await allPages<PartyRow>(accountant, partiesPath, `q=${RUN}&sort=-code`, 6);
      expect(all.total).toBe(PARTY_COUNT);
      expect(all.rows).toHaveLength(PARTY_COUNT);
    });

    it("tenant B sees none of A's parties, in the list or by id", async () => {
      expect(await partyList(tenantB)).toMatchObject({ items: [], total: 0 });
      expect((await partyList(tenantB, `q=${RUN}`)).total).toBe(0);
      expect((await api().get(`${partiesPath}/${partyIds[0]}`).set(auth(tenantB))).status).toBe(404);
    });
  });

  describe('GET /einvoice/submissions', () => {
    const allowedForAccountant = (s: (typeof SUBS)[number]) => s.branch === 'MAIN' || s.branch === null;
    const ownerRows = SUBS;
    const acctRows = SUBS.filter(allowedForAccountant);

    it('numbered pages, the total, and counts over the whole company', async () => {
      const first = await subList(owner, 'pageSize=10');
      expect(first).toMatchObject({ page: 1, pageSize: 10, total: SUBMISSION_COUNT });
      expect(first.items).toHaveLength(10);
      const last = await subList(owner, 'pageSize=10&page=3');
      expect(last.items).toHaveLength(10);
      const past = await subList(owner, 'pageSize=10&page=4');
      expect(past).toMatchObject({ items: [], page: 4, total: SUBMISSION_COUNT });
      const defaults = await subList(owner);
      expect(defaults).toMatchObject({ page: 1, pageSize: 20, total: SUBMISSION_COUNT });
      expect(defaults.counts).toEqual(tally(ownerRows));
    });

    it('status narrows the list, but counts still show every status', async () => {
      const accepted = SUBS.filter((s) => s.status === 'ACCEPTED').length;
      const body = await subList(owner, 'status=ACCEPTED');
      expect(body.total).toBe(accepted);
      expect(body.items.every((r) => r.status === 'ACCEPTED')).toBe(true);
      expect(body.counts).toEqual(tally(ownerRows));
    });

    it('documentType narrows the list; from/to narrow by creation day, to inclusive', async () => {
      const returns = SUBS.filter((s) => s.type === 'SALES_RETURN').length;
      expect((await subList(owner, 'documentType=SALES_RETURN')).total).toBe(returns);
      const onDay = (day: string) => SUBS.filter((s) => dayOf(s.createdMs) === day).length;
      expect((await subList(owner, 'from=2025-03-02&to=2025-03-02')).total).toBe(onDay('2025-03-02'));
      // Day 1 holds 23:00 rows: `to` on that day must still include them.
      expect((await subList(owner, 'from=2025-03-01&to=2025-03-01')).total).toBe(onDay('2025-03-01'));
      expect((await subList(owner, 'from=2025-03-01&to=2025-03-01')).total).toBeGreaterThan(0);
      expect((await subList(owner, 'from=2025-03-03')).total).toBe(
        SUBS.filter((s) => dayOf(s.createdMs) >= '2025-03-03').length,
      );
    });

    it('search matches the document number', async () => {
      const returns = await subList(owner, `q=${encodeURIComponent(`${RUN}-RET-`)}`);
      expect(returns.total).toBe(SUBS.filter((s) => s.type === 'SALES_RETURN').length);
      expect(returns.items.every((r) => r.documentType === 'SALES_RETURN')).toBe(true);
      const one = await subList(owner, `q=${encodeURIComponent(SUBS[5].documentNo)}`);
      expect(one.items.map((r) => r.id)).toEqual([subIds.get(5)]);
      expect((await subList(owner, `q=${RUN}`)).total).toBe(SUBMISSION_COUNT);
    });

    it('sort is stable: pages of 7 read the same rows as one page, with unique ids', async () => {
      for (const sort of ['createdAt', '-createdAt', 'documentNo', '-documentNo']) {
        const one = (await subList(owner, `sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allPages<SubmissionRow>(owner, subsPath, `sort=${sort}`, 7);
        expect(paged.total).toBe(SUBMISSION_COUNT);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(SUBMISSION_COUNT);
      }
      // Newest first by default; equal creation times by id, newest id first.
      const rows = (await subList(owner, 'pageSize=100')).items;
      for (let i = 1; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1], rows[i]];
        const [ta, tb] = [Date.parse(a.createdAt), Date.parse(b.createdAt)];
        expect(ta >= tb).toBe(true);
        if (ta === tb) expect(BigInt(a.id) > BigInt(b.id)).toBe(true);
      }
    });

    it.each([
      ['page=0'],
      ['page=-1'],
      ['page=1.5'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=--createdAt'],
      ['status=VOID'],
      ['documentType=INVOICE'],
      ['from=2025-3-1'],
      ['to=2025-13-01'],
      [`q=${'x'.repeat(101)}`],
      ['branchId=1'], // not a parameter: the branch scope comes from the member
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`${subsPath}?${query}`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('from after to → 400 INVALID_DATE_RANGE', async () => {
      const res = await api().get(`${subsPath}?from=2025-03-05&to=2025-03-01`).set(auth(owner));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DATE_RANGE');
    });

    it('empty filter values are "not given"', async () => {
      const res = await api().get(`${subsPath}?status=&documentType=&from=&to=`).set(auth(owner));
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(SUBMISSION_COUNT);
    });

    it("a MAIN-only accountant lists MAIN's submissions and the unbranched one, total and counts included", async () => {
      const all = await allPages<SubmissionRow>(accountant, subsPath, 'sort=-createdAt', 6);
      expect(all.total).toBe(acctRows.length);
      expect(new Set(all.rows.map((r) => r.id))).toEqual(new Set(acctRows.map((s) => subIds.get(s.i))));
      const body = await subList(accountant, 'pageSize=100');
      expect(body.counts).toEqual(tally(acctRows));
      // Filters inside the scope: the scope is applied, not replaced.
      const accepted = acctRows.filter((s) => s.status === 'ACCEPTED').length;
      expect((await subList(accountant, 'status=ACCEPTED')).total).toBe(accepted);
      // The owner (every branch) still sees B2's rows.
      expect((await subList(owner, 'pageSize=100')).items.length).toBe(SUBMISSION_COUNT);
    });

    it("the MAIN-only accountant gets 404 for a B2 submission on GET, and sees MAIN's", async () => {
      const b2 = SUBS.find((s) => s.branch === 'B2')!;
      const main = SUBS.find((s) => s.branch === 'MAIN')!;
      const none = SUBS.find((s) => s.branch === null)!;
      const denied = await api().get(`${subsPath}/${subIds.get(b2.i)}`).set(auth(accountant));
      expect(denied.status).toBe(404);
      expect(denied.body.error.code).toBe('NOT_FOUND');
      expect((await api().get(`${subsPath}/${subIds.get(main.i)}`).set(auth(accountant))).status).toBe(200);
      expect((await api().get(`${subsPath}/${subIds.get(none.i)}`).set(auth(accountant))).status).toBe(200);
      expect((await api().get(`${subsPath}/${subIds.get(b2.i)}`).set(auth(owner))).status).toBe(200);
    });

    it("tenant B sees none of A's submissions, and gets 404 for one by id", async () => {
      expect(await subList(tenantB)).toMatchObject({ items: [], total: 0, counts: {} });
      expect((await subList(tenantB, `q=${RUN}`)).total).toBe(0);
      const res = await api().get(`${subsPath}/${subIds.get(0)}`).set(auth(tenantB));
      expect(res.status).toBe(404);
    });
  });

  describe('GET /admin/tenants', () => {
    it('setup: a platform admin, and 12 tenants named with this run', async () => {
      const admin = await registerTenant(`Platform ${RUN}`, `lists-admin-${RUN}@test.dev`);
      await db.query('UPDATE users SET is_platform_admin = 1 WHERE email = ?', [`lists-admin-${RUN}@test.dev`]);
      adminToken = admin.token;
      const base = Date.UTC(2025, 0, 1);
      for (let i = 0; i < ADMIN_TENANT_COUNT; i += 1) {
        // Named, dated and in a status by index, so every expectation is computed from them.
        await db.query('INSERT INTO tenants (name, status, created_at, updated_at) VALUES (?, ?, ?, ?)', [
          adminName(i),
          ADMIN_TENANT_STATUSES[i % 4],
          sqlUtc(base + i * 1000),
          sqlUtc(base + i * 1000),
        ]);
      }
      expect(adminToken).not.toBe('');
    });

    const adminList = async (query: string) => {
      const res = await api().get(`/api/v1/admin/tenants?${query}`).set(auth(adminToken));
      if (res.status !== 200) throw new Error(`admin ${query}: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body as PageBody<TenantRow>;
    };
    const allAdminPages = async (query: string, size: number) => {
      const rows: TenantRow[] = [];
      for (let page = 1; ; page += 1) {
        const body = await adminList(`${query}&pageSize=${size}&page=${page}`);
        rows.push(...body.items);
        if (body.items.length < size) return { rows, total: body.total };
      }
    };
    const Q = encodeURIComponent(`Admin ${RUN}`);

    it('numbered pages with the total; a page past the end is empty, not an error', async () => {
      const first = await adminList(`q=${Q}&pageSize=5`);
      expect(first).toMatchObject({ page: 1, pageSize: 5, total: ADMIN_TENANT_COUNT });
      expect(first.items).toHaveLength(5);
      expect((await adminList(`q=${Q}&pageSize=5&page=3`)).items).toHaveLength(2);
      expect(await adminList(`q=${Q}&pageSize=5&page=4`)).toMatchObject({ items: [], page: 4, total: ADMIN_TENANT_COUNT });
      expect(await adminList(`q=${Q}`)).toMatchObject({ page: 1, pageSize: 20, total: ADMIN_TENANT_COUNT });
    });

    it('the response keeps the tenant fields and the newest id first by default', async () => {
      const body = await adminList(`q=${Q}&pageSize=100`);
      expect(Object.keys(body.items[0])).toEqual(expect.arrayContaining(['id', 'name', 'status', 'members', 'branches', 'createdAt']));
      const ids = body.items.map((r) => BigInt(r.id));
      expect(ids).toEqual([...ids].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0)));
    });

    it('status and q narrow the total', async () => {
      for (const status of ADMIN_TENANT_STATUSES) {
        const expected = Array.from({ length: ADMIN_TENANT_COUNT }, (_, i) => i).filter(
          (i) => ADMIN_TENANT_STATUSES[i % 4] === status,
        ).length;
        const body = await adminList(`q=${Q}&status=${status}&pageSize=100`);
        expect(body.total).toBe(expected);
        expect(body.items.every((r) => r.status === status)).toBe(true);
      }
      const one = await adminList(`q=${encodeURIComponent(`${adminName(7)}`)}`);
      expect(one.items.map((r) => r.name)).toEqual([adminName(7)]);
    });

    it('sort is stable for name, createdAt and id: pages of 5 read the same rows as one page', async () => {
      for (const sort of ['id', '-id', 'name', '-name', 'createdAt', '-createdAt']) {
        const one = (await adminList(`q=${Q}&sort=${sort}&pageSize=100`)).items.map((r) => r.id);
        const paged = await allAdminPages(`q=${Q}&sort=${sort}`, 5);
        expect(paged.total).toBe(ADMIN_TENANT_COUNT);
        expect(paged.rows.map((r) => r.id)).toEqual(one);
        expect(new Set(one).size).toBe(ADMIN_TENANT_COUNT);
      }
      const byName = (await adminList(`q=${Q}&sort=name&pageSize=100`)).items.map((r) => r.name);
      expect(byName).toEqual([...byName].sort());
    });

    it.each([
      ['page=0'],
      ['pageSize=101'],
      ['sort=bogus'],
      ['sort=--name'],
      ['status=VOID'],
      ['search=x'], // renamed to q
      [`q=${'x'.repeat(101)}`],
    ])('bad parameter %s → 400 VALIDATION', async (query) => {
      const res = await api().get(`/api/v1/admin/tenants?${query}`).set(auth(adminToken));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION');
    });

    it('a tenant owner is refused (platform admin only)', async () => {
      expect((await api().get(`/api/v1/admin/tenants?q=${Q}`).set(auth(ownerOfTenantA))).status).toBe(403);
      expect((await api().get(`/api/v1/admin/tenants?q=${Q}`).set(auth(tenantB))).status).toBe(403);
    });
  });
});
