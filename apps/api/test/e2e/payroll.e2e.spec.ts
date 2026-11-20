/**
 * Phase 26 payroll acceptance (ADR-041): PY1 calculation/posting, PY2 payment
 * and reversal, PY3 draft locks/concurrent posting, and tenant/company isolation.
 * Real MariaDB and built API; run `pnpm build` before this spec.
 */
import 'dotenv/config';
import { bootApi, kit, PASS, stopApi, type Booted } from './support/sales-order-kit.js';
import { addMember } from './support/members.js';

const RUN = Date.now().toString(36);
let boot: Booted;
let h: ReturnType<typeof kit>;
let tokenA = '';
let tokenB = '';
let companyAId = '';
let tenantId = 0n;
let bankAccountId = '';
let costCenterId = '';
const accounts: Record<string, string> = {};

const register = async (prefix: string) =>
  (h.ok(
    await h.api().post('/api/v1/auth/register').send({
      tenantName: `Payroll ${prefix} ${RUN}`,
      ownerName: 'Owner',
      email: `payroll-${prefix}-${RUN}@test.dev`,
      password: PASS,
    }),
    201,
    `register ${prefix}`,
  ) as { accessToken: string }).accessToken;

const act = (token: string, path: string, body: object, companyId?: string) => {
  const request = h.act(token, path, body);
  if (companyId) request.set('X-Company-Id', companyId);
  return request;
};

const post = async <T extends object>(
  token: string,
  path: string,
  body: object,
  what: string,
  companyId?: string,
): Promise<T> => h.ok(await act(token, path, body, companyId), 201, what) as T;

const get = (token: string, path: string, companyId?: string) => {
  const request = h.get(token, path);
  if (companyId) request.set('X-Company-Id', companyId);
  return request;
};

async function accountBalance(code: string): Promise<string> {
  const [row] = (await boot.db.query(
    `SELECT CAST(COALESCE(SUM(l.debit - l.credit), 0) AS CHAR) AS b
       FROM journal_lines l
       JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.journal_entry_id
      WHERE l.tenant_id = ? AND l.account_id = ?`,
    [tenantId, accounts[code]],
  )) as { b: string }[];
  return row?.b ?? '0.000';
}

async function expectBalanced() {
  const tb = await get(tokenA, 'reports/trial-balance?from=2031-01-01&to=2031-12-31', companyAId);
  expect(tb.status).toBe(200);
  expect(tb.body.balanced).toBe(true);
}

beforeAll(async () => {
  boot = await bootApi(3862);
  h = kit(boot.base, `payroll-${RUN}`);
  tokenA = await register('a');
  tokenB = await register('b');
  const companies = h.ok(await h.get(tokenA, 'companies'), 200, 'companies') as { id: string }[];
  companyAId = companies[0]!.id;
  const branch = (h.ok(await get(tokenA, 'branches', companyAId), 200, 'company branch') as { id: string }[])[0]!;
  const costCenter = await post<{ id: string }>(tokenA, 'cost-centers', { code: `PAY-${RUN}`, nameAr: 'Payroll' }, 'payroll cost centre', companyAId);
  costCenterId = costCenter.id;
  const restricted = await addMember(boot.base, tokenA, {
    email: `payroll-restricted-${RUN}@test.dev`,
    roleCode: 'ACCOUNTANT',
    password: PASS,
    branchIds: [branch.id],
    defaultBranchId: branch.id,
  });
  const restrictedPayroll = await get(restricted.token, 'payroll/employees', companyAId);
  expect(restrictedPayroll.status).toBe(403);
  expect(restrictedPayroll.body.error.code).toBe('ALL_BRANCHES_REQUIRED');
  const [tenant] = (await boot.db.query('SELECT id FROM tenants WHERE name = ?', [`Payroll a ${RUN}`])) as { id: bigint }[];
  tenantId = tenant!.id;
  h.ok(
    await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).send({
      code: '2031',
      startDate: '2031-01-01',
      endDate: '2031-12-31',
    }),
    201,
    'create fiscal year',
  );
  const chart = h.ok(await h.get(tokenA, 'accounts'), 200, 'accounts') as { id: string; code: string }[];
  for (const account of chart) accounts[account.code] = account.id;
  const bank = h.ok(await h.api().post('/api/v1/bank-accounts').set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({
    bankName: 'Arab Bank',
    accountId: accounts['1102'],
  }), 201, 'create payroll bank account') as { id: string };
  bankAccountId = bank.id;
}, 90_000);

