/**
 * Phase 21 (ADR-036): cash flow statement, indirect method.
 * Golden results C1–C3 (BUILD_PLAN §18). Real MariaDB + built API. Run `pnpm --filter api build` first.
 */
import 'dotenv/config';
import { addMember } from './support/members.js';
import { bootApi, kit, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);

let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let tokenB = '';
let restricted = '';
const accounts: Record<string, string> = {};
const years: Record<string, string> = {};

interface CashFlow {
  netProfit: string;
  operating: { total: string; rows: { code: string; amount: string }[] };
  investing: { total: string; rows: { code: string; amount: string }[] };
  financing: { total: string; rows: { code: string; amount: string }[] };
  netChange: string;
  openingCash: string;
  closingCash: string;
  reconciles: boolean;
}

async function register(prefix: string) {
  const body = h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Cash Flow ${prefix} ${RUN}`,
      ownerName: 'Owner',
      email: `cash-flow-${prefix}-${RUN}@test.dev`,
      password: PASS,
    }),
    201,
    `register ${prefix}`,
  );
  return body.accessToken as string;
}

async function journal(date: string, debit: string, credit: string, amount: string) {
  const draft = h.ok(
    await h.api()
      .post('/api/v1/journal-entries')
      .set(h.auth(token))
      .send({
        entryDate: date,
        lines: [
          { accountId: accounts[debit], debit: amount },
          { accountId: accounts[credit], credit: amount },
        ],
      }),
    201,
    `draft ${debit}/${credit}`,
  );
  h.ok(await h.act(token, `journal-entries/${draft.id}/post`), 201, `post ${debit}/${credit}`);
}

const report = async (from: string, to: string, as = token) =>
  h.ok(await h.get(as, `reports/cash-flow?from=${from}&to=${to}`), 200, `cash flow ${from}`) as CashFlow;

async function cashInTrialBalance(from: string, to: string): Promise<string[]> {
  const tb = h.ok(await h.get(token, `reports/trial-balance?from=${from}&to=${to}`), 200, 'trial balance');
  expect(tb.balanced).toBe(true);
  const rows = tb.rows as { code: string; closingDebit: string; closingCredit: string }[];
  return ['1101', '1102'].map((code) => rows.find((r) => r.code === code)?.closingDebit ?? '0.000');
}

beforeAll(async () => {
  boot = await bootApi(3852);
  h = kit(boot.base, `cf-${RUN}`);
  token = await register('a');
  tokenB = await register('b');
  for (const code of ['2031', '2032']) {
    const year = h.ok(
      await h.api()
        .post('/api/v1/fiscal-years')
        .set(h.auth(token))
        .send({ code, startDate: `${code}-01-01`, endDate: `${code}-12-31` }),
      201,
      `year ${code}`,
    ) as { id: string };
    years[code] = String(year.id);
  }
  const chart = h.ok(await h.get(token, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;

  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`Cash Flow a ${RUN}`])) as { id: bigint }[];
  const [plan] = (await boot.db.query('SELECT id FROM plans WHERE max_branches >= 2 ORDER BY max_branches LIMIT 1')) as {
    id: bigint;
  }[];
  await boot.db.query('UPDATE tenants SET plan_id = ? WHERE id = ?', [plan!.id, tenant!.id]);
  const branches = h.ok(await h.get(token, 'branches'), 200, 'branches') as { id: string }[];
  h.ok(
    await h.api().post('/api/v1/branches').set(h.auth(token)).send({ code: `B${RUN}`, nameAr: 'فرع ثان', nameEn: 'Second branch' }),
    201,
    'branch',
  );
  restricted = (
    await addMember(boot.base, token, {
      email: `cash-flow-accountant-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      branchIds: [branches[0]!.id],
      defaultBranchId: branches[0]!.id,
    })
  ).token;
}, 90_000);

afterAll(async () => {
  await stopApi(boot);
});

