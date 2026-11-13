/**
 * Several fiscal years, no closing entry (ADR-008 §7, owner's option B):
 *  - from a fiscal-year start, revenue and expense accounts open at zero;
 *    earlier years' unclosed profit is one computed equity row, so the
 *    trial balance still balances and agrees with the balance sheet;
 *  - mid-year, P&L accounts open with the year-to-date only;
 *  - the account statement of a P&L account follows the same rule; a
 *    balance-sheet account carries its whole history;
 *  - closing a year closes all its periods (no posting), reopening opens
 *    them; the permission and tenant isolation hold.
 * Real MariaDB (erp_test) + built API. Run `pnpm build` before `pnpm test`.
 */
import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { addMember } from './support/members.js';

const API_PORT = 3212;
const BASE = `http://127.0.0.1:${API_PORT}`;
const RUN = Date.now().toString(36);
const PASS = 'test-password-123';

let server: ChildProcess;

const api = () => request(BASE);
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const idem = () => ({ 'Idempotency-Key': `fr-${RUN}-${Math.random().toString(36).slice(2)}` });
const m3 = (v: Decimal.Value) => new Decimal(v).toFixed(3);

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
  await waitForHealth();
}, 60_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await once(server, 'exit').catch(() => undefined);
});

type Row = Record<string, string> & { kind: string | null };

