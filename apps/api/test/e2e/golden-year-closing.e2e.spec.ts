/**
 * Phase 18 (ADR-033): automatic year closing, branch/cost-centre allocations,
 * reopen and reclose. Golden results: Y1 +700, Y2 -250, Y3 +90.
 * Real MariaDB + built API. Run `pnpm --filter api build` first.
 */
import 'dotenv/config';
import { addMember } from './support/members.js';
import { bootApi, kit, m3, PASS, stopApi, type Booted } from './support/sales-order-kit.js';

const RUN = Date.now().toString(36);
const YEARS = [
  { code: '2031', start: '2031-01-01', end: '2031-12-31' },
  { code: '2032', start: '2032-01-01', end: '2032-12-31' },
  { code: '2033', start: '2033-01-01', end: '2033-12-31' },
  { code: '2034', start: '2034-01-01', end: '2034-12-31' },
  { code: '2035', start: '2035-01-01', end: '2035-12-31' },
  { code: '2036', start: '2036-01-01', end: '2036-12-31' },
  { code: '2037', start: '2037-01-01', end: '2037-12-31' },
];

let boot: Booted;
let h: ReturnType<typeof kit>;
let token = '';
let cashier = '';
let branchRestrictedAccountant = '';
const yearIds: string[] = [];
const accounts: Record<string, string> = {};
let branchA = '';
let branchB = '';
let costCenterA = '';
let costCenterB = '';
let retainedEarnings = '';
let tenantId = 0n;
let serviceItemId = '';
let customerId = '';
let warehouseId = '';

