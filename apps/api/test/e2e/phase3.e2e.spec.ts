/**
 * Phase 3 integration tests — journal engine: draft/post/reverse, opening
 * entry, period rules, control-account party rules, reports, gapless
 * numbering, tenant isolation. Real MariaDB (erp_test), built API on :3197.
 * Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import request from 'supertest';
import mariadb, { type Connection } from 'mariadb';
import { wholeStatement } from './support/statements.js';
import { testDatabaseUrl, TEST_DB_NAME } from './support/test-db.js';

const API_PORT = 3197;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

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

interface Account {
  id: string;
  code: string;
  isPostable: boolean;
  isControl: boolean;
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

describe('Phase 3 — journal engine (erp_test)', () => {
  let token = '';
  const acc: Record<string, Account> = {};
  let fyPeriod1Id = '';
  // A real customer: party lines must name a party of the tenant.
  let customerId = '';

  const acct = (code: string) => acc[code].id;

  async function makeDraft(lines: object[], entryDate = '2025-03-15', description = 'test') {
    return api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({ entryDate, description, lines });
  }

  it('sets up tenant: fiscal year + account lookup', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `JE ${RUN}`,
        ownerName: 'Owner',
        email: `je-${RUN}@test.dev`,
        password: PASS,
      });
    expect(reg.status).toBe(201);
    token = reg.body.accessToken;

    const fy = await api()
      .post('/api/v1/fiscal-years')
      .set(auth(token))
      .send({ code: '2025', startDate: '2025-01-01', endDate: '2025-12-31' });
    expect(fy.status).toBe(201);
    fyPeriod1Id = fy.body.periods[0].id;

    const accounts = await api().get('/api/v1/accounts').set(auth(token));
    for (const a of accounts.body as Account[]) acc[a.code] = a;
    expect(acc['4101']).toBeDefined();
    expect(acc['1101']).toBeDefined();
    expect(acc['1103'].isControl).toBe(true);

    const customer = await api()
      .post('/api/v1/parties')
      .set(auth(token))
      .send({ code: 'C1', nameAr: 'عميل', partyType: 'CUSTOMER' });
    expect(customer.status).toBe(201);
    customerId = customer.body.id;
  });

  it('rejects posting outside any fiscal year', async () => {
    const draft = await makeDraft(
      [
        { accountId: acct('5204'), debit: '10.000' },
        { accountId: acct('1101'), credit: '10.000' },
      ],
      '2030-01-15',
    );
    expect(draft.status).toBe(201);
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe('PERIOD_CLOSED');
  });

  it('rejects posting to a closed period', async () => {
    await api()
      .post(`/api/v1/fiscal-periods/${fyPeriod1Id}/close`)
      .set(auth(token));
    const draft = await makeDraft(
      [
        { accountId: acct('5204'), debit: '10.000' },
        { accountId: acct('1101'), credit: '10.000' },
      ],
      '2025-01-20',
    );
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe('PERIOD_CLOSED');
    await api()
      .post(`/api/v1/fiscal-periods/${fyPeriod1Id}/open`)
      .set(auth(token));
  });

  it('rejects unbalanced entries at post time', async () => {
    const draft = await makeDraft([
      { accountId: acct('5204'), debit: '10.000' },
      { accountId: acct('1101'), credit: '9.000' },
    ]);
    expect(draft.status).toBe(201);
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(400);
    expect(post.body.error.code).toBe('UNBALANCED_ENTRY');
    // still a draft — delete it
    await api().delete(`/api/v1/journal-entries/${draft.body.id}`).set(auth(token));
  });

  it('rejects posting on a parent (non-postable) account', async () => {
    const draft = await makeDraft([
      { accountId: acct('1'), debit: '10.000' }, // root group
      { accountId: acct('1101'), credit: '10.000' },
    ]);
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(400);
    expect(post.body.error.code).toBe('ACCOUNT_NOT_POSTABLE');
    // The web names the refused row from details.line.
    expect(post.body.error.details).toMatchObject({ line: 1, accountId: acct('1') });
  });

  it('rejects control-account lines without party info', async () => {
    const draft = await makeDraft([
      { accountId: acct('1103'), debit: '100.000' }, // customers control, no party
      { accountId: acct('4101'), credit: '100.000' },
    ]);
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(400);
    expect(post.body.error.code).toBe('PARTY_REQUIRED');
    expect(post.body.error.message).toContain('party');
    expect(post.body.error.details).toMatchObject({ line: 1, accountId: acct('1103') });
  });

  it('posts a balanced manual journal with gapless JV number', async () => {
    const d1 = await makeDraft([
      { accountId: acct('5204'), debit: '50.000' },
      { accountId: acct('1101'), credit: '50.000' },
    ]);
    const d2 = await makeDraft([
      { accountId: acct('5202'), debit: '25.500' },
      { accountId: acct('1102'), credit: '25.500' },
    ]);

    // post concurrently — both must succeed with sequential numbers
    const [p1, p2] = await Promise.all([
      api().post(`/api/v1/journal-entries/${d1.body.id}/post`).set(auth(token)).set(idem()),
      api().post(`/api/v1/journal-entries/${d2.body.id}/post`).set(auth(token)).set(idem()),
    ]);
    expect(p1.status).toBe(201);
    expect(p2.status).toBe(201);
    expect(p1.body.status).toBe('POSTED');
    expect(p2.body.status).toBe('POSTED');
    const nums = [p1.body.entryNo, p2.body.entryNo].sort();
    expect(nums[0]).toMatch(/^JV-2025-00000[12]$/);
    expect(nums[1]).toMatch(/^JV-2025-00000[12]$/);
    expect(nums[0]).not.toBe(nums[1]); // gapless & unique
  });

  it('double-post is impossible', async () => {
    const draft = await makeDraft([
      { accountId: acct('5203'), debit: '5.000' },
      { accountId: acct('1101'), credit: '5.000' },
    ]);
    const key = idem();
    const p1 = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(key);
    expect(p1.status).toBe(201);
    const p2 = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(p2.status).toBe(409);
  });

  it('reverses a posted entry with swapped lines and reversal date', async () => {
    const draft = await makeDraft([
      { accountId: acct('5204'), debit: '30.000' },
      { accountId: acct('1101'), credit: '30.000' },
    ]);
    const posted = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(posted.status).toBe(201);

    const rev = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-10', description: 'undo' });
    expect(rev.status).toBe(201);
    expect(rev.body.postingKind).toBe('REVERSAL');
    expect(rev.body.reversalOfId).toBe(draft.body.id);
    expect(String(rev.body.entryDate).slice(0, 10)).toBe('2025-04-10');
    // swapped: first line was debit 30 → now credit 30
    const first = rev.body.lines[0];
    expect(Number(first.credit)).toBe(30);
    expect(Number(first.debit)).toBe(0);

    // second reversal rejected
    const rev2 = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-04-11' });
    expect(rev2.status).toBe(409);
  });

  it('opening entry plugs difference to OPENING_BALANCE_EQUITY', async () => {
    // customers control 500 DR, cash 500 CR → balanced already, no plug needed?
    // supply only asset line → plug to equity
    const res = await api()
      .post('/api/v1/journal-entries/opening')
      .set(auth(token))
      .set(idem())
      .send({
        entryDate: '2025-01-01',
        description: 'opening',
        lines: [
          {
            accountId: acct('1101'),
            debit: '1000.000',
            partyType: null,
            partyId: null,
          },
          {
            accountId: acct('1103'),
            debit: '500.000',
            partyType: 'CUSTOMER',
            partyId: customerId,
          },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('POSTED');
    expect(res.body.sourceType).toBe('OPENING_ENTRY');
    expect(res.body.entryNo).toMatch(/^OP-2025-/);
    // plug: credits must equal debits 1500 → equity credit 1500
    const equity = res.body.lines.find(
      (l: { account: { code: string } }) => l.account.code === '3103',
    );
    expect(equity).toBeDefined();
    expect(Number(equity.credit)).toBe(1500);
  });

  it('trial balance is balanced and matches line sums', async () => {
    const tb = await api()
      .get('/api/v1/reports/trial-balance')
      .query({ from: '2025-01-01', to: '2025-12-31' })
      .set(auth(token));
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.totals.debit).toBe(tb.body.totals.credit);
    // manual entries posted: 50+25.5+30(+reversal nets 0)+5? compute from rows
    const sumDebit = tb.body.rows.reduce(
      (s: number, r: { totalDebit: string }) => s + Number(r.totalDebit),
      0,
    );
    expect(Number(tb.body.totals.debit)).toBeCloseTo(sumDebit, 3);
    expect(tb.body.rows.length).toBeGreaterThan(0);
  });

  it('general ledger shows running balance for an account', async () => {
    const gl = await wholeStatement(BASE, `/api/v1/reports/general-ledger?accountId=${acct('5204')}&from=2025-01-01&to=2025-12-31`, token);
    expect(gl.status).toBe(200);
    expect(gl.body.account.code).toBe('5204');
    // 5204 got: +50 (post), +30 then reversal -30 → net 50... plus opening? no.
    expect(Number(gl.body.closingBalance)).toBeCloseTo(50, 3);
    expect(gl.body.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('party statement matches control-account balance', async () => {
    const ps = await wholeStatement(BASE, `/api/v1/reports/party-statement?partyType=CUSTOMER&partyId=${customerId}`, token);
    expect(ps.status).toBe(200);
    expect(Number(ps.body.closingBalance)).toBeCloseTo(500, 3);

    // ADR-008: the opening entry is the statement's opening balance, not a row.
    expect(ps.body.rows.length).toBe(0);
    expect(Number(ps.body.openingDebit)).toBe(500);
  });

  it('receipt voucher posts with a cash debit and keeps its type on reversal', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-05-10',
        description: 'cash receipt',
        voucherType: 'RECEIPT_VOUCHER',
        lines: [
          { accountId: acct('1101'), debit: '75.000' },
          { accountId: acct('4101'), credit: '75.000' },
        ],
      });
    expect(draft.status).toBe(201);
    expect(draft.body.voucherType).toBe('RECEIPT_VOUCHER');

    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(201);

    const rev = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/reverse`)
      .set(auth(token))
      .set(idem())
      .send({ reversalDate: '2025-05-11' });
    expect(rev.status).toBe(201);
    expect(rev.body.voucherType).toBe('RECEIPT_VOUCHER');
  });

  it('payment voucher posts with a bank credit', async () => {
    const draft = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-05-12',
        description: 'bank payment',
        voucherType: 'PAYMENT_VOUCHER',
        lines: [
          { accountId: acct('5204'), debit: '40.000' },
          { accountId: acct('1102'), credit: '40.000' },
        ],
      });
    expect(draft.status).toBe(201);
    const post = await api()
      .post(`/api/v1/journal-entries/${draft.body.id}/post`)
      .set(auth(token))
      .set(idem());
    expect(post.status).toBe(201);
  });

  it('vouchers enforce the cash/bank side rules', async () => {
    const post = (id: string) =>
      api()
        .post(`/api/v1/journal-entries/${id}/post`)
        .set(auth(token))
        .set(idem());

    // receipt without any cash/bank debit
    const noCash = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-05-13',
        voucherType: 'RECEIPT_VOUCHER',
        lines: [
          {
            accountId: acct('1103'),
            debit: '10.000',
            partyType: 'CUSTOMER',
            partyId: customerId,
          },
          { accountId: acct('4101'), credit: '10.000' },
        ],
      });
    expect((await post(noCash.body.id)).status).toBe(400);

    // receipt that also credits a cash account (wrong side)
    const wrongSide = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-05-13',
        voucherType: 'RECEIPT_VOUCHER',
        lines: [
          { accountId: acct('1101'), debit: '10.000' },
          { accountId: acct('1101'), credit: '4.000' },
          { accountId: acct('4101'), credit: '6.000' },
        ],
      });
    expect((await post(wrongSide.body.id)).status).toBe(400);

    // payment debiting cash instead of crediting it
    const payWrong = await api()
      .post('/api/v1/journal-entries')
      .set(auth(token))
      .send({
        entryDate: '2025-05-13',
        voucherType: 'PAYMENT_VOUCHER',
        lines: [
          { accountId: acct('1101'), debit: '10.000' },
          { accountId: acct('5204'), credit: '10.000' },
        ],
      });
    expect((await post(payWrong.body.id)).status).toBe(400);
  });

  it('filters journal list by voucher type', async () => {
    const receipts = await api()
      .get('/api/v1/journal-entries')
      .query({ voucherType: 'RECEIPT_VOUCHER' })
      .set(auth(token));
    expect(receipts.status).toBe(200);
    expect(receipts.body.items.length).toBeGreaterThan(0);
    for (const e of receipts.body.items) {
      expect(e.voucherType).toBe('RECEIPT_VOUCHER');
    }
    const payments = await api()
      .get('/api/v1/journal-entries')
      .query({ voucherType: 'PAYMENT_VOUCHER' })
      .set(auth(token));
    for (const e of payments.body.items) {
      expect(e.voucherType).toBe('PAYMENT_VOUCHER');
    }
  });

  it('isolates journal data between tenants', async () => {
    const regB = await api()
      .post('/api/v1/auth/register')
      .send({
        tenantName: `JE B ${RUN}`,
        ownerName: 'Owner B',
        email: `jeb-${RUN}@test.dev`,
        password: PASS,
      });
    expect(regB.status).toBe(201);
    const tokenB = regB.body.accessToken;
    const listB = await api().get('/api/v1/journal-entries').set(auth(tokenB));
    expect(listB.body).toMatchObject({ items: [], total: 0 });
    const tbB = await api()
      .get('/api/v1/reports/trial-balance')
      .set(auth(tokenB));
    expect(tbB.body.rows).toHaveLength(0);
    expect(tbB.body.balanced).toBe(true);
  });
});