describe('Fiscal year rollover', () => {
  let token = '';
  let tokenB = '';
  let cashier = '';
  let fy2025 = '';
  const acc: Record<string, string> = {};

  async function entry(date: string, lines: object[]) {
    const je = await api().post('/api/v1/journal-entries').set(auth(token)).send({ entryDate: date, lines });
    expect(je.status).toBe(201);
    const posted = await api().post(`/api/v1/journal-entries/${je.body.id}/post`).set(auth(token)).set(idem());
    return posted;
  }
  const sale = (date: string, amount: string) =>
    entry(date, [
      { accountId: acc['1101'], debit: amount },
      { accountId: acc['4101'], credit: amount },
    ]);

  async function tb(query: string) {
    const res = await api().get(`/api/v1/reports/trial-balance?${query}`).set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    return res.body as { rows: Row[]; nominalFrom: string | null };
  }
  const six = (r: Row | undefined) =>
    r && ['openingDebit', 'openingCredit', 'periodDebit', 'periodCredit', 'closingDebit', 'closingCredit'].map((k) => m3(r[k]));

  it('setup: two fiscal years; 2025 profit 700, 2026 sales in March and May', async () => {
    const reg = await api()
      .post('/api/v1/auth/register')
      .send({ tenantName: `FR ${RUN}`, ownerName: 'Owner', email: `fr-${RUN}@test.dev`, password: PASS });
    token = reg.body.accessToken;
    tokenB = (
      await api()
        .post('/api/v1/auth/register')
        .send({ tenantName: `FR B ${RUN}`, ownerName: 'Owner B', email: `frb-${RUN}@test.dev`, password: PASS })
    ).body.accessToken;
    for (const y of ['2025', '2026']) {
      const fy = await api().post('/api/v1/fiscal-years').set(auth(token)).send({ code: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` });
      expect(fy.status).toBe(201);
      if (y === '2025') fy2025 = fy.body.id;
    }
    for (const a of (await api().get('/api/v1/accounts').set(auth(token))).body as { id: string; code: string }[]) acc[a.code] = a.id;

    expect((await sale('2025-06-01', '1000')).status).toBe(201);
    expect(
      (
        await entry('2025-07-01', [
          { accountId: acc['5204'], debit: '300' },
          { accountId: acc['1101'], credit: '300' },
        ])
      ).status,
    ).toBe(201);
    expect((await sale('2026-03-10', '50')).status).toBe(201);
    expect((await sale('2026-05-10', '200')).status).toBe(201);

    cashier = (
      await addMember(BASE, token, { email: `fr-cash-${RUN}@test.dev`, roleCode: 'CASHIER', password: PASS })
    ).token;
  });

  it('from the year start: P&L opens at zero, prior profit is one equity row', async () => {
    const r = await tb('from=2026-01-01&to=2026-12-31');
    expect(r.nominalFrom).toBe('2026-01-01');
    const row = (code: string) => r.rows.find((x) => x.code === code);
    expect(six(row('4101'))).toEqual(['0.000', '0.000', '0.000', '250.000', '0.000', '250.000']);
    expect(row('5204')).toBeUndefined(); // only 2025 lines: nothing of its own in 2026
    expect(six(row('1101'))).toEqual(['700.000', '0.000', '250.000', '0.000', '950.000', '0.000']);
    const prior = r.rows.find((x) => x.kind === 'PRIOR_YEARS');
    expect(six(prior)).toEqual(['0.000', '700.000', '0.000', '0.000', '0.000', '700.000']);

    // The balance sheet shows the same prior-years figure.
    const bs = await api().get('/api/v1/reports/balance-sheet?asOf=2026-12-31').set(auth(token));
    expect(m3(bs.body.priorYears)).toBe(m3(prior!.openingCredit));
  });

  it('mid-year: P&L opens with the year-to-date only', async () => {
    const r = await tb('from=2026-04-01&to=2026-12-31');
    const row = (code: string) => r.rows.find((x) => x.code === code);
    expect(six(row('4101'))).toEqual(['0.000', '50.000', '0.000', '200.000', '0.000', '250.000']);
    expect(six(r.rows.find((x) => x.kind === 'PRIOR_YEARS'))).toEqual(['0.000', '700.000', '0.000', '0.000', '0.000', '700.000']);
  });

  it('within the first year there is no prior row, and no dates means all history', async () => {
    const first = await tb('from=2025-01-01&to=2025-12-31');
    expect(first.rows.some((x) => x.kind === 'PRIOR_YEARS')).toBe(false);
    const all = await tb('');
    expect(all.nominalFrom).toBeNull();
    expect(all.rows.some((x) => x.kind === 'PRIOR_YEARS')).toBe(false);
    expect(six(all.rows.find((x) => x.code === '4101'))).toEqual(['0.000', '0.000', '0.000', '1250.000', '0.000', '1250.000']);
  });

  it('account statements: a P&L account restarts, a cash account carries over', async () => {
    const revenue = await api().get(`/api/v1/reports/general-ledger?accountId=${acc['4101']}&from=2026-01-01`).set(auth(token));
    expect([m3(revenue.body.openingBalance), revenue.body.rows.length, m3(revenue.body.closingBalance)]).toEqual([
      '0.000',
      2,
      '-250.000',
    ]);
    const cash = await api().get(`/api/v1/reports/general-ledger?accountId=${acc['1101']}&from=2026-01-01`).set(auth(token));
    expect(m3(cash.body.openingBalance)).toBe('700.000');
  });

  it('closing a year closes every period and blocks posting; reopening undoes it', async () => {
    expect((await api().post(`/api/v1/fiscal-years/${fy2025}/close`).set(auth(cashier))).status).toBe(403);
    expect((await api().post(`/api/v1/fiscal-years/${fy2025}/close`).set(auth(tokenB))).status).toBe(404);

    const closed = await api().post(`/api/v1/fiscal-years/${fy2025}/close`).set(auth(token));
    expect(closed.status).toBe(201);
    expect(closed.body.status).toBe('CLOSED');
    expect((closed.body.periods as { status: string }[]).every((p) => p.status === 'CLOSED')).toBe(true);
    const late = await sale('2025-12-20', '5');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('PERIOD_CLOSED');

    // Reopening one period opens the year again.
    const december = (closed.body.periods as { id: string; periodNo: number }[]).find((p) => p.periodNo === 12)!;
    expect((await api().post(`/api/v1/fiscal-periods/${december.id}/open`).set(auth(token))).status).toBe(201);
    const after = await api().get(`/api/v1/fiscal-years/${fy2025}`).set(auth(token));
    expect(after.body.status).toBe('OPEN');

    const reopened = await api().post(`/api/v1/fiscal-years/${fy2025}/open`).set(auth(token));
    expect(reopened.status).toBe(201);
    expect((reopened.body.periods as { status: string }[]).every((p) => p.status === 'OPEN')).toBe(true);
    expect((await sale('2025-12-20', '5')).status).toBe(201);
  });
});