beforeAll(async () => {
  boot = await bootApi(3841);
  h = kit(boot.base, `yc-${RUN}`);
  const registration = h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Year Closing ${RUN}`,
      ownerName: 'Year Closing Owner',
      email: `year-closing-${RUN}@test.dev`,
      password: PASS,
    }),
    201,
    'register',
  );
  token = registration.accessToken as string;
  const tenantName = `Year Closing ${RUN}`;
  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [tenantName])) as {
    id: bigint;
  }[];
  const [plan] = (await boot.db.query(
    'SELECT id FROM plans WHERE max_branches >= 2 ORDER BY max_branches LIMIT 1',
  )) as { id: bigint }[];
  expect(tenant).toBeDefined();
  expect(plan).toBeDefined();
  tenantId = tenant!.id;
  await boot.db.query('UPDATE tenants SET plan_id = ? WHERE id = ?', [plan!.id, tenant!.id]);

  for (const year of YEARS) {
    const created = h.ok(
      await h.api()
        .post('/api/v1/fiscal-years')
        .set(h.auth(token))
        .send({ code: year.code, startDate: year.start, endDate: year.end }),
      201,
      `create year ${year.code}`,
    );
    yearIds.push(String(created.id));
  }
  const sequences = h.ok(
    await h.get(token, `document-sequences?fiscalYearId=${yearIds[0]}`),
    200,
    'document sequences',
  ) as { documentType: string; prefix: string }[];
  expect(sequences).toEqual(
    expect.arrayContaining([expect.objectContaining({ documentType: 'YEAR_CLOSING', prefix: 'CL' })]),
  );

  const chart = h.ok(await h.get(token, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;
  const mappings = h.ok(await h.get(token, 'account-mappings'), 200, 'mappings') as {
    mappingKey: string;
    accountId: string | null;
  }[];
  retainedEarnings = mappings.find((mapping) => mapping.mappingKey === 'RETAINED_EARNINGS')?.accountId ?? '';
  expect(retainedEarnings).not.toBe('');

  const branches = h.ok(await h.get(token, 'branches'), 200, 'branches') as { id: string }[];
  branchA = branches[0]!.id;
  const newBranch = h.ok(
    await h.api().post('/api/v1/branches').set(h.auth(token)).send({ code: `B${RUN}`, nameAr: 'فرع الإقفال', nameEn: 'Closing branch' }),
    201,
    'create second branch',
  );
  branchB = String(newBranch.id);

  const units = h.ok(await h.get(token, 'units'), 200, 'units') as { id: string; code: string }[];
  const pcsId = units.find((unit) => unit.code === 'PCS')!.id;
  const service = h.ok(
    await h.api()
      .post('/api/v1/items')
      .set(h.auth(token))
      .send({ code: `SVC${RUN}`, nameAr: 'خدمة الإقفال', itemKind: 'SERVICE', baseUnitId: pcsId }),
    201,
    'create service item',
  ) as { id: string };
  serviceItemId = service.id;
  const customer = h.ok(
    await h.api().post('/api/v1/parties').set(h.auth(token)).send({
      code: `C${RUN}`,
      nameAr: 'عميل الإقفال',
      partyType: 'CUSTOMER',
    }),
    201,
    'create customer',
  ) as { id: string };
  customerId = customer.id;
  const warehouse = h.ok(
    await h.api().post('/api/v1/warehouses').set(h.auth(token)).send({
      code: `W${RUN}`,
      nameAr: 'مستودع الإقفال',
      branchId: branchA,
    }),
    201,
    'create warehouse',
  ) as { id: string };
  warehouseId = warehouse.id;

  const centerA = h.ok(
    await h.api().post('/api/v1/cost-centers').set(h.auth(token)).send({ code: `CCA${RUN}`, nameAr: 'مركز أ', nameEn: 'Centre A' }),
    201,
    'create cost centre A',
  );
  const centerB = h.ok(
    await h.api().post('/api/v1/cost-centers').set(h.auth(token)).send({ code: `CCB${RUN}`, nameAr: 'مركز ب', nameEn: 'Centre B' }),
    201,
    'create cost centre B',
  );
  costCenterA = String(centerA.id);
  costCenterB = String(centerB.id);
  branchRestrictedAccountant = (
    await addMember(boot.base, token, {
      email: `year-closing-accountant-${RUN}@test.dev`,
      roleCode: 'ACCOUNTANT',
      password: PASS,
      branchIds: [branchA],
      defaultBranchId: branchA,
    })
  ).token;
}, 90_000);

afterAll(async () => {
  await stopApi(boot);
});

const year = (index: number) => YEARS[index]!;

async function postJournal(date: string, lines: object[], branchId?: string) {
  const create = h.api().post('/api/v1/journal-entries').set(h.auth(token));
  if (branchId) create.set('X-Branch-Id', branchId);
  const draft = h.ok(await create.send({ entryDate: date, lines }), 201, `draft journal ${date}`);
  return h.ok(await h.act(token, `journal-entries/${draft.id}/post`), 201, `post journal ${date}`);
}

async function fiscalYear(index: number) {
  return h.ok(await h.get(token, `fiscal-years/${yearIds[index]}`), 200, `year ${index + 1}`);
}

async function closeYear(index: number) {
  return h.ok(await h.act(token, `fiscal-years/${yearIds[index]}/close`), 201, `close year ${index + 1}`);
}

async function trialBalance(index: number, afterClosing: boolean) {
  const query = new URLSearchParams({
    from: year(index).start,
    to: year(index).end,
    afterClosing: String(afterClosing),
  });
  const tb = await h.get(token, `reports/trial-balance?${query}`);
  expect(tb.status).toBe(200);
  expect(tb.body.balanced).toBe(true);
  return tb.body as { rows: { code: string; closingDebit: string; closingCredit: string }[]; balanced: boolean };
}

async function verify(index: number) {
  const stock = await h.get(token, 'stock/verify');
  expect(stock.status).toBe(200);
  expect(stock.body.mismatches).toEqual([]);
  await trialBalance(index, false);
  await trialBalance(index, true);
}

async function closingEntry(index: number) {
  const fy = await fiscalYear(index);
  const activeClosing = fy.activeClosing as { id: string; journalEntryId: string | null; netResult: string } | null;
  if (!activeClosing) throw new Error(`Expected active closing for year ${year(index).code}`);
  const active = activeClosing;
  expect(active.journalEntryId).not.toBeNull();
  const entry = h.ok(await h.get(token, `journal-entries/${active.journalEntryId}`), 200, 'closing entry');
  expect(entry).toMatchObject({
    isClosing: true,
    sourceType: 'YEAR_CLOSING',
    sourceId: active.id,
    branchId: null,
  });
  expect(entry.entryNo).toMatch(/^CL-/);
  return { active, entry };
}

describe('Phase 18 golden year closing', () => {
  it('requires all-branch scope before reading year-closing data', async () => {
    const responses = [
      await h.get(branchRestrictedAccountant, `fiscal-years/${yearIds[0]}/closing-preview`),
      await h.act(branchRestrictedAccountant, `fiscal-years/${yearIds[0]}/close`),
      await h.act(branchRestrictedAccountant, `fiscal-years/${yearIds[0]}/open`),
    ];

    for (const response of responses) {
      expect(h.err(response)).toEqual([403, 'BRANCH_NOT_ALLOWED']);
      expect(response.body.details).toBeUndefined();
      expect(response.body.error?.details).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain(yearIds[0]);
      expect(JSON.stringify(response.body)).not.toContain('JOURNAL_ENTRY');
    }
  });

  it('blocks a later-year close and previews dated drafts', async () => {
    expect(accounts['1101']).toBeDefined();
    expect(accounts['4101']).toBeDefined();
    expect(accounts['5204']).toBeDefined();

    expect(h.err(await h.act(token, `fiscal-years/${yearIds[1]}/close`))).toEqual([409, 'PREVIOUS_YEAR_OPEN']);
    const draft = h.ok(
      await h.api().post('/api/v1/journal-entries').set(h.auth(token)).send({
        entryDate: '2031-03-01',
        description: 'Year-end adjustment draft',
        lines: [
          { accountId: accounts['1101'], debit: '1.000' },
          { accountId: accounts['4101'], credit: '1.000' },
        ],
      }),
      201,
      'draft for year four',
    );
    const payrollEmployee = h.ok(
      await h.api().post('/api/v1/payroll/employees').set(h.auth(token)).send({
        code: `PAY-${RUN}`, nameAr: 'Payroll draft', hireDate: '2031-01-01', payMethod: 'CASH',
      }),
      201,
      'payroll employee',
    );
    h.ok(
      await h.api().post(`/api/v1/payroll/employees/${payrollEmployee.id}/salaries`).set(h.auth(token)).send({
        effectiveFrom: '2031-01-01', basicSalary: '1.000',
      }),
      201,
      'payroll salary',
    );
    const payrollRun = h.ok(
      await h.api().post('/api/v1/payroll/runs').set(h.auth(token)).send({ period: '2031-03' }),
      201,
      'payroll draft run',
    );
    const preview = h.ok(
      await h.get(token, `fiscal-years/${yearIds[0]}/closing-preview`),
      200,
      'year four preview',
    );
    expect(preview.canClose).toBe(false);
    expect(preview.drafts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'PAYROLL_RUN',
          id: String(payrollRun.id),
          description: 'Payroll 2031-03',
        }),
        expect.objectContaining({
          type: 'JOURNAL_ENTRY',
          id: String(draft.id),
          description: 'Year-end adjustment draft',
        }),
      ]),
    );
    expect(h.err(await h.act(token, `fiscal-years/${yearIds[0]}/close`))).toEqual([409, 'YEAR_HAS_DRAFTS']);
    expect(h.ok(
      await h.api().delete(`/api/v1/journal-entries/${draft.id}`).set(h.auth(token)),
      200,
      'delete draft',
    )).toBeDefined();
    await boot.db.query('DELETE FROM payroll_runs WHERE id = ?', [payrollRun.id]);
    await verify(0);
    await verify(1);
  });

  it('Y1 closes a 700.000 profit into retained earnings', async () => {
    await postJournal('2031-06-01', [
      { accountId: accounts['1101'], debit: '1000.000' },
      { accountId: accounts['4101'], credit: '1000.000' },
    ]);
    await postJournal('2031-07-01', [
      { accountId: accounts['5204'], debit: '300.000' },
      { accountId: accounts['1101'], credit: '300.000' },
    ]);

    await closeYear(0);
    const { active, entry } = await closingEntry(0);
    expect(m3(active.netResult)).toBe('700.000');
    expect((entry.lines as { accountId: string; debit: string; credit: string }[]).map((line) => ({
      ...line,
      debit: m3(line.debit),
      credit: m3(line.credit),
    }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountId: accounts['4101'], debit: '1000.000', credit: '0.000' }),
        expect.objectContaining({ accountId: accounts['5204'], debit: '0.000', credit: '300.000' }),
        expect.objectContaining({ accountId: retainedEarnings, debit: '0.000', credit: '700.000' }),
      ]),
    );
    const before = await trialBalance(0, false);
    const after = await trialBalance(0, true);
    expect(before.rows.find((row) => row.code === '4101')).toMatchObject({ closingCredit: '1000.000' });
    expect(before.rows.find((row) => row.code === '5204')).toMatchObject({ closingDebit: '300.000' });
    expect(after.rows.find((row) => row.code === '4101')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    expect(after.rows.find((row) => row.code === '5204')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    const income = h.ok(
      await h.get(token, 'reports/income-statement?from=2031-01-01&to=2031-12-31'),
      200,
      'closed-year income statement',
    );
    expect(income.netProfit).toBe('700.000');
    const balanceSheet = h.ok(
      await h.get(token, 'reports/balance-sheet?asOf=2031-12-31'),
      200,
      'closed-year balance sheet',
    ) as {
      balanced: boolean;
      yearProfit: string;
      equity: { rows: { code: string; amount: string; isGroup: boolean }[] };
    };
    expect(balanceSheet.balanced).toBe(true);
    expect(balanceSheet.yearProfit).toBe('0.000');
    expect(balanceSheet.equity.rows.find((row) => row.code === '3102' && !row.isGroup)?.amount).toBe('700.000');
    expect(h.ok(
      await h.get(token, 'reports/income-statement?from=2032-01-01&to=2032-12-31'),
      200,
      'next-year income statement',
    ).netProfit).toBe('0.000');
    const nextYearBalance = h.ok(
      await h.get(token, 'reports/balance-sheet?asOf=2032-01-01'),
      200,
      'next-year opening balance sheet',
    ) as { balanced: boolean; priorYears: string };
    expect(nextYearBalance).toMatchObject({ balanced: true, priorYears: '0.000' });
    expect(h.err(await h.act(token, `fiscal-periods/${(await fiscalYear(0)).periods[0].id}/open`))).toEqual([
      409,
      'YEAR_CLOSED_REOPEN_YEAR',
    ]);
    await verify(0);
  });

  it('Y2 closes branch and cost-centre balances into two retained-earnings lines', async () => {
    await postJournal('2032-04-01', [
      { accountId: accounts['1101'], debit: '300.000' },
      { accountId: accounts['4101'], credit: '300.000', costCenterId: costCenterA },
    ], branchA);
    await postJournal('2032-05-01', [
      { accountId: accounts['5204'], debit: '500.000', costCenterId: costCenterA },
      { accountId: accounts['1101'], credit: '500.000' },
    ], branchA);
    await postJournal('2032-04-01', [
      { accountId: accounts['1101'], debit: '200.000' },
      { accountId: accounts['4101'], credit: '200.000', costCenterId: costCenterB },
    ], branchB);
    await postJournal('2032-05-01', [
      { accountId: accounts['5204'], debit: '250.000', costCenterId: costCenterB },
      { accountId: accounts['1101'], credit: '250.000' },
    ], branchB);

    const incomeBefore = h.ok(
      await h.get(token, 'reports/income-statement-by-cost-center?from=2032-01-01&to=2032-12-31'),
      200,
      'income by cost centre before closing',
    );
    expect(incomeBefore.netProfit.total).toBe('-250.000');
    await closeYear(1);
    const incomeAfter = h.ok(
      await h.get(token, 'reports/income-statement-by-cost-center?from=2032-01-01&to=2032-12-31'),
      200,
      'income by cost centre after closing',
    );
    expect(incomeAfter).toEqual(incomeBefore);
    const { active, entry } = await closingEntry(1);
    expect(m3(active.netResult)).toBe('-250.000');
    expect(h.err(await h.get(branchRestrictedAccountant, `journal-entries/${active.journalEntryId}`))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    const restrictedList = h.ok(
      await h.get(branchRestrictedAccountant, 'journal-entries'),
      200,
      'restricted journal list',
    ) as { items: { id: string }[] };
    expect(restrictedList.items.some((item) => item.id === active.journalEntryId)).toBe(false);
    const line = (accountId: string, branchId: string, costCenterId: string | null) =>
      entry.lines.find(
        (item: { accountId: string; branchId: string | null; costCenterId: string | null }) =>
          item.accountId === accountId && item.branchId === branchId && item.costCenterId === costCenterId,
      );
    const amounts = (row: { debit: string; credit: string } | undefined) => ({
      debit: m3(row!.debit),
      credit: m3(row!.credit),
    });
    expect(amounts(line(accounts['4101'], branchA, costCenterA))).toEqual({ debit: '300.000', credit: '0.000' });
    expect(amounts(line(accounts['5204'], branchA, costCenterA))).toEqual({ debit: '0.000', credit: '500.000' });
    expect(amounts(line(retainedEarnings, branchA, null))).toEqual({ debit: '200.000', credit: '0.000' });
    expect(amounts(line(accounts['4101'], branchB, costCenterB))).toEqual({ debit: '200.000', credit: '0.000' });
    expect(amounts(line(accounts['5204'], branchB, costCenterB))).toEqual({ debit: '0.000', credit: '250.000' });
    expect(amounts(line(retainedEarnings, branchB, null))).toEqual({ debit: '50.000', credit: '0.000' });
    const after = await trialBalance(1, true);
    expect(after.rows.find((row) => row.code === '4101')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    expect(after.rows.find((row) => row.code === '5204')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    await verify(1);
  });

  it('Y3 reopens, accepts a late entry, recloses for 90.000, and prevents reopening Y2', async () => {
    await postJournal('2033-02-01', [
      { accountId: accounts['1101'], debit: '120.000' },
      { accountId: accounts['4101'], credit: '120.000' },
    ]);
    await closeYear(2);
    const first = await closingEntry(2);
    expect(m3(first.active.netResult)).toBe('120.000');

    h.ok(await h.act(token, `fiscal-years/${yearIds[2]}/open`), 201, 'reopen year three');
    const [reversedClosing] = (await boot.db.query(
      'SELECT status, reversal_entry_id AS reversalEntryId FROM fiscal_year_closings WHERE tenant_id = ? AND id = ?',
      [tenantId, first.active.id],
    )) as { status: string; reversalEntryId: bigint | null }[];
    expect(reversedClosing?.status).toBe('REVERSED');
    expect(reversedClosing?.reversalEntryId).not.toBeNull();
    const [reversal] = (await boot.db.query(
      `SELECT is_closing AS isClosing, DATE_FORMAT(entry_date, '%Y-%m-%d') AS entryDate
       FROM journal_entries WHERE tenant_id = ? AND id = ?`,
      [tenantId, reversedClosing!.reversalEntryId],
    )) as { isClosing: number; entryDate: string }[];
    expect(Number(reversal?.isClosing)).toBe(1);
    expect(reversal?.entryDate).toBe('2033-12-31');
    expect(h.err(await h.get(branchRestrictedAccountant, `journal-entries/${reversedClosing!.reversalEntryId}`))).toEqual([
      404,
      'NOT_FOUND',
    ]);
    const reversalList = h.ok(
      await h.get(branchRestrictedAccountant, 'journal-entries'),
      200,
      'restricted journal list after reversal',
    ) as { items: { id: string }[] };
    expect(reversalList.items.some((item) => item.id === String(reversedClosing!.reversalEntryId))).toBe(false);
    await postJournal('2033-11-01', [
      { accountId: accounts['5204'], debit: '30.000' },
      { accountId: accounts['1101'], credit: '30.000' },
    ]);
    await closeYear(2);
    const second = await closingEntry(2);
    expect(m3(second.active.netResult)).toBe('90.000');
    const after = await trialBalance(2, true);
    expect(after.rows.find((row) => row.code === '4101')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    expect(after.rows.find((row) => row.code === '5204')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });
    expect(h.err(await h.act(token, `fiscal-years/${yearIds[1]}/open`))).toEqual([409, 'LATER_YEAR_CLOSED']);

    cashier = (
      await addMember(boot.base, token, {
        email: `year-closing-cashier-${RUN}@test.dev`,
        roleCode: 'CASHIER',
        password: PASS,
      })
    ).token;
    expect(h.err(await h.act(cashier, `fiscal-years/${yearIds[2]}/open`))[0]).toBe(403);
    await verify(2);
  });

  it('serializes a concurrent invoice post and year close without closing a draft', async () => {
    const invoice = h.ok(
      await h.api().post('/api/v1/sales-invoices').set(h.auth(token)).set('X-Branch-Id', branchA).send({
        invoiceDate: '2034-06-01',
        customerId,
        warehouseId,
        paymentType: 'CREDIT',
        lines: [{ itemId: serviceItemId, qty: '1', unitPrice: '100.000' }],
      }),
      201,
      'create close-race invoice',
    ) as { id: string };
    const [post, close] = await Promise.all([
      h.act(token, `sales-invoices/${invoice.id}/post`),
      h.act(token, `fiscal-years/${yearIds[3]}/close`),
    ]);
    if (post.status === 201 && close.status === 409) {
      expect(h.err(close)).toEqual([409, 'YEAR_HAS_DRAFTS']);
      await closeYear(3);
    } else {
      expect(close.status).toBe(201);
      if (post.status !== 201) {
        expect(h.err(post)).toEqual([409, 'PERIOD_CLOSED']);
      }
    }
    const closed = await fiscalYear(3);
    expect(m3(closed.closings[0].netResult)).toBe('100.000');
    await verify(3);
  });

  it('allows concurrent close requests to create one empty-year closure row', async () => {
    const [first, second] = await Promise.all([
      h.act(token, `fiscal-years/${yearIds[4]}/close`),
      h.act(token, `fiscal-years/${yearIds[4]}/close`),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect([first, second].find((response) => response.status === 409)?.body.error.code).toBe('YEAR_ALREADY_CLOSED');
    const closed = await fiscalYear(4);
    expect(closed.activeClosing).not.toBeNull();
    expect(closed.closings).toHaveLength(1);
    expect(closed.closings[0].journalEntryId).toBeNull();
    expect(m3(closed.closings[0].netResult)).toBe('0.000');
    await verify(4);
  });

  it('closes and reopens with an inactive cost centre that still has a balance', async () => {
    await postJournal('2036-04-01', [
      { accountId: accounts['1101'], debit: '60.000' },
      { accountId: accounts['4101'], credit: '60.000', costCenterId: costCenterA },
    ]);
    expect(
      h.ok(
        await h.api().patch(`/api/v1/cost-centers/${costCenterA}`).set(h.auth(token)).send({ isActive: false }),
        200,
        'deactivate used cost centre before closing',
      ).isActive,
    ).toBe(false);

    await closeYear(5);
    const closed = await closingEntry(5);
    expect(m3(closed.active.netResult)).toBe('60.000');
    expect((await trialBalance(5, true)).rows.find((row) => row.code === '4101')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '0.000',
    });

    h.ok(
      await h.api().patch(`/api/v1/cost-centers/${costCenterA}`).set(h.auth(token)).send({ isActive: true }),
      200,
      'reactivate cost centre after closing',
    );
    expect(
      h.ok(
        await h.api().patch(`/api/v1/cost-centers/${costCenterA}`).set(h.auth(token)).send({ isActive: false }),
        200,
        'deactivate cost centre after closing',
      ).isActive,
    ).toBe(false);

    h.ok(await h.act(token, `fiscal-years/${yearIds[5]}/open`), 201, 'reopen year with inactive cost centre');
    expect((await trialBalance(5, true)).rows.find((row) => row.code === '4101')).toMatchObject({
      closingDebit: '0.000',
      closingCredit: '60.000',
    });
    await closeYear(5);
    await verify(5);
  });

  it('closes a year after all periods were closed individually', async () => {
    await postJournal('2037-03-01', [
      { accountId: accounts['1101'], debit: '25.000' },
      { accountId: accounts['4101'], credit: '25.000' },
    ]);
    const before = await fiscalYear(6);
    for (const period of before.periods as { id: string }[]) {
      h.ok(await h.act(token, `fiscal-periods/${period.id}/close`), 201, 'close period individually');
    }
    const periodsClosed = await fiscalYear(6);
    expect(periodsClosed.status).toBe('CLOSED');
    expect(periodsClosed.activeClosing).toBeNull();

    await closeYear(6);
    const closed = await fiscalYear(6);
    expect(closed.activeClosing).not.toBeNull();
    expect(closed.activeClosing.journalEntryId).not.toBeNull();
    expect(m3(closed.activeClosing.netResult)).toBe('25.000');
    await closingEntry(6);
    await verify(6);
  });
});