afterAll(async () => stopApi(boot));

describe('Payroll PY1–PY3', () => {
  it('calculates, posts, pays and reverses the golden run; enforces run/input locks and isolation', async () => {
    const otherCompany = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(tokenA)).send({ legalNameAr: 'الشركة الثانية', legalNameEn: 'Second Co' }),
      201,
      'create second company',
    ) as { id: string };
    const noEmployees = await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId);
    expect(noEmployees.status).toBe(409);
    expect(noEmployees.body.error.code).toBe('PAYROLL_NO_EMPLOYEES');

    const elements = h.ok(await get(tokenA, 'payroll/elements', companyAId), 200, 'pay elements') as { id: string; code: string }[];
    const elementId = Object.fromEntries(elements.map((item) => [item.code, item.id])) as Record<string, string>;
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', hoursPerMonth: '0',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', sscEmployeeRate: '1.1',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', sscMinWage: '500', sscMaxWage: '400',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, 'payroll/elements', {
      code: `CASH-${RUN}`, nameAr: 'Cash', kind: 'EARNING', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['1101'],
    }, companyAId)).status).toBe(400);
    const employeeA = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `A-${RUN}`, nameAr: 'الموظف أ', hireDate: '2031-01-01', payMethod: 'BANK',
    }, 'employee A', companyAId);
    const employeeB = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `B-${RUN}`, nameAr: 'الموظف ب', hireDate: '2031-01-01', payMethod: 'CASH', sscCovered: false, costCenterId,
    }, 'employee B', companyAId);
    expect((await act(tokenA, 'payroll/inputs', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, period: '2031-01', amount: null,
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: null, validFrom: '2031-01-01',
    }, companyAId)).status).toBe(400);
    const costCenterDelete = await h.api().delete(`/api/v1/cost-centers/${costCenterId}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId);
    expect(costCenterDelete.status).toBe(409);
    expect(costCenterDelete.body.error.code).toBe('COST_CENTER_IN_USE');
    h.ok(await act(tokenA, `payroll/employees/${employeeA.id}/salaries`, {
      effectiveFrom: '2031-01-01', basicSalary: '500.000',
    }, companyAId), 201, 'salary A');
    h.ok(await act(tokenA, `payroll/employees/${employeeB.id}/salaries`, {
      effectiveFrom: '2031-01-01', basicSalary: '400.000',
    }, companyAId), 201, 'salary B');

    await post(tokenA, 'payroll/inputs', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, period: '2031-01', amount: '50.000',
    }, 'transport', companyAId);
    for (const [date, quantity] of [['2031-01-10', '6'], ['2031-01-11', '4']]) {
      await post(tokenA, 'payroll/inputs', {
        employeeId: employeeA.id, payElementId: elementId.OVERTIME_125, period: '2031-01', workDate: date, quantity,
      }, `overtime ${quantity}`, companyAId);
    }
    await post(tokenA, 'payroll/inputs', {
      employeeId: employeeA.id, payElementId: elementId.ADVANCE_REPAYMENT, period: '2031-01', amount: '25.000',
    }, 'advance repayment', companyAId);
    for (const [date, quantity] of [['2031-01-12', '1'], ['2031-01-13', '1']]) {
      await post(tokenA, 'payroll/inputs', {
        employeeId: employeeB.id, payElementId: elementId.ABSENCE_DAY, period: '2031-01', workDate: date, quantity,
      }, `absence ${quantity}`, companyAId);
    }
    const run = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId), 201, 'create and compute run') as {
      id: string;
      lines: {
        id: string; employeeId: string; basic: string; earnings: string; gross: string; sscBase: string;
        sscEmployee: string; sscEmployer: string; incomeTax: string; deductions: string; net: string;
        items: { amount: string }[];
      }[];
    };
    const lineA = run.lines.find((line) => line.employeeId === employeeA.id)!;
    const lineB = run.lines.find((line) => line.employeeId === employeeB.id)!;
    expect([lineA.basic, lineA.earnings, lineA.gross, lineA.sscBase, lineA.sscEmployee, lineA.sscEmployer, lineA.net])
      .toEqual(['500', '76.042', '576.042', '526.042', '39.453', '74.961', '511.589']);
    expect([lineB.basic, lineB.earnings, lineB.gross, lineB.sscBase, lineB.sscEmployee, lineB.sscEmployer, lineB.deductions, lineB.net])
      .toEqual(['400', '0', '400', '0', '0', '0', '26.667', '373.333']);
    expect(lineA.items.map((item) => item.amount).sort()).toEqual(['25', '26.042', '50']);
    expect(lineB.items.map((item) => item.amount)).toEqual(['26.667']);
    h.ok(await h.api().patch(`/api/v1/payroll/runs/${run.id}/lines/${lineA.id}/income-tax`).set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ incomeTax: '12.500' }), 200, 'set A tax');
    const updated = h.ok(await get(tokenA, `payroll/runs/${run.id}`, companyAId), 200, 'run detail') as {
      netTotal: string;
      lines: { id: string; net: string }[];
      grossTotal: string;
      sscEmployeeTotal: string;
      sscEmployerTotal: string;
      deductionsTotal: string;
    };
    expect(updated.netTotal).toBe('872.422');
    expect(updated.lines.find((line) => line.id === lineA.id)?.net).toBe('499.089');
    expect([updated.grossTotal, updated.sscEmployeeTotal, updated.sscEmployerTotal, updated.deductionsTotal])
      .toEqual(['976.042', '39.453', '74.961', '51.667']);
    expect((await get(tokenA, 'payroll/reports/register?period=2031-01', companyAId)).status).toBe(200);
    expect((await get(tokenA, 'payroll/reports/ssc?period=2031-01', companyAId)).status).toBe(200);
    expect((await get(tokenA, 'payroll/reports/tax-withheld?period=2031-01', companyAId)).status).toBe(200);
    const payslip = await get(tokenA, `payroll/runs/${run.id}/lines/${lineA.id}/payslip`, companyAId);
    expect(payslip.status).toBe(200);
    expect(payslip.headers['content-type']).toContain('application/pdf');

    const companyList = h.ok(await get(tokenA, 'payroll/employees', otherCompany.id), 200, 'company B employee list') as { id: string }[];
    expect(companyList.some((employee) => employee.id === employeeA.id)).toBe(false);
    const foreignRun = await get(tokenB, `payroll/runs/${run.id}`);
    expect(foreignRun.status).toBe(404);
    const foreignDelete = await h.api().delete(`/api/v1/payroll/runs/${run.id}`).set(h.auth(tokenA)).set('X-Company-Id', otherCompany.id);
    expect(foreignDelete.status).toBe(404);

    const posted = await act(tokenA, `payroll/runs/${run.id}/post`, {}, companyAId);
    h.ok(posted, 201, 'post payroll run');
    const deletePosted = await h.api().delete(`/api/v1/payroll/runs/${run.id}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId);
    expect(deletePosted.status).toBe(409);
    expect(deletePosted.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const journalLines = (await boot.db.query(
      `SELECT a.code, CAST(SUM(l.debit) AS CHAR) AS debit, CAST(SUM(l.credit) AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ?
        GROUP BY a.code`,
      [tenantId, run.id],
    )) as { code: string; debit: string; credit: string }[];
    const actualJournal = new Map(journalLines.map((line) => [line.code, [line.debit, line.credit]]));
    expect(actualJournal.get('5201')).toEqual(['976.042', '0.000']);
    expect(actualJournal.get('5206')).toEqual(['74.961', '0.000']);
    expect(actualJournal.get('2107')).toEqual(['0.000', '114.414']);
    expect(actualJournal.get('2108')).toEqual(['0.000', '12.500']);
    expect(actualJournal.get('1107')).toEqual(['0.000', '25.000']);
    expect(actualJournal.get('2106')).toEqual(['0.000', '899.089']);
    const secondRun = await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId);
    expect(secondRun.status).toBe(409);
    const lateInput = await act(tokenA, 'payroll/inputs', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, period: '2031-01', amount: '1.000',
    }, companyAId);
    expect(lateInput.status).toBe(409);
    await expectBalanced();

    const paid = await act(tokenA, `payroll/runs/${run.id}/pay`, { bankAccountId, date: '2031-01-31' }, companyAId);
    h.ok(paid, 201, 'pay payroll run');
    const reversed = await act(tokenA, `payroll/runs/${run.id}/reverse`, { date: '2031-01-31' }, companyAId);
    h.ok(reversed, 201, 'reverse payroll run');
    const [auditUser] = (await boot.db.query('SELECT user_id FROM tenant_memberships WHERE tenant_id = ? ORDER BY id LIMIT 1', [tenantId])) as { user_id: bigint }[];
    const payrollAudits = (await boot.db.query(
      'SELECT action, user_id FROM audit_logs WHERE tenant_id = ? AND entity_type = ? AND entity_id = ? ORDER BY id',
      [tenantId, 'payroll_run', run.id],
    )) as { action: string; user_id: bigint | null }[];
    expect(payrollAudits.map((row) => row.action)).toEqual(['payroll.post', 'payroll.pay', 'payroll.reverse']);
    expect(payrollAudits.every((row) => row.user_id === auditUser!.user_id)).toBe(true);
    const postedBy = (await boot.db.query(
      'SELECT posted_by FROM journal_entries WHERE tenant_id = ? AND source_id = ? AND source_type IN (?, ?)',
      [tenantId, run.id, 'PAYROLL_RUN', 'PAYROLL_PAYMENT'],
    )) as { posted_by: bigint | null }[];
    expect(postedBy.length).toBeGreaterThanOrEqual(2);
    expect(postedBy.every((row) => row.posted_by === auditUser!.user_id)).toBe(true);
    for (const code of ['1102', '1107', '2106', '2107', '2108', '5201', '5206']) {
      expect(await accountBalance(code)).toBe('0.000');
    }
    await expectBalanced();

    const feb = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-02' }, companyAId), 201, 'draft February') as { id: string };
    const [first, second] = await Promise.all([
      act(tokenA, `payroll/runs/${feb.id}/post`, {}, companyAId),
      act(tokenA, `payroll/runs/${feb.id}/post`, {}, companyAId),
    ]);
    expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);

    const march = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-03' }, companyAId), 201, 'draft March') as { id: string };
    h.ok(await act(tokenA, 'payroll/inputs', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, period: '2031-03', amount: '1.000',
    }, companyAId), 201, 'add late March input');
    h.ok(await act(tokenA, `payroll/runs/${march.id}/post`, {}, companyAId), 201, 'post recomputed March');
    const marchRun = h.ok(await get(tokenA, `payroll/runs/${march.id}`, companyAId), 200, 'read March') as {
      lines: { employeeId: string; items: { amount: string }[] }[];
    };
    expect(marchRun.lines.find((line) => line.employeeId === employeeA.id)?.items.map((item) => item.amount)).toContain('1');
    const [marchExpense] = (await boot.db.query(
      `SELECT CAST(SUM(l.debit) AS CHAR) AS debit FROM journal_entries j
       JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
       JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE j.tenant_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ? AND a.code = '5201'`,
      [tenantId, march.id],
    )) as { debit: string }[];
    expect(marchExpense!.debit).toBe('901.000');

    const disposableRun = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-04' }, companyAId), 201, 'draft disposable April') as { id: string };
    const deletedRun = await h.api().delete(`/api/v1/payroll/runs/${disposableRun.id}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId);
    expect(deletedRun.status).toBe(200);
    expect(deletedRun.body).toEqual({ id: disposableRun.id, deleted: true });
    const [deleteAudit] = (await boot.db.query(
      'SELECT action FROM audit_logs WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?',
      [tenantId, 'payroll_run', disposableRun.id],
    )) as { action: string }[];
    expect(deleteAudit?.action).toBe('payroll.run.delete');
  }, 90_000);
});