describe('C1 — a year of cash flows', () => {
  it('splits the net change in cash into the three activities', async () => {
    await journal('2031-01-02', '1101', '3101', '5000.000');
    await journal('2031-02-01', '1105', '1101', '160.000');
    await journal('2031-03-01', '1101', '4101', '3000.000');
    await journal('2031-04-01', '5202', '2103', '800.000');
    await journal('2031-05-01', '5201', '1102', '1200.000');
    await journal('2031-06-01', '1201', '1102', '2500.000');
    await journal('2031-12-31', '5204', '1202', '250.000');
    await journal('2031-02-15', '1102', '1101', '4000.000');
    await journal('2031-11-01', '3102', '1101', '300.000');

    const r = await report('2031-01-01', '2031-12-31');
    expect(r).toMatchObject({
      netProfit: '750.000',
      operating: { total: '1640.000' },
      investing: { total: '-2500.000', rows: [{ code: '1201', amount: '-2500.000' }] },
      financing: { total: '4700.000' },
      netChange: '3840.000',
      openingCash: '0.000',
      closingCash: '3840.000',
      reconciles: true,
    });
    expect(r.operating.rows.map((x) => [x.code, x.amount])).toEqual([
      ['1105', '-160.000'],
      ['1202', '250.000'],
      ['2103', '800.000'],
    ]);
    expect(await cashInTrialBalance('2031-01-01', '2031-12-31')).toEqual(['3540.000', '300.000']);
  });

  it('exports PDF and XLSX', async () => {
    const pdf = await h.get(token, 'reports/cash-flow?from=2031-01-01&to=2031-12-31&format=pdf&lang=ar');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('pdf');
    const xlsx = await h.get(token, 'reports/cash-flow?from=2031-01-01&to=2031-12-31&format=xlsx&lang=en');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('C2 — after the year closes', () => {
  it('keeps 2031 unchanged and opens 2032 with its closing cash', async () => {
    const before = await report('2031-01-01', '2031-12-31');
    h.ok(await h.act(token, `fiscal-years/${years['2031']}/close`), 201, 'close 2031');
    expect(await report('2031-01-01', '2031-12-31')).toEqual(before);

    await journal('2032-01-10', '1101', '4201', '100.000');
    const next = await report('2032-01-01', '2032-12-31');
    expect(next).toMatchObject({
      netProfit: '100.000',
      operating: { total: '100.000', rows: [] },
      investing: { total: '0.000' },
      financing: { total: '0.000' },
      netChange: '100.000',
      openingCash: '3840.000',
      closingCash: '3940.000',
      reconciles: true,
    });
  });
});

describe('C3 — reclassification and refusals', () => {
  it('moves accrued expenses to financing without changing the net change', async () => {
    h.ok(
      await h.api().patch(`/api/v1/accounts/${accounts['2103']}`).set(h.auth(token)).send({ cashFlowActivity: 'FINANCING' }),
      200,
      'reclassify 2103',
    );
    const r = await report('2031-01-01', '2031-12-31');
    expect([r.operating.total, r.financing.total, r.netChange]).toEqual(['840.000', '5500.000', '3840.000']);
    h.ok(
      await h.api().patch(`/api/v1/accounts/${accounts['2103']}`).set(h.auth(token)).send({ cashFlowActivity: null }),
      200,
      'back to default',
    );
    expect((await report('2031-01-01', '2031-12-31')).operating.total).toBe('1640.000');
  });

  it('refuses an activity on revenue, expense and cash accounts', async () => {
    for (const code of ['4101', '5202', '1101', '1102']) {
      expect(
        h.err(await h.api().patch(`/api/v1/accounts/${accounts[code]}`).set(h.auth(token)).send({ cashFlowActivity: 'OPERATING' })),
      ).toEqual([400, 'VALIDATION']);
    }
    expect(
      h.err(await h.api().patch(`/api/v1/accounts/${accounts['2103']}`).set(h.auth(token)).send({ cashFlowActivity: 'OTHER' })),
    ).toEqual([400, 'VALIDATION']);
  });

  it('keeps tenant B out and refuses a branch-restricted member', async () => {
    const b = await report('2031-01-01', '2031-12-31', tokenB);
    expect(b).toMatchObject({ netProfit: '0.000', netChange: '0.000', closingCash: '0.000' });
    expect(h.err(await h.get(restricted, 'reports/cash-flow?from=2031-01-01&to=2031-12-31'))).toEqual([403, 'ALL_BRANCHES_REQUIRED']);
  });
});
