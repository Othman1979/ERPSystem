/**
 * Phase 26 payroll acceptance (ADR-041): PY1–PY4 calculation, posting, payment,
 * reversal, draft locks, and tenant/company isolation.
 * Real MariaDB and built API; run `pnpm build` before this spec.
 */
import 'dotenv/config';
import { Decimal } from 'decimal.js';
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

async function expectBalanced(companyId = companyAId) {
  const tb = await get(tokenA, 'reports/trial-balance?from=2031-01-01&to=2031-12-31', companyId);
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
  it('calculates, posts, pays and reverses the golden run; enforces run/movement locks and isolation', async () => {
    const otherCompany = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(tokenA)).send({ legalNameAr: 'الشركة الثانية', legalNameEn: 'Second Co' }),
      201,
      'create second company',
    ) as { id: string };
    const noEmployees = await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId);
    expect(noEmployees.status).toBe(409);
    expect(noEmployees.body.error.code).toBe('PAYROLL_NO_EMPLOYEES');

    const elements = h.ok(await get(tokenA, 'payroll/elements', companyAId), 200, 'pay elements') as {
      id: string; code: string; isFixedAllowance: boolean;
    }[];
    const defaultElementAccounts = (await boot.db.query(
      `SELECT element.code, acct.code AS account_code
         FROM pay_elements element
         JOIN accounts acct
           ON acct.tenant_id = element.tenant_id AND acct.company_id = element.company_id AND acct.id = element.account_id
        WHERE element.tenant_id = ? AND element.company_id = ? AND element.code IN (?, ?)
        ORDER BY element.code`,
      [tenantId, companyAId, 'ABSENCE_DAY', 'PENALTY'],
    )) as { code: string; account_code: string }[];
    expect(Object.fromEntries(defaultElementAccounts.map(({ code, account_code }) => [code, account_code])))
      .toEqual({ ABSENCE_DAY: '5201', PENALTY: '4201' });
    const elementId = Object.fromEntries(elements.map((item) => [item.code, item.id])) as Record<string, string>;
    const fixedAllowanceByCode = Object.fromEntries(
      elements.filter(({ code }) => ['TRANSPORT', 'HOUSING', 'BONUS'].includes(code))
        .map(({ code, isFixedAllowance }) => [code, isFixedAllowance]),
    );
    expect(fixedAllowanceByCode).toEqual({ TRANSPORT: true, HOUSING: true, BONUS: false });
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', hoursPerMonth: '0',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', sscEmployeeRate: '1.1',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2031-01-01', sscMinWage: '500', sscMaxWage: '400',
    }, companyAId)).status).toBe(400);
    const cashAccountElement = await act(tokenA, 'payroll/elements', {
      code: `CASH-${RUN}`, nameAr: 'Cash', kind: 'EARNING', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['1101'],
    }, companyAId);
    expect(cashAccountElement.status).toBe(400);
    expect(cashAccountElement.body.error.code).toBe('PAYROLL_ACCOUNT_INVALID');
    const payableElement = await act(tokenA, 'payroll/elements', {
      code: `PAYABLE-${RUN}`, nameAr: 'Payroll payable', kind: 'DEDUCTION', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['2106'],
    }, companyAId);
    expect(payableElement.status).toBe(400);
    expect(payableElement.body.error.code).toBe('PAYROLL_ACCOUNT_INVALID');
    const deductionAllowance = await act(tokenA, 'payroll/elements', {
      code: `DEDUCTION-ALLOWANCE-${RUN}`, nameAr: 'Invalid deduction allowance', kind: 'DEDUCTION',
      amountType: 'FIXED', rateFactor: '1.000000', accountId: accounts['5201'], isFixedAllowance: true,
    }, companyAId);
    expect(deductionAllowance.status).toBe(400);
    expect(deductionAllowance.body.error.code).toBe('VALIDATION');
    const salaryReduction = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `SALARY-REDUCTION-${RUN}`, nameAr: 'Salary reduction', kind: 'DEDUCTION', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['5201'],
    }, 'salary reduction element', companyAId);
    const updateDeductionAllowance = await h.api().patch(`/api/v1/payroll/elements/${salaryReduction.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ isFixedAllowance: true });
    expect(updateDeductionAllowance.status).toBe(400);
    expect(updateDeductionAllowance.body.error.code).toBe('VALIDATION');
    const employeeA = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `A-${RUN}`, nameAr: 'الموظف أ', hireDate: '2031-01-01', payMethod: 'BANK',
    }, 'employee A', companyAId);
    const employeeB = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `B-${RUN}`, nameAr: 'الموظف ب', hireDate: '2031-01-01', payMethod: 'CASH', sscCovered: false, costCenterId,
    }, 'employee B', companyAId);
    const employeeUpdate = await h.api().patch(`/api/v1/payroll/employees/${employeeA.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ nameEn: 'Employee A', isActive: true });
    expect(employeeUpdate.status).toBe(200);
    expect(employeeUpdate.body.nameEn).toBe('Employee A');
    const duplicateCode = await h.api().patch(`/api/v1/payroll/employees/${employeeA.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ code: `B-${RUN}` });
    expect(duplicateCode.status).toBe(409);
    expect(duplicateCode.body.error.code).toBe('DUPLICATE_CODE');
    const recurring = await post<{ id: string }>(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: '1.000', validFrom: '2032-01-01',
    }, 'future recurring element', companyAId);
    const unsetFixedAllowance = await h.api().patch(`/api/v1/payroll/elements/${elementId.TRANSPORT}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ isFixedAllowance: false });
    expect(unsetFixedAllowance.status).toBe(409);
    expect(unsetFixedAllowance.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    const recurringDeduction = await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.ADVANCE_REPAYMENT, amount: '25.000', validFrom: '2031-01-01',
    }, companyAId);
    expect(recurringDeduction.status).toBe(400);
    expect(recurringDeduction.body.error.code).toBe('VALIDATION');
    expect(recurringDeduction.body.error.message).toBe('Only fixed allowances can recur on the employee card');
    const recurringBonus = await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.BONUS, amount: '10.000', validFrom: '2031-01-01',
    }, companyAId);
    expect(recurringBonus.status).toBe(400);
    expect(recurringBonus.body.error.code).toBe('VALIDATION');
    expect(recurringBonus.body.error.message).toBe('Only fixed allowances can recur on the employee card');
    const recurringHourly = await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.OVERTIME_125, quantity: '1.000', validFrom: '2031-01-01',
    }, companyAId);
    expect(recurringHourly.status).toBe(400);
    expect(recurringHourly.body.error.code).toBe('VALIDATION');
    expect(recurringHourly.body.error.message).toBe('Only fixed allowances can recur on the employee card');
    const customElement = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `EDIT-${RUN}`, nameAr: 'Editable', kind: 'EARNING', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['5201'],
    }, 'editable pay element', companyAId);
    const elementUpdate = await h.api().patch(`/api/v1/payroll/elements/${customElement.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId)
      .send({ nameAr: 'Updated editable', rateFactor: '1.250000', sscSubject: false, isActive: true });
    expect(elementUpdate.status).toBe(200);
    expect(elementUpdate.body.nameAr).toBe('Updated editable');
    expect((await h.api().get(`/api/v1/payroll/employees/${employeeA.id}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId)).body.recurringElements)
      .toHaveLength(1);
    expect((await get(tokenA, `payroll/employees/${employeeA.id}`, otherCompany.id)).status).toBe(404);
    expect((await get(tokenB, `payroll/employees/${employeeA.id}`)).status).toBe(404);
    expect((await h.api().patch(`/api/v1/payroll/employees/${employeeA.id}`).set(h.auth(tokenA)).set('X-Company-Id', otherCompany.id).send({ nameAr: 'x' })).status).toBe(404);
    expect((await h.api().patch(`/api/v1/payroll/employees/${employeeA.id}`).set(h.auth(tokenB)).send({ nameAr: 'x' })).status).toBe(404);
    expect((await act(tokenA, 'payroll/movements', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, movementDate: '2031-01-01', amount: null, description: 'invalid',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: null, validFrom: '2031-01-01',
    }, companyAId)).status).toBe(400);
    expect((await act(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: '1.000', quantity: null, validFrom: '2031-01-01',
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
    const employeeDetail = await get(tokenA, `payroll/employees/${employeeA.id}`, companyAId);
    expect(employeeDetail.body.salaries).toHaveLength(1);
    expect(employeeDetail.body.salaries[0].basicSalary).toBe('500');
    expect(employeeDetail.body.recurringElements[0].payElement.isFixedAllowance).toBe(true);

    await post(tokenA, `payroll/employees/${employeeA.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: '50.000', validFrom: '2031-01-01', validTo: '2031-01-31',
    }, 'transport', companyAId);
    for (const [date, quantity] of [['2031-01-10', '6'], ['2031-01-11', '4']]) {
      await post(tokenA, 'payroll/movements', {
        employeeId: employeeA.id, payElementId: elementId.OVERTIME_125, movementDate: date, quantity, description: `overtime ${quantity}`,
      }, `overtime ${quantity}`, companyAId);
    }
    const advanceMovement = await post<{ id: string; amount: string }>(tokenA, 'payroll/movements', {
      employeeId: employeeA.id, payElementId: elementId.ADVANCE_REPAYMENT, movementDate: '2031-01-31',
      amount: '25.000', description: 'advance repayment',
    }, 'advance repayment', companyAId);
    expect(advanceMovement.amount).toBe('25');
    const absenceMovement = await post<{ id: string; amount: string }>(tokenA, 'payroll/movements', {
      employeeId: employeeB.id, payElementId: elementId.ABSENCE_DAY, movementDate: '2031-01-12',
      quantity: '2', description: 'absence monthly total',
    }, 'absence monthly total', companyAId);
    expect(absenceMovement.amount).toBe('26.667');
    const januaryMovements = h.ok(
      await get(tokenA, 'payroll/movements?period=2031-01', companyAId),
      200,
      'list January movements',
    ) as Array<{ id: string }>;
    expect(januaryMovements).toHaveLength(4);
    const otherCompanyMovements = h.ok(
      await get(tokenA, 'payroll/movements?period=2031-01', otherCompany.id),
      200,
      'list movements from another company',
    ) as Array<{ id: string }>;
    expect(otherCompanyMovements).toHaveLength(0);
    expect((await act(tokenB, `payroll/movements/${januaryMovements[0]!.id}/reverse`, { date: '2031-01-20' })).status).toBe(404);
    expect((await get(tokenB, `payroll/employees/${employeeA.id}/statement?from=2031-01-01&to=2031-01-31`)).status).toBe(404);
    const run = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId), 201, 'create and compute run') as {
      id: string;
      lines: {
        id: string; employeeId: string; basic: string; earnings: string; gross: string; sscBase: string;
        sscEmployee: string; sscEmployer: string; incomeTax: string; deductions: string; net: string;
        items: { amount: string; payrollMovementId: string | null }[];
      }[];
    };
    const lineA = run.lines.find((line) => line.employeeId === employeeA.id)!;
    const lineB = run.lines.find((line) => line.employeeId === employeeB.id)!;
    expect([lineA.basic, lineA.earnings, lineA.gross, lineA.sscBase, lineA.sscEmployee, lineA.sscEmployer, lineA.net])
      .toEqual(['500', '76.042', '576.042', '526.042', '39.453', '74.961', '511.589']);
    expect([lineB.basic, lineB.earnings, lineB.gross, lineB.sscBase, lineB.sscEmployee, lineB.sscEmployer, lineB.deductions, lineB.net])
      .toEqual(['400', '0', '400', '0', '0', '0', '26.667', '373.333']);
    const movementItems = lineA.items.filter((item) => item.payrollMovementId !== null);
    expect(movementItems).toHaveLength(3);
    expect(movementItems.reduce((total, item) => total.plus(item.amount), new Decimal(0)).toString()).toBe('51.042');
    expect(lineA.items.filter((item) => item.payrollMovementId === null).map((item) => item.amount).sort()).toEqual(['50']);
    expect(lineB.items.map((item) => item.amount)).toEqual(['26.667']);
    h.ok(await h.api().patch(`/api/v1/payroll/runs/${run.id}/lines/${lineA.id}/income-tax`).set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ incomeTax: '12.500' }), 200, 'set A tax');
    const updated = h.ok(await get(tokenA, `payroll/runs/${run.id}`, companyAId), 200, 'run detail') as {
      netTotal: string;
      lines: { id: string; incomeTax: string; deductions: string; net: string }[];
      grossTotal: string;
      sscEmployeeTotal: string;
      sscEmployerTotal: string;
      deductionsTotal: string;
    };
    expect(updated.netTotal).toBe('872.422');
    expect(updated.lines.find((line) => line.id === lineA.id))
      .toEqual(expect.objectContaining({ incomeTax: '12.5', deductions: '25', net: '499.089' }));
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
    expect((await h.api().patch(`/api/v1/payroll/elements/${customElement.id}`).set(h.auth(tokenA))
      .set('X-Company-Id', otherCompany.id).send({ nameAr: 'x' })).status).toBe(404);
    expect((await h.api().patch(`/api/v1/payroll/elements/${customElement.id}`).set(h.auth(tokenB)).send({ nameAr: 'x' })).status).toBe(404);
    const foreignRecurringDelete = await h.api().delete(`/api/v1/payroll/employees/${employeeA.id}/recurring-elements/${recurring.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', otherCompany.id);
    expect(foreignRecurringDelete.status).toBe(404);
    expect((await h.api().delete(`/api/v1/payroll/employees/${employeeA.id}/recurring-elements/${recurring.id}`).set(h.auth(tokenB))).status).toBe(404);
    const recurringDelete = await h.api().delete(`/api/v1/payroll/employees/${employeeA.id}/recurring-elements/${recurring.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId);
    expect(recurringDelete.status).toBe(200);
    const foreignDelete = await h.api().delete(`/api/v1/payroll/runs/${run.id}`).set(h.auth(tokenA)).set('X-Company-Id', otherCompany.id);
    expect(foreignDelete.status).toBe(404);

    const posted = await act(tokenA, `payroll/runs/${run.id}/post`, {}, companyAId);
    h.ok(posted, 201, 'post payroll run');
    const lockedElementType = await h.api().patch(`/api/v1/payroll/elements/${elementId.TRANSPORT}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ kind: 'DEDUCTION' });
    expect(lockedElementType.status).toBe(409);
    expect(lockedElementType.body.error.code).toBe('INVALID_STATUS_TRANSITION');
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
    expect(actualJournal.get('5201')).toEqual(['950.000', '0.000']);
    expect(actualJournal.get('5206')).toEqual(['74.961', '0.000']);
    expect(actualJournal.get('2107')).toEqual(['0.000', '114.414']);
    expect(actualJournal.get('2108')).toEqual(['0.000', '12.500']);
    expect(actualJournal.get('1107')).toBeUndefined();
    expect(actualJournal.get('2106')).toEqual(['0.000', '898.047']);
    const advanceJournal = (await boot.db.query(
      `SELECT a.code AS account_code, CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_MOVEMENT' AND j.source_id = ?
        ORDER BY a.code`,
      [tenantId, companyAId, advanceMovement.id],
    )) as Array<{ account_code: string; debit: string; credit: string }>;
    expect(advanceJournal.map((entry) => [entry.account_code, entry.debit, entry.credit])).toEqual([
      ['1107', '0.000', '25.000'],
      ['2106', '25.000', '0.000'],
    ]);
    const absenceJournal = (await boot.db.query(
      `SELECT a.code AS account_code, CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_MOVEMENT' AND j.source_id = ?
        ORDER BY a.code`,
      [tenantId, companyAId, absenceMovement.id],
    )) as Array<{ account_code: string; debit: string; credit: string }>;
    expect(absenceJournal.map((entry) => [entry.account_code, entry.debit, entry.credit])).toEqual([
      ['2106', '26.667', '0.000'],
      ['5201', '0.000', '26.667'],
    ]);
    expect(new Decimal(await accountBalance('2106')).neg().toString()).toBe('872.422');
    const secondRun = await act(tokenA, 'payroll/runs', { period: '2031-01' }, companyAId);
    expect(secondRun.status).toBe(409);
    const lateMovement = await act(tokenA, 'payroll/movements', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, movementDate: '2031-01-20', amount: '1.000', description: 'late',
    }, companyAId);
    expect(lateMovement.status).toBe(409);
    await expectBalanced();

    const paymentBeforeRunDate = await act(tokenA, `payroll/runs/${run.id}/pay`, {
      bankAccountId, date: '2031-01-30',
    }, companyAId);
    expect(paymentBeforeRunDate.status).toBe(400);
    expect(paymentBeforeRunDate.body.error.code).toBe('VALIDATION');
    expect(paymentBeforeRunDate.body.error.message).toBe('Payment date must not precede the payroll run date');
    const paid = await act(tokenA, `payroll/runs/${run.id}/pay`, { bankAccountId, date: '2031-01-31' }, companyAId);
    h.ok(paid, 201, 'pay payroll run');
    expect(await accountBalance('2106')).toBe('0.000');
    const reversalBeforeRunDate = await act(tokenA, `payroll/runs/${run.id}/reverse`, {
      date: '2031-01-30',
    }, companyAId);
    expect(reversalBeforeRunDate.status).toBe(400);
    expect(reversalBeforeRunDate.body.error.code).toBe('VALIDATION');
    const reversed = await act(tokenA, `payroll/runs/${run.id}/reverse`, { date: '2031-01-31' }, companyAId);
    h.ok(reversed, 201, 'reverse payroll run');
    h.ok(await act(tokenA, `payroll/movements/${advanceMovement.id}/reverse`, {
      date: '2031-01-31',
    }, companyAId), 201, 'reverse advance repayment movement');
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
    expect(await accountBalance('1102')).toBe('0.000');
    expect(await accountBalance('1107')).toBe('0.000');
    expect(await accountBalance('2107')).toBe('0.000');
    expect(await accountBalance('2108')).toBe('0.000');
    expect(await accountBalance('5206')).toBe('0.000');
    await expectBalanced();

    const feb = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-02' }, companyAId), 201, 'draft February') as { id: string };
    const [first, second] = await Promise.all([
      act(tokenA, `payroll/runs/${feb.id}/post`, {}, companyAId),
      act(tokenA, `payroll/runs/${feb.id}/post`, {}, companyAId),
    ]);
    expect([first.status, second.status].filter((status) => status === 201)).toHaveLength(1);

    const march = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-03' }, companyAId), 201, 'draft March') as { id: string };
    h.ok(await act(tokenA, 'payroll/movements', {
      employeeId: employeeA.id, payElementId: elementId.TRANSPORT, movementDate: '2031-03-15', amount: '1.000', description: 'late March',
    }, companyAId), 201, 'add late March input');
    h.ok(await act(tokenA, `payroll/runs/${march.id}/post`, {}, companyAId), 201, 'post recomputed March');
    const marchRun = h.ok(await get(tokenA, `payroll/runs/${march.id}`, companyAId), 200, 'read March') as {
      lines: { employeeId: string; items: { amount: string }[] }[];
    };
    const reverseFebruary = await act(tokenA, `payroll/runs/${feb.id}/reverse`, { date: '2031-03-31' }, companyAId);
    expect(reverseFebruary.status).toBe(409);
    expect(reverseFebruary.body.error.code).toBe('PAYROLL_LATER_RUN_POSTED');
    expect(marchRun.lines.find((line) => line.employeeId === employeeA.id)?.items.map((item) => item.amount)).toContain('1');
    const [marchExpense] = (await boot.db.query(
      `SELECT CAST(SUM(l.debit) AS CHAR) AS debit FROM journal_entries j
       JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
       JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
       WHERE j.tenant_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ? AND a.code = '5201'`,
      [tenantId, march.id],
    )) as { debit: string }[];
    expect(marchExpense!.debit).toBe('900.000');

    const disposableRun = h.ok(await act(tokenA, 'payroll/runs', { period: '2031-04' }, companyAId), 201, 'draft disposable April') as { id: string };
    const deletedRun = await h.api().delete(`/api/v1/payroll/runs/${disposableRun.id}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId);
    expect(deletedRun.status).toBe(200);
    expect(deletedRun.body).toEqual({ id: disposableRun.id, deleted: true });
    const [deleteAudit] = (await boot.db.query(
      'SELECT action FROM audit_logs WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?',
      [tenantId, 'payroll_run', disposableRun.id],
    )) as { action: string }[];
    expect(deleteAudit?.action).toBe('payroll.run.delete');

    const oneDayAbsenceAmounts: string[] = [];
    for (const movementDate of ['2031-12-10', '2031-12-11']) {
      const movement = await post<{ amount: string }>(tokenA, 'payroll/movements', {
        employeeId: employeeB.id, payElementId: elementId.ABSENCE_DAY,
        movementDate, quantity: '1', description: 'separate daily absence',
      }, 'separate daily absence', companyAId);
      oneDayAbsenceAmounts.push(movement.amount);
    }
    expect(oneDayAbsenceAmounts).toEqual(['13.333', '13.333']);
    expect(oneDayAbsenceAmounts.reduce((total, amount) => total.plus(amount), new Decimal(0)).toString()).toBe('26.666');
    await expectBalanced();
  }, 90_000);

  it('balances payroll payable when tax approaches or exceeds the positive net', async () => {
    const balanceCompany = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(tokenA)).send({
        legalNameAr: `Payroll balance ${RUN}`, legalNameEn: `Payroll balance ${RUN}`,
      }),
      201,
      'create isolated payroll balance company',
    ) as { id: string };
    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).set('X-Company-Id', balanceCompany.id).send({
      code: '2031', startDate: '2031-01-01', endDate: '2031-12-31',
    }), 201, 'create isolated payroll balance fiscal year');
    const elements = h.ok(await get(tokenA, 'payroll/elements', balanceCompany.id), 200, 'isolated pay elements') as { id: string; code: string }[];
    const elementId = Object.fromEntries(elements.map(({ id, code }) => [code, id])) as Record<string, string>;
    expect(h.ok(await get(tokenA, 'payroll/employees', balanceCompany.id), 200, 'empty isolated employee list')).toHaveLength(0);
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `BALANCE-${RUN}`, nameAr: 'Payroll balance', hireDate: '2031-05-01', payMethod: 'BANK', sscCovered: true,
    }, 'payroll balance employee', balanceCompany.id);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2031-05-01', basicSalary: '300.000',
    }, 'payroll balance salary', balanceCompany.id);
    const balanceEmployees = h.ok(await get(tokenA, 'payroll/employees', balanceCompany.id), 200, 'isolated employee list') as { id: string; isActive: boolean }[];
    expect(balanceEmployees).toEqual([expect.objectContaining({ id: employee.id, isActive: true })]);

    for (const scenario of [
      { period: '2031-05', movementDate: '2031-05-10', incomeTax: '30.000', net: '305.312', payable: ['0.000', '242.812'] },
      { period: '2031-06', movementDate: '2031-06-10', incomeTax: '280.000', net: '55.312', payable: ['7.188', '0.000'] },
    ]) {
      await post(tokenA, 'payroll/movements', {
        employeeId: employee.id,
        payElementId: elementId.OVERTIME_125,
        movementDate: scenario.movementDate,
        quantity: '40',
        description: '40 hours overtime',
      }, '40-hour overtime movement', balanceCompany.id);
      const run = h.ok(await act(tokenA, 'payroll/runs', { period: scenario.period }, balanceCompany.id), 201, 'create balancing run') as {
        id: string;
        lines: Array<{ id: string; employeeId: string; sscBase: string; sscEmployee: string; sscEmployer: string }>;
      };
      const line = run.lines.find((candidate) => candidate.employeeId === employee.id)!;
      expect([line.sscBase, line.sscEmployee, line.sscEmployer]).toEqual(['362.5', '27.188', '51.656']);
      h.ok(await h.api().patch(`/api/v1/payroll/runs/${run.id}/lines/${line.id}/income-tax`)
        .set(h.auth(tokenA)).set('X-Company-Id', balanceCompany.id).send({ incomeTax: scenario.incomeTax }), 200, 'set balancing tax');
      const adjustedRun = h.ok(await get(tokenA, `payroll/runs/${run.id}`, balanceCompany.id), 200, 'read balancing run') as {
        lines: Array<{ employeeId: string; net: string }>;
      };
      expect(adjustedRun.lines.find((candidate) => candidate.employeeId === employee.id)?.net).toBe(scenario.net);
      h.ok(await act(tokenA, `payroll/runs/${run.id}/post`, {}, balanceCompany.id), 201, 'post balancing run');

      const journal = (await boot.db.query(
        `SELECT a.code, CAST(SUM(l.debit) AS CHAR) AS debit, CAST(SUM(l.credit) AS CHAR) AS credit
           FROM journal_entries j
           JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
           JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
          WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ?
          GROUP BY a.code ORDER BY a.code`,
        [tenantId, balanceCompany.id, run.id],
      )) as Array<{ code: string; debit: string; credit: string }>;
      expect(Object.fromEntries(journal.map(({ code, debit, credit }) => [code, [debit, credit]]))).toEqual({
        '2106': scenario.payable,
        '2107': ['0.000', '78.844'],
        '2108': ['0.000', scenario.incomeTax],
        '5201': ['300.000', '0.000'],
        '5206': ['51.656', '0.000'],
      });
    }

    const [junePayableBalance] = (await boot.db.query(
      `SELECT CAST(SUM(l.credit - l.debit) AS CHAR) AS balance
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.entry_date >= ? AND j.entry_date < ? AND a.code = '2106'`,
      [tenantId, balanceCompany.id, '2031-06-01', '2031-07-01'],
    )) as { balance: string }[];
    expect(junePayableBalance!.balance).toBe('55.312');
    await expectBalanced(balanceCompany.id);
  });

  it('refuses pay-element type changes while inputs or recurring elements reference them', async () => {
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `TYPE-${RUN}`, nameAr: 'Type lock employee', hireDate: '2031-01-01', payMethod: 'CASH',
    }, 'type lock employee', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2031-01-01', basicSalary: '400.000',
    }, 'type lock salary', companyAId);
    const recurringElement = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `REC-${RUN}`, nameAr: 'Recurring lock', kind: 'EARNING', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['5201'], isFixedAllowance: true,
    }, 'recurring type lock element', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/recurring-elements`, {
      payElementId: recurringElement.id, amount: '1.000', validFrom: '2031-04-01',
    }, 'recurring type lock reference', companyAId);
    const recurringChange = await h.api().patch(`/api/v1/payroll/elements/${recurringElement.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ kind: 'DEDUCTION' });
    expect(recurringChange.status).toBe(409);
    expect(recurringChange.body.error.code).toBe('INVALID_STATUS_TRANSITION');

    const inputElement = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `INP-${RUN}`, nameAr: 'Input lock', kind: 'EARNING', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['5201'],
    }, 'input type lock element', companyAId);
    await post(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: inputElement.id, movementDate: '2031-04-15', amount: '1.000', description: 'type lock reference',
    }, 'input type lock reference', companyAId);
    const inputChange = await h.api().patch(`/api/v1/payroll/elements/${inputElement.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ amountType: 'PER_HOUR' });
    expect(inputChange.status).toBe(409);
    expect(inputChange.body.error.code).toBe('INVALID_STATUS_TRANSITION');
  });

  it('serializes recurring creation with concurrent pay-element type changes', async () => {
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `RACE-${RUN}`, nameAr: 'Recurring race employee', hireDate: '2031-01-01', payMethod: 'CASH',
    }, 'recurring race employee', companyAId);
    const element = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `RACE-ELEMENT-${RUN}`, nameAr: 'Recurring race element', kind: 'EARNING',
      amountType: 'FIXED', rateFactor: '1.000000', accountId: accounts['5201'], isFixedAllowance: true,
    }, 'recurring race element', companyAId);

    const [typeChange, recurringCreate] = await Promise.all([
      h.api().patch(`/api/v1/payroll/elements/${element.id}`)
        .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ amountType: 'PER_HOUR' }),
      act(tokenA, `payroll/employees/${employee.id}/recurring-elements`, {
        payElementId: element.id, amount: '10.000', validFrom: '2031-01-01',
      }, companyAId),
    ]);
    const recurringRows = h.ok(
      await get(tokenA, `payroll/employees/${employee.id}/recurring-elements`, companyAId),
      200,
      'read recurring race result',
    ) as Array<{ amount: string | null; quantity: string | null; payElement: { amountType: string; isFixedAllowance: boolean } }>;
    const elements = h.ok(await get(tokenA, 'payroll/elements', companyAId), 200, 'read recurring race element') as Array<{
      id: string; amountType: string; isFixedAllowance: boolean;
    }>;
    const currentElement = elements.find((candidate) => candidate.id === element.id)!;
    for (const row of recurringRows) {
      expect(row.payElement.amountType).toBe(currentElement.amountType);
      expect(row.payElement.isFixedAllowance).toBe(true);
      if (currentElement.amountType === 'FIXED') {
        expect(row.amount).not.toBeNull();
        expect(row.quantity).toBeNull();
      } else {
        expect(row.amount).toBeNull();
        expect(row.quantity).not.toBeNull();
      }
    }
    expect(recurringCreate.status).toBe(201);
    expect([400, 409]).toContain(typeChange.status);
    expect(['VALIDATION', 'INVALID_STATUS_TRANSITION']).toContain(typeChange.body.error.code);
    expect(currentElement.amountType).toBe('FIXED');
  });

  it('clears nullable employee fields when the edit payload sends null', async () => {
    const branch = (h.ok(await get(tokenA, 'branches', companyAId), 200, 'branch list') as { id: string }[])[0]!;
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `CLEAR-${RUN}`, nameAr: 'Clear fields', nameEn: 'Clear fields',
      nationalId: `N-${RUN}`, sscNumber: `SSC-${RUN}`, hireDate: '2031-01-01', leaveDate: '2031-12-31',
      branchId: branch.id, costCenterId, payMethod: 'CASH', iban: `JO-${RUN}`,
    }, 'employee with nullable fields', companyAId);
    const cleared = await h.api().patch(`/api/v1/payroll/employees/${employee.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId)
      .send({
        nameEn: null, nationalId: null, sscNumber: null, leaveDate: null,
        branchId: null, costCenterId: null, iban: null,
      });
    expect(cleared.status).toBe(200);
    expect({
      nameEn: cleared.body.nameEn, nationalId: cleared.body.nationalId, sscNumber: cleared.body.sscNumber,
      leaveDate: cleared.body.leaveDate, branchId: cleared.body.branchId, costCenterId: cleared.body.costCenterId,
      iban: cleared.body.iban,
    }).toEqual({
      nameEn: null, nationalId: null, sscNumber: null, leaveDate: null,
      branchId: null, costCenterId: null, iban: null,
    });
  });

  it('PY4: posts dated movements, reversals, a netted run, payment and employee statement', async () => {
    const tokenA = await register('py4');
    const companyAId = (h.ok(await h.get(tokenA, 'companies'), 200, 'PY4 company') as { id: string }[])[0]!.id;
    const tenantName = `Payroll py4 ${RUN}`;
    const [tenant] = await boot.db.query('SELECT id FROM tenants WHERE name = ?', [tenantName]) as { id: bigint }[];
    const tenantId = tenant!.id;
    const accounts: Record<string, string> = {};
    const chart = h.ok(await get(tokenA, 'accounts'), 200, 'PY4 chart') as { id: string; code: string }[];
    for (const account of chart) accounts[account.code] = account.id;
    const bank = h.ok(await h.api().post('/api/v1/bank-accounts').set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({
      bankName: 'Arab Bank', accountId: accounts['1102'],
    }), 201, 'create isolated PY4 bank account') as { id: string };
    const bankAccountId = bank.id;
    h.ok(
      await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).send({
        code: '2026', startDate: '2026-01-01', endDate: '2026-12-31',
      }),
      201,
      'create PY4 fiscal year',
    );
    const elements = h.ok(await get(tokenA, 'payroll/elements', companyAId), 200, 'PY4 elements') as { id: string; code: string }[];
    const elementId = Object.fromEntries(elements.map((element) => [element.code, element.id])) as Record<string, string>;
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `PY4-${RUN}`, nameAr: 'PY4 employee', hireDate: '2026-11-01', payMethod: 'BANK', sscCovered: true,
    }, 'PY4 employee', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2026-11-01', basicSalary: '500.000',
    }, 'PY4 salary', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/recurring-elements`, {
      payElementId: elementId.TRANSPORT, amount: '50.000', validFrom: '2026-11-01',
    }, 'PY4 transport', companyAId);
    const deductionElement = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `MISUSE-${RUN}`, nameAr: 'Equipment misuse', kind: 'DEDUCTION', amountType: 'FIXED',
      rateFactor: '1.000000', accountId: accounts['4201'], sscSubject: false,
    }, 'PY4 deduction element', companyAId);
    const payableAccountUpdate = await h.api().patch(`/api/v1/payroll/elements/${deductionElement.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ accountId: accounts['2106'] });
    expect(payableAccountUpdate.status).toBe(400);
    expect(payableAccountUpdate.body.error.code).toBe('PAYROLL_ACCOUNT_INVALID');
    const overtime = await post<{ id: string; movementNo: string }>(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: elementId.OVERTIME_125, movementDate: '2026-11-10',
      quantity: '10', description: 'Overtime',
    }, 'PY4 overtime', companyAId);
    const deduction = await post<{ id: string; movementNo: string }>(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: deductionElement.id, movementDate: '2026-11-20',
      amount: '10.000', description: 'Misuse of equipment',
    }, 'PY4 deduction', companyAId);
    const beforeRunReversal = await post<{ id: string }>(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: elementId.TRANSPORT, movementDate: '2026-11-22',
      amount: '2.000', description: 'Reverse before run',
    }, 'movement to reverse before run', companyAId);
    h.ok(await act(tokenA, `payroll/movements/${beforeRunReversal.id}/reverse`, { date: '2026-11-23' }, companyAId), 201, 'reverse before run');

    const noSalary = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `NOSAL-${RUN}`, nameAr: 'No salary', hireDate: '2026-11-01', payMethod: 'CASH',
    }, 'employee without salary', companyAId);
    const missingSalary = await act(tokenA, 'payroll/movements', {
      employeeId: noSalary.id, payElementId: elementId.OVERTIME_125,
      movementDate: '2026-11-10', quantity: '1', description: 'No salary',
    }, companyAId);
    expect(missingSalary.status).toBe(400);
    expect(missingSalary.body.error.message).toContain('No salary in force');

    const run = h.ok(await act(tokenA, 'payroll/runs', { period: '2026-11' }, companyAId), 201, 'create PY4 run') as {
      id: string;
      lines: Array<{ id: string; employeeId: string; basic: string; sscBase: string; sscEmployee: string; sscEmployer: string; incomeTax: string; net: string; items: Array<{ description: string; amount: string; payrollMovementId: string | null }> }>;
    };
    const line = run.lines.find((item) => item.employeeId === employee.id)!;
    expect([line.basic, line.sscBase, line.sscEmployee, line.sscEmployer])
      .toEqual(['500', '526.042', '39.453', '74.961']);
    expect(line.items.map((item) => item.amount).sort()).toEqual(['10', '26.042', '50']);
    expect(line.items.some((item) => item.description === 'Reverse before run')).toBe(false);
    h.ok(await h.api().patch(`/api/v1/payroll/runs/${run.id}/lines/${line.id}/income-tax`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ incomeTax: '12.500' }), 200, 'set PY4 tax');
    const taxAdjustedRun = h.ok(await get(tokenA, `payroll/runs/${run.id}`, companyAId), 200, 'read PY4 tax-adjusted run') as {
      lines: Array<{ employeeId: string; incomeTax: string; net: string }>;
    };
    const taxAdjustedLine = taxAdjustedRun.lines.find((item) => item.employeeId === employee.id)!;
    expect(taxAdjustedLine.net).toBe('514.089');
    const posted = await act(tokenA, `payroll/runs/${run.id}/post`, {}, companyAId);
    h.ok(posted, 201, 'post PY4 run');
    const runEntry = (await boot.db.query(
      `SELECT a.code, CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ?
        ORDER BY a.code, l.debit DESC`,
      [tenantId, run.id],
    )) as Array<{ code: string; debit: string; credit: string }>;
    const runLines = (code: string) => runEntry.filter((entry) => entry.code === code).map((entry) => [entry.debit, entry.credit]);
    expect(runLines('5201')).toEqual([['500.000', '0.000'], ['50.000', '0.000']]);
    expect(runLines('5206')).toEqual([['74.961', '0.000']]);
    expect(runLines('2107')).toEqual([['0.000', '114.414']]);
    expect(runLines('2108')).toEqual([['0.000', '12.500']]);
    expect(runLines('2106')).toEqual([['0.000', '498.047']]);

    const reverseAfterRun = await act(tokenA, `payroll/movements/${overtime.id}/reverse`, { date: '2026-11-25' }, companyAId);
    expect(reverseAfterRun.status).toBe(409);
    const lateMovement = await act(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: elementId.TRANSPORT,
      movementDate: '2026-11-26', amount: '1.000', description: 'Posted period',
    }, companyAId);
    expect(lateMovement.status).toBe(409);
    h.ok(await act(tokenA, `payroll/runs/${run.id}/pay`, { bankAccountId, date: '2026-11-30' }, companyAId), 201, 'pay PY4 run');

    const statement = h.ok(await get(tokenA, `payroll/employees/${employee.id}/statement?from=2026-11-01&to=2026-11-30`, companyAId), 200, 'PY4 statement') as {
      openingBalance: string; closingBalance: string; rows: Array<{ documentType: string; debit: string; credit: string }>;
    };
    expect(statement.openingBalance).toBe('0.000');
    expect(statement.closingBalance).toBe('0.000');
    expect(statement.rows.find((row) => row.documentType === 'MOVEMENT' && row.credit === '26.042')?.debit).toBe('0.000');
    expect(statement.rows.find((row) => row.documentType === 'MOVEMENT' && row.debit === '10.000')?.credit).toBe('0.000');
    expect(statement.rows.find((row) => row.documentType === 'PAYROLL_RUN')?.credit).toBe('498.047');

    const inactiveEmployee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `INACTIVE-${RUN}`, nameAr: 'Inactive employee', hireDate: '2026-11-01', payMethod: 'CASH', sscCovered: false,
    }, 'inactive movement employee', companyAId);
    h.ok(await h.api().patch(`/api/v1/payroll/employees/${inactiveEmployee.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ isActive: false }), 200, 'deactivate movement employee');
    const inactiveMovement = await act(tokenA, 'payroll/movements', {
      employeeId: inactiveEmployee.id, payElementId: elementId.OVERTIME_125,
      movementDate: '2026-12-03', quantity: '1', description: 'Inactive employee',
    }, companyAId);
    expect(inactiveMovement.status).toBe(400);
    expect(inactiveMovement.body.error.code).toBe('VALIDATION');
    expect(inactiveMovement.body.error.message).toBe('Employee is inactive');

    const [firstConcurrent, secondConcurrent] = await Promise.all([
      act(tokenA, 'payroll/movements', {
        employeeId: employee.id, payElementId: elementId.TRANSPORT, movementDate: '2026-12-01',
        amount: '1.000', description: 'Concurrent one',
      }, companyAId),
      act(tokenA, 'payroll/movements', {
        employeeId: employee.id, payElementId: elementId.TRANSPORT, movementDate: '2026-12-02',
        amount: '1.000', description: 'Concurrent two',
      }, companyAId),
    ]);
    expect([firstConcurrent.status, secondConcurrent.status]).toEqual([201, 201]);
    expect(firstConcurrent.body.movementNo).not.toBe(secondConcurrent.body.movementNo);

    const [auditUser] = (await boot.db.query('SELECT user_id FROM tenant_memberships WHERE tenant_id = ? ORDER BY id LIMIT 1', [tenantId])) as { user_id: bigint }[];
    const movementIds = [overtime.id, deduction.id, beforeRunReversal.id];
    const audits = (await boot.db.query(
      'SELECT action FROM audit_logs WHERE tenant_id = ? AND entity_type = ? AND entity_id IN (?) ORDER BY id',
      [tenantId, 'payroll_movement', movementIds],
    )) as { action: string }[];
    expect(audits.map((row) => row.action).sort()).toEqual([
      'payroll.movement.post', 'payroll.movement.post', 'payroll.movement.post',
      'payroll.movement.reverse',
    ]);
    const movementPostingUsers = (await boot.db.query(
      'SELECT posted_by FROM journal_entries WHERE tenant_id = ? AND source_type = ? AND source_id IN (?)',
      [tenantId, 'PAYROLL_MOVEMENT', movementIds],
    )) as { posted_by: bigint | null }[];
    expect(movementPostingUsers.every((row) => row.posted_by === auditUser!.user_id)).toBe(true);
    const trialBalance = await get(tokenA, 'reports/trial-balance?from=2026-01-01&to=2026-12-31', companyAId);
    expect(trialBalance.body.balanced).toBe(true);

    await post(tokenA, `payroll/employees/${noSalary.id}/salaries`, {
      effectiveFrom: '2025-01-01', basicSalary: '500.000',
    }, 'salary for missing-settings check', companyAId);
    await boot.db.query('DELETE FROM payroll_settings WHERE tenant_id = ? AND company_id = ?', [tenantId, companyAId]);
    const missingSettings = await act(tokenA, 'payroll/movements', {
      employeeId: noSalary.id, payElementId: elementId.OVERTIME_125,
      movementDate: '2025-12-01', quantity: '1', description: 'No settings',
    }, companyAId);
    expect(missingSettings.body.error.code).toBe('PAYROLL_SETTINGS_REQUIRED');
  });

  it('prevents deactivation while posted movements are waiting for a payroll run', async () => {
    h.ok(
      await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).send({
        code: '2032', startDate: '2032-01-01', endDate: '2032-12-31',
      }),
      201,
      'create deactivation-test fiscal year',
    );
    await post(tokenA, 'payroll/settings', { effectiveFrom: '2032-01-01' }, 'deactivation-test settings', companyAId);
    const elements = h.ok(await get(tokenA, 'payroll/elements', companyAId), 200, 'deactivation-test pay elements') as {
      id: string; code: string;
    }[];
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `PENDING-${RUN}`, nameAr: 'Pending movement', hireDate: '2032-01-01', costCenterId, payMethod: 'CASH',
    }, 'employee with pending movement', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2032-01-01', basicSalary: '100.000',
    }, 'pending-movement salary', companyAId);
    const movement = await act(tokenA, 'payroll/movements', {
      employeeId: employee.id,
      payElementId: elements.find((element) => element.code === 'TRANSPORT')!.id,
      movementDate: '2032-01-10',
      amount: '5.000',
      description: 'Awaiting payroll run',
    }, companyAId);
    h.ok(movement, 201, 'post movement awaiting a run');

    const deactivation = await h.api().patch(`/api/v1/payroll/employees/${employee.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ isActive: false });
    expect(deactivation.status).toBe(400);
    expect(deactivation.body.error.code).toBe('VALIDATION');
    expect(deactivation.body.error.message).toBe('Employee cannot be deactivated while posted payroll movements await a run');
  });

  it('posts, pays, lists and reverses a movement-only run without a journal entry', async () => {
    const company = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(tokenA)).send({ legalNameAr: `Movement-only ${RUN}` }),
      201,
      'create movement-only company',
    ) as { id: string };
    h.ok(
      await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).set('X-Company-Id', company.id).send({
        code: '2033', startDate: '2033-01-01', endDate: '2033-12-31',
      }),
      201,
      'create movement-only fiscal year',
    );
    await post(tokenA, 'payroll/settings', { effectiveFrom: '2033-01-01' }, 'movement-only settings', company.id);
    const elements = h.ok(await get(tokenA, 'payroll/elements', company.id), 200, 'movement-only pay elements') as {
      id: string; code: string;
    }[];
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `MOVEONLY-${RUN}`, nameAr: 'Movement-only employee', hireDate: '2033-01-01',
      payMethod: 'BANK', sscCovered: false,
    }, 'movement-only employee', company.id);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2033-01-01', basicSalary: '0.000',
    }, 'movement-only salary', company.id);
    await post(tokenA, 'payroll/movements', {
      employeeId: employee.id,
      payElementId: elements.find((element) => element.code === 'TRANSPORT')!.id,
      movementDate: '2033-01-10',
      amount: '10.000',
      description: 'Movement-only earnings',
    }, 'movement-only earning', company.id);
    const accounts = h.ok(await get(tokenA, 'accounts', company.id), 200, 'movement-only accounts') as {
      id: string; code: string;
    }[];
    const bankAccount = h.ok(
      await h.api().post('/api/v1/bank-accounts').set(h.auth(tokenA)).set('X-Company-Id', company.id).send({
        bankName: 'Movement-only bank',
        accountId: accounts.find((account) => account.code === '1102')!.id,
      }),
      201,
      'movement-only bank account',
    ) as { id: string };

    const draft = h.ok(await act(tokenA, 'payroll/runs', { period: '2033-01' }, company.id), 201, 'create movement-only run') as {
      id: string;
    };
    const posted = h.ok(await act(tokenA, `payroll/runs/${draft.id}/post`, {}, company.id), 201, 'post movement-only run') as {
      id: string; status: string; runNo: string | null;
    };
    expect(posted.status).toBe('POSTED');
    expect(posted.runNo).toBeTruthy();
    const [postedRun] = (await boot.db.query(
      'SELECT journal_entry_id FROM payroll_runs WHERE tenant_id = ? AND company_id = ? AND id = ?',
      [tenantId, company.id, draft.id],
    )) as { journal_entry_id: bigint | null }[];
    expect(postedRun!.journal_entry_id).toBeNull();

    const statement = h.ok(
      await get(tokenA, `payroll/employees/${employee.id}/statement?from=2033-01-01&to=2033-01-31`, company.id),
      200,
      'movement-only statement',
    ) as { rows: Array<{ documentNo: string; documentType: string }> };
    expect(statement.rows.find((row) => row.documentType === 'PAYROLL_RUN')?.documentNo).toBe(posted.runNo);

    const beforeRunDate = await act(
      tokenA,
      `payroll/runs/${draft.id}/reverse`,
      { date: '2032-12-31' },
      company.id,
    );
    expect(beforeRunDate.status).toBe(400);
    expect(beforeRunDate.body.error.code).toBe('VALIDATION');
    const noPeriod = await act(
      tokenA,
      `payroll/runs/${draft.id}/reverse`,
      { date: '2034-01-01' },
      company.id,
    );
    expect(noPeriod.status).toBe(409);
    expect(noPeriod.body.error.code).toBe('PERIOD_CLOSED');

    const paid = h.ok(
      await act(tokenA, `payroll/runs/${draft.id}/pay`, { bankAccountId: bankAccount.id, date: '2033-01-31' }, company.id),
      201,
      'pay movement-only run',
    ) as { status: string };
    expect(paid.status).toBe('PAID');
    const reversed = h.ok(
      await act(tokenA, `payroll/runs/${draft.id}/reverse`, { date: '2033-01-31' }, company.id),
      201,
      'reverse movement-only run',
    ) as { status: string };
    expect(reversed.status).toBe('REVERSED');
    const [reversedRun] = (await boot.db.query(
      'SELECT journal_entry_id FROM payroll_runs WHERE tenant_id = ? AND company_id = ? AND id = ?',
      [tenantId, company.id, draft.id],
    )) as { journal_entry_id: bigint | null }[];
    expect(reversedRun!.journal_entry_id).toBeNull();

    const entries = (await boot.db.query(
      `SELECT source_type, reversal_of_id FROM journal_entries
        WHERE tenant_id = ? AND company_id = ? AND source_id = ?
          AND source_type IN ('PAYROLL_RUN', 'PAYROLL_PAYMENT')`,
      [tenantId, company.id, draft.id],
    )) as { source_type: string; reversal_of_id: bigint | null }[];
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.source_type))).toEqual(new Set(['PAYROLL_PAYMENT']));
    expect(entries.filter((entry) => entry.reversal_of_id === null)).toHaveLength(1);
    expect(entries.filter((entry) => entry.reversal_of_id !== null)).toHaveLength(1);
    const reversedStatement = h.ok(
      await get(tokenA, `payroll/employees/${employee.id}/statement?from=2033-01-01&to=2033-01-31`, company.id),
      200,
      'reversed movement-only statement',
    ) as { closingBalance: string; rows: Array<{ documentType: string }> };
    const documentTypes = reversedStatement.rows.map((row) => row.documentType);
    expect(documentTypes).toContain('PAYROLL_RUN');
    expect(documentTypes).toContain('PAYROLL_PAYMENT');
    expect(documentTypes).toContain('PAYROLL_PAYMENT_REVERSAL');
    expect(documentTypes).not.toContain('PAYROLL_RUN_REVERSAL');
    expect(reversedStatement.closingBalance).toBe('10.000');
  });

  it('keeps the draft when its only employee is deactivated before posting', async () => {
    const company = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(tokenA)).send({ legalNameAr: `Empty payroll ${RUN}` }),
      201,
      'create empty payroll company',
    ) as { id: string };
    h.ok(
      await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).set('X-Company-Id', company.id).send({
        code: '2035', startDate: '2035-01-01', endDate: '2035-12-31',
      }),
      201,
      'create empty payroll fiscal year',
    );
    await post(tokenA, 'payroll/settings', { effectiveFrom: '2035-01-01' }, 'empty payroll settings', company.id);
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `EMPTY-${RUN}`, nameAr: 'Only payroll employee', hireDate: '2035-01-01', payMethod: 'CASH', sscCovered: false,
    }, 'create only payroll employee', company.id);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2035-01-01', basicSalary: '100.000',
    }, 'only payroll employee salary', company.id);
    const draft = h.ok(
      await act(tokenA, 'payroll/runs', { period: '2035-01' }, company.id),
      201,
      'create single-employee payroll draft',
    ) as { id: string; status: string; runNo: string | null; lines: Array<{ employeeId: string }> };
    expect(draft.status).toBe('DRAFT');
    expect(draft.lines.map((line) => line.employeeId)).toEqual([employee.id]);

    const deactivated = await h.api().patch(`/api/v1/payroll/employees/${employee.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', company.id).send({ isActive: false });
    expect(deactivated.status).toBe(200);

    const postResult = await act(tokenA, `payroll/runs/${draft.id}/post`, {}, company.id);
    expect(postResult.status).toBe(409);
    expect(postResult.body.error.code).toBe('PAYROLL_NO_EMPLOYEES');
    const unchanged = h.ok(await get(tokenA, `payroll/runs/${draft.id}`, company.id), 200, 'read unchanged payroll draft') as {
      status: string; runNo: string | null; lines: Array<{ employeeId: string }>;
    };
    expect(unchanged.status).toBe('DRAFT');
    expect(unchanged.runNo).toBeNull();
    expect(unchanged.lines.map((line) => line.employeeId)).toEqual([employee.id]);

    const deleted = await h.api().delete(`/api/v1/payroll/runs/${draft.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', company.id);
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ id: draft.id, deleted: true });
  });

  it('posts a recurring earning and deduction movement on the same account and branch separately', async () => {
    h.ok(
      await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).send({
        code: '2034', startDate: '2034-01-01', endDate: '2034-12-31',
      }),
      201,
      'create side-grouping fiscal year',
    );
    await post(tokenA, 'payroll/settings', { effectiveFrom: '2034-01-01' }, 'side-grouping settings', companyAId);
    const branches = h.ok(await get(tokenA, 'branches', companyAId), 200, 'side-grouping branches') as { id: string }[];
    const sharedDescription = 'Shared recurring item';
    const earning = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `SIDE-EARN-${RUN}`, nameAr: sharedDescription, nameEn: sharedDescription,
      kind: 'EARNING', amountType: 'FIXED', rateFactor: '1.000000',
      accountId: accounts['5201'], sscSubject: false, isFixedAllowance: true,
    }, 'same-account recurring earning', companyAId);
    const deduction = await post<{ id: string }>(tokenA, 'payroll/elements', {
      code: `SIDE-DEDUCT-${RUN}`, nameAr: sharedDescription, nameEn: sharedDescription,
      kind: 'DEDUCTION', amountType: 'FIXED', rateFactor: '1.000000',
      accountId: accounts['5201'], sscSubject: false,
    }, 'same-account recurring deduction', companyAId);
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `SIDES-${RUN}`, nameAr: 'Payroll side grouping', hireDate: '2034-01-01',
      branchId: branches[0]!.id, costCenterId, payMethod: 'CASH', sscCovered: false,
    }, 'side-grouping employee', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2034-01-01', basicSalary: '0.000',
    }, 'side-grouping salary', companyAId);
    await post(tokenA, `payroll/employees/${employee.id}/recurring-elements`, {
      payElementId: earning.id, amount: '10.000', validFrom: '2034-01-01',
    }, 'same-account recurring earning assignment', companyAId);
    const deductionMovement = await post<{ id: string }>(tokenA, 'payroll/movements', {
      employeeId: employee.id, payElementId: deduction.id, movementDate: '2034-01-15',
      amount: '3.000', description: sharedDescription,
    }, 'same-account deduction movement', companyAId);
    const run = h.ok(await act(tokenA, 'payroll/runs', { period: '2034-01' }, companyAId), 201, 'create side-grouping run') as {
      id: string;
    };
    h.ok(await act(tokenA, `payroll/runs/${run.id}/post`, {}, companyAId), 201, 'post side-grouping run');

    const lines = (await boot.db.query(
      `SELECT a.code AS account_code, l.branch_id, l.cost_center_id,
              CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_RUN' AND j.source_id = ?
          AND l.description = ?
        ORDER BY l.debit DESC`,
      [tenantId, companyAId, run.id, sharedDescription],
    )) as Array<{ account_code: string; branch_id: bigint; cost_center_id: bigint; debit: string; credit: string }>;
    expect(lines.map((line) => [line.account_code, String(line.branch_id), String(line.cost_center_id), line.debit, line.credit]))
      .toEqual([
        ['5201', branches[0]!.id, costCenterId, '10.000', '0.000'],
      ]);
    const movementLines = (await boot.db.query(
      `SELECT a.code AS account_code, l.branch_id, l.cost_center_id,
              CAST(l.debit AS CHAR) AS debit, CAST(l.credit AS CHAR) AS credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_MOVEMENT' AND j.source_id = ?
          AND a.code = '5201'`,
      [tenantId, companyAId, deductionMovement.id],
    )) as Array<{ account_code: string; branch_id: bigint; cost_center_id: bigint; debit: string; credit: string }>;
    expect(movementLines.map((line) => [line.account_code, String(line.branch_id), String(line.cost_center_id), line.debit, line.credit]))
      .toEqual([
        ['5201', branches[0]!.id, costCenterId, '0.000', '3.000'],
      ]);
  });

  it('rejects impossible calendar dates in every payroll date DTO', async () => {
    const invalidDate = '2026-11-31';
    const missingId = '999999999999999999';
    const responses = [
      await act(tokenA, 'payroll/employees', {
        code: `BAD-HIRE-${RUN}`, nameAr: 'Invalid hire date', hireDate: invalidDate, payMethod: 'CASH',
      }, companyAId),
      await act(tokenA, 'payroll/employees', {
        code: `BAD-LEAVE-${RUN}`, nameAr: 'Invalid leave date', hireDate: '2026-11-01',
        leaveDate: invalidDate, payMethod: 'CASH',
      }, companyAId),
      await h.api().patch(`/api/v1/payroll/employees/${missingId}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId)
        .send({ hireDate: invalidDate }),
      await h.api().patch(`/api/v1/payroll/employees/${missingId}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId)
        .send({ leaveDate: invalidDate }),
      await h.api().post(`/api/v1/payroll/employees/${missingId}/salaries`).set(h.auth(tokenA)).set('X-Company-Id', companyAId)
        .send({ effectiveFrom: invalidDate, basicSalary: '1.000' }),
      await act(tokenA, `payroll/employees/${missingId}/recurring-elements`, {
        payElementId: '1', amount: '1.000', validFrom: invalidDate,
      }, companyAId),
      await act(tokenA, `payroll/employees/${missingId}/recurring-elements`, {
        payElementId: '1', amount: '1.000', validFrom: '2026-11-01', validTo: invalidDate,
      }, companyAId),
      await act(tokenA, 'payroll/settings', { effectiveFrom: invalidDate }, companyAId),
      await act(tokenA, 'payroll/movements', {
        employeeId: missingId, payElementId: '1', movementDate: invalidDate, amount: '1.000', description: 'Invalid date',
      }, companyAId),
      await get(tokenA, `payroll/employees/${missingId}/statement?from=${invalidDate}&to=2099-12-31`, companyAId),
      await get(tokenA, `payroll/employees/${missingId}/statement?from=2000-01-01&to=${invalidDate}`, companyAId),
      await get(tokenA, `payroll/reports/employee-statement?employeeId=${missingId}&from=${invalidDate}&to=2099-12-31`, companyAId),
      await get(tokenA, `payroll/reports/employee-statement?employeeId=${missingId}&from=2000-01-01&to=${invalidDate}`, companyAId),
      await act(tokenA, `payroll/movements/${missingId}/reverse`, { date: invalidDate }, companyAId),
      await act(tokenA, `payroll/runs/${missingId}/reverse`, { date: invalidDate }, companyAId),
      await act(tokenA, `payroll/runs/${missingId}/pay`, { bankAccountId: '1', date: invalidDate }, companyAId),
    ];
    expect(responses).toHaveLength(16);
    expect(responses.map((response) => response.status)).toEqual(Array(16).fill(400));
    expect(responses.every((response) => response.body.error.code === 'VALIDATION')).toBe(true);
  });

  it('withholds Jordanian income tax, preserves manual overrides, and scopes reset by tenant', async () => {
    const period = '2040-01';
    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).send({
      code: '2040',
      startDate: '2040-01-01',
      endDate: '2040-12-31',
    }), 201, 'create tax fiscal year');
    const chartProvisionedSettings = h.ok(await get(tokenA, 'payroll/settings', companyAId), 200, 'provisioned tax settings') as Array<{
      taxBrackets: Array<{ upTo: string | null; rate: string }>;
    }>;
    expect(chartProvisionedSettings.some((setting) => setting.taxBrackets.length === 6)).toBe(true);
    await post(tokenA, 'payroll/settings', { effectiveFrom: '2040-01-01' }, 'tax settings', companyAId);
    const taxSettings = h.ok(await get(tokenA, 'payroll/settings', companyAId), 200, 'list tax settings') as Array<{
      effectiveFrom: string; taxBrackets: Array<{ upTo: string | null; rate: string }>;
    }>;
    expect(taxSettings.find((setting) => setting.effectiveFrom.startsWith('2040-01-01'))?.taxBrackets).toHaveLength(6);
    const invalidBrackets = await act(tokenA, 'payroll/settings', {
      effectiveFrom: '2041-01-01',
      taxBrackets: [{ upTo: '832.000', rate: '0.10' }, { upTo: '416.000', rate: '0.05' }],
    }, companyAId);
    expect(invalidBrackets.status).toBe(400);
    const branch = (h.ok(await get(tokenA, 'branches', companyAId), 200, 'tax branch') as { id: string }[])[0]!;
    const createEmployee = async (code: string, basicSalary: string, tax: Record<string, unknown> = {}) => {
      const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
        code: `${code}-${RUN}`,
        nameAr: code,
        hireDate: '2040-01-01',
        payMethod: 'CASH',
        sscCovered: code !== 'PY7',
        branchId: branch.id,
        costCenterId,
        ...tax,
      }, code, companyAId);
      await post(tokenA, `payroll/employees/${employee.id}/salaries`, {
        effectiveFrom: '2040-01-01', basicSalary,
      }, `${code} salary`, companyAId);
      return employee;
    };
    const createElement = (code: string, kind: 'EARNING' | 'DEDUCTION', amountType: 'FIXED' | 'PER_DAY', allowance = false) =>
      post<{ id: string }>(tokenA, 'payroll/elements', {
        code: `${code}-${RUN}`, nameAr: code, kind, amountType, rateFactor: '1.000000',
        sscSubject: false, taxSubject: true, isFixedAllowance: allowance, accountId: accounts['5201'],
      }, `${code} element`, companyAId);
    const bonus = await createElement('TAX-BONUS', 'EARNING', 'FIXED');
    const absence = await createElement('TAX-ABSENCE', 'DEDUCTION', 'PER_DAY');
    const transport = await createElement('TAX-TRANSPORT', 'EARNING', 'FIXED', true);
    const py5 = await createEmployee('PY5', '2000.000');
    const py6 = await createEmployee('PY6', '1200.000', { taxDependants: true });
    const py7 = await createEmployee('PY7', '20000.000', { sscCovered: false });
    const py7b = await createEmployee('PY7B', '20000.000', { sscCovered: false, taxOtherExemption: '2000.000' });
    await post(tokenA, `payroll/employees/${py6.id}/recurring-elements`, {
      payElementId: transport.id, amount: '50.000', validFrom: '2040-01-01',
    }, 'PY6 recurring allowance', companyAId);
    await post(tokenA, 'payroll/movements', {
      employeeId: py5.id, payElementId: bonus.id, movementDate: '2040-01-15', amount: '500.000', description: 'Tax bonus',
    }, 'PY5 bonus movement', companyAId);
    await post(tokenA, 'payroll/movements', {
      employeeId: py5.id, payElementId: absence.id, movementDate: '2040-01-16', quantity: '1', description: 'PY5 absence',
    }, 'PY5 absence movement', companyAId);

    const draft = h.ok(await act(tokenA, 'payroll/runs', { period }, companyAId), 201, 'create tax run') as { id: string };
    const initial = h.ok(await get(tokenA, `payroll/runs/${draft.id}`, companyAId), 200, 'read tax run') as {
      lines: Array<{ id: string; employeeId: string; taxableIncome: string; incomeTax: string; nationalContribution: string; taxManual: boolean }>;
    };
    const lineFor = (employeeId: string) => initial.lines.find((line) => line.employeeId === employeeId)!;
    expect(lineFor(py5.id)).toEqual(expect.objectContaining({
      taxableIncome: '2433.333', incomeTax: '212.833', nationalContribution: '0', taxManual: false,
    }));
    expect(lineFor(py6.id)).toEqual(expect.objectContaining({
      taxableIncome: '1250', incomeTax: '0', nationalContribution: '0',
    }));
    expect(lineFor(py7.id)).toEqual(expect.objectContaining({
      taxableIncome: '20000', incomeTax: '4630.34', nationalContribution: '25.84',
    }));
    expect(lineFor(py7b.id)).toEqual(expect.objectContaining({
      taxableIncome: '20000', incomeTax: '4587.007', nationalContribution: '24.173',
    }));

    const py7Line = lineFor(py7.id);
    h.ok(await h.api().patch(`/api/v1/payroll/runs/${draft.id}/lines/${py7Line.id}/income-tax`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ incomeTax: '4000.000' }), 200, 'manual tax override');
    const recomputed = h.ok(await act(tokenA, `payroll/runs/${draft.id}/recompute`, {}, companyAId), 201, 'recompute tax run') as {
      lines: Array<{ id: string; employeeId: string; incomeTax: string; taxManual: boolean }>;
    };
    expect(recomputed.lines.find((line) => line.employeeId === py7.id))
      .toEqual(expect.objectContaining({ incomeTax: '4000', taxManual: true }));
    const updatedLine = recomputed.lines.find((line) => line.employeeId === py7.id)!;
    const companyB = (h.ok(await h.get(tokenB, 'companies'), 200, 'tenant B companies') as { id: string }[])[0]!;
    const foreignReset = await h.api().delete(`/api/v1/payroll/runs/${draft.id}/lines/${updatedLine.id}/income-tax`)
      .set(h.auth(tokenB)).set('X-Company-Id', companyB.id);
    expect(foreignReset.status).toBe(404);
    h.ok(await h.api().delete(`/api/v1/payroll/runs/${draft.id}/lines/${updatedLine.id}/income-tax`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId), 200, 'reset manual tax');
    const restored = h.ok(await get(tokenA, `payroll/runs/${draft.id}`, companyAId), 200, 'read restored tax') as {
      incomeTaxTotal: string;
      lines: Array<{ id: string; employeeId: string; incomeTax: string; taxManual: boolean }>;
    };
    const restoredPy7 = restored.lines.find((line) => line.employeeId === py7.id)!;
    expect(restoredPy7).toEqual(expect.objectContaining({ incomeTax: '4630.34', taxManual: false }));
    h.ok(await h.api().patch(`/api/v1/payroll/runs/${draft.id}/lines/${restoredPy7.id}/income-tax`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ incomeTax: '4000.000' }), 200, 'reapply manual tax');
    const readyToPost = h.ok(await act(tokenA, `payroll/runs/${draft.id}/recompute`, {}, companyAId), 201, 'recompute before late movement') as {
      lines: Array<{ employeeId: string; incomeTax: string; taxManual: boolean }>;
    };
    expect(readyToPost.lines.find((line) => line.employeeId === py5.id))
      .toEqual(expect.objectContaining({ incomeTax: '212.833', taxManual: false }));
    expect(readyToPost.lines.find((line) => line.employeeId === py7.id))
      .toEqual(expect.objectContaining({ incomeTax: '4000', taxManual: true }));
    await post(tokenA, 'payroll/movements', {
      employeeId: py5.id,
      payElementId: bonus.id,
      movementDate: '2040-01-20',
      amount: '100.000',
      description: 'Late tax bonus',
    }, 'late tax bonus', companyAId);
    h.ok(await act(tokenA, `payroll/runs/${draft.id}/post`, {}, companyAId), 201, 'post automatic-tax run');
    const postedRun = h.ok(await get(tokenA, `payroll/runs/${draft.id}`, companyAId), 200, 'read posted tax run') as {
      incomeTaxTotal: string;
      lines: Array<{ employeeId: string; taxableIncome: string; incomeTax: string; taxManual: boolean }>;
    };
    expect(postedRun.lines.find((line) => line.employeeId === py5.id))
      .toEqual(expect.objectContaining({ taxableIncome: '2533.333', incomeTax: '237.833', taxManual: false }));
    expect(postedRun.lines.find((line) => line.employeeId === py7.id))
      .toEqual(expect.objectContaining({ incomeTax: '4000', taxManual: true }));
    const credits = await boot.db.query(
      `SELECT CAST(COALESCE(SUM(l.credit), 0) AS CHAR) AS tax_credit
         FROM journal_entries j
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
        WHERE j.tenant_id = ? AND j.company_id = ? AND j.source_type = 'PAYROLL_RUN'
          AND j.source_id = ? AND l.account_id = ?`,
      [tenantId, companyAId, draft.id, accounts['2108']],
    ) as Array<{ tax_credit: string }>;
    expect(new Decimal(credits[0]?.tax_credit ?? '0').eq(postedRun.incomeTaxTotal)).toBe(true);
  });
});

describe('Leave endpoints', () => {
  it('validates requests, approves and cancels them, and isolates every company-scoped resource', async () => {
    for (const year of [2026, 2027, 2028]) {
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({
        code: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31`,
      }), 201, `create leave FY ${year}`);
    }
    const settings = h.ok(await get(tokenA, 'payroll/settings', companyAId), 200, 'existing leave settings') as Array<{ effectiveFrom: string }>;
    for (const year of [2026, 2027, 2028, 2031]) {
      const effectiveFrom = `${year}-01-01`;
      if (!settings.some((setting) => setting.effectiveFrom.startsWith(effectiveFrom))) {
        await post(tokenA, 'payroll/settings', { effectiveFrom }, `leave settings ${year}`, companyAId);
      }
    }
    const employee = await post<{ id: string }>(tokenA, 'payroll/employees', {
      code: `LV-${RUN}`,
      nameAr: 'موظف الإجازة',
      hireDate: '2020-01-01',
      payMethod: 'CASH',
    }, 'leave employee', companyAId);
    const types = h.ok(await get(tokenA, 'payroll/leave-types', companyAId), 200, 'leave types') as Array<{ id: string; code: string }>;
    const annual = types.find((type) => type.code === 'ANNUAL')!;
    const custom = await post<{ id: string }>(tokenA, 'payroll/leave-types', {
      code: `CUSTOM-${RUN}`,
      nameAr: 'إجازة مخصصة',
      nameEn: 'Custom leave',
      category: 'OTHER',
      countBasis: 'CALENDAR_DAYS',
      maxDaysPerYear: '10.00',
    }, 'create leave type', companyAId);
    const changedType = h.ok(await h.api().patch(`/api/v1/payroll/leave-types/${custom.id}`)
      .set(h.auth(tokenA)).set('X-Company-Id', companyAId).send({ nameEn: 'Updated custom leave' }), 200, 'update leave type') as { nameEn: string };
    expect(changedType.nameEn).toBe('Updated custom leave');
    const tokenBCompanies = h.ok(await h.get(tokenB, 'companies'), 200, 'tenant B companies') as Array<{ id: string }>;
    const companyBId = tokenBCompanies[0]!.id;
    const typesB = h.ok(await get(tokenB, 'payroll/leave-types', companyBId), 200, 'tenant B leave types') as Array<{ id: string }>;
    expect(typesB.some((type) => type.id === custom.id)).toBe(false);
    expect((await h.api().patch(`/api/v1/payroll/leave-types/${custom.id}`).set(h.auth(tokenB))
      .set('X-Company-Id', companyBId).send({ nameAr: 'Foreign type' })).status).toBe(404);

    const holiday = await post<{ id: string }>(tokenA, 'payroll/holidays', {
      date: '2031-04-04',
      nameAr: 'عطلة الاختبار',
      nameEn: 'Test holiday',
    }, 'create holiday', companyAId);
    const holidaysA = h.ok(await get(tokenA, 'payroll/holidays?year=2031', companyAId), 200, 'tenant A holidays') as Array<{ id: string }>;
    expect(holidaysA.some((row) => row.id === holiday.id)).toBe(true);
    expect(await get(tokenB, 'payroll/holidays?year=2031', companyBId)).toMatchObject({ status: 200, body: [] });
    expect((await h.api().delete(`/api/v1/payroll/holidays/${holiday.id}`).set(h.auth(tokenB)).set('X-Company-Id', companyBId)).status).toBe(404);

    const requestBody = {
      employeeId: employee.id,
      leaveTypeId: annual.id,
      startDate: '2031-03-03',
      endDate: '2031-03-04',
      notes: 'Leave endpoint test',
    };
    const request = await post<{ id: string; days: string; calendarDays: number; status: string }>(
      tokenA, 'payroll/leave-requests', requestBody, 'create leave request', companyAId,
    );
    expect(request).toEqual(expect.objectContaining({ days: '2', calendarDays: 2, status: 'SUBMITTED' }));
    const overlap = await act(tokenA, 'payroll/leave-requests', {
      ...requestBody,
      startDate: '2031-03-04',
      endDate: '2031-03-05',
    }, companyAId);
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('LEAVE_REQUEST_OVERLAP');
    const crossYear = await act(tokenA, 'payroll/leave-requests', {
      ...requestBody,
      startDate: '2031-12-31',
      endDate: '2032-01-01',
    }, companyAId);
    expect(crossYear.status).toBe(400);
    expect(crossYear.body.error.code).toBe('LEAVE_REQUEST_SPANS_YEAR');
    const sick = types.find((type) => type.code === 'SICK')!;
    const crossYearSick = await act(tokenA, 'payroll/leave-requests', {
      ...requestBody,
      leaveTypeId: sick.id,
      startDate: '2031-12-31',
      endDate: '2032-01-01',
    }, companyAId);
    expect(crossYearSick.status).toBe(400);
    expect(crossYearSick.body.error.code).toBe('LEAVE_REQUEST_SPANS_YEAR');
    const requestsA = h.ok(await get(tokenA, `payroll/leave-requests?employeeId=${employee.id}&year=2031`, companyAId), 200, 'tenant A requests') as Array<{ id: string }>;
    expect(requestsA.some((row) => row.id === request.id)).toBe(true);
    expect(await get(tokenB, 'payroll/leave-requests', companyBId)).toMatchObject({ status: 200, body: [] });
    const foreignRequest = await act(tokenB, 'payroll/leave-requests', requestBody, companyBId);
    expect(foreignRequest.status).toBe(404);
    const maternity = types.find((type) => type.code === 'MATERNITY')!;
    const maternityRequest = await post<{ id: string; days: string; calendarDays: number }>(
      tokenA,
      'payroll/leave-requests',
      { ...requestBody, leaveTypeId: maternity.id, startDate: '2031-11-15', endDate: '2032-01-23' },
      'create cross-year maternity request',
      companyAId,
    );
    expect(maternityRequest).toEqual(expect.objectContaining({ days: '70', calendarDays: 70 }));
    const nextYearRequests = h.ok(await get(tokenA, 'payroll/leave-requests?year=2032', companyAId), 200, 'cross-year leave filter') as Array<{ id: string }>;
    expect(nextYearRequests.some((row) => row.id === maternityRequest.id)).toBe(true);

    const approved = h.ok(await act(tokenA, `payroll/leave-requests/${request.id}/approve`, {}, companyAId), 200, 'approve leave') as { requestNo: string };
    expect(approved.requestNo.startsWith('LV')).toBe(true);
    for (const action of ['approve', 'reject', 'cancel']) {
      const response = await act(tokenB, `payroll/leave-requests/${request.id}/${action}`, {}, companyBId);
      expect(response.status).toBe(404);
    }
    const balancesA = h.ok(await get(tokenA, `payroll/leave-balances?year=2031&employeeId=${employee.id}`, companyAId), 200, 'tenant A balances') as Array<{ employeeId: string }>;
    expect(balancesA.length).toBeGreaterThan(0);
    expect(await get(tokenB, `payroll/leave-balances?year=2031&employeeId=${employee.id}`, companyBId)).toMatchObject({ status: 200, body: [] });

    h.ok(await h.api().post('/api/v1/payroll/leave-adjustments').set(h.auth(tokenA)).set('X-Company-Id', companyAId)
      .set('Idempotency-Key', `leave-adjustment-${RUN}`).send({
        employeeId: employee.id, leaveTypeId: annual.id, year: '2031', days: '1.00', reason: 'Test adjustment',
      }), 201, 'create leave adjustment');
    const adjustmentsA = h.ok(await get(tokenA, `payroll/leave-adjustments?year=2031&employeeId=${employee.id}`, companyAId), 200, 'tenant A adjustments') as Array<{ employeeId: string }>;
    expect(adjustmentsA).toHaveLength(1);
    expect(await get(tokenB, 'payroll/leave-adjustments?year=2031', companyBId)).toMatchObject({ status: 200, body: [] });
    expect((await h.api().post('/api/v1/payroll/leave-adjustments').set(h.auth(tokenB)).set('X-Company-Id', companyBId)
      .set('Idempotency-Key', `foreign-adjustment-${RUN}`)
      .send({ employeeId: employee.id, leaveTypeId: annual.id, year: '2031', days: '1', reason: 'Foreign' })).status).toBe(404);

    const rejectRequest = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      ...requestBody, startDate: '2031-03-10', endDate: '2031-03-11',
    }, 'create request to reject', companyAId);
    h.ok(await act(tokenA, `payroll/leave-requests/${rejectRequest.id}/reject`, {}, companyAId), 200, 'reject leave');
    const cancelRequest = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      ...requestBody, startDate: '2028-03-12', endDate: '2028-03-13',
    }, 'create request to cancel', companyAId);
    h.ok(await act(tokenA, `payroll/leave-requests/${cancelRequest.id}/approve`, {}, companyAId), 200, 'approve request to cancel');
    const cancelled = h.ok(await act(tokenA, `payroll/leave-requests/${cancelRequest.id}/cancel`, {}, companyAId), 200, 'cancel leave') as { status: string };
    expect(cancelled.status).toBe('CANCELLED');

    h.ok(await h.api().delete(`/api/v1/payroll/holidays/${holiday.id}`).set(h.auth(tokenA)).set('X-Company-Id', companyAId), 200, 'delete holiday');

    const createBalanceEmployee = (code: string, hireDate: string) => post<{ id: string }>(
      tokenA,
      'payroll/employees',
      { code: `${code}-${RUN}`, nameAr: code, hireDate, payMethod: 'CASH' },
      `${code} balance employee`,
      companyAId,
    );
    const lv1 = await createBalanceEmployee('LV1', '2026-07-01');
    const lv1Start = await get(tokenA, `payroll/leave-balances?year=2026&employeeId=${lv1.id}`, companyAId);
    const lv1Year1 = (h.ok(lv1Start, 200, 'LV1 2026 balance') as Array<{ category: string; entitlement: string }>).find((row) => row.category === 'ANNUAL')!;
    expect(lv1Year1.entitlement).toBe('7.06');
    const lv1Leave2026 = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: lv1.id, leaveTypeId: annual.id, startDate: '2026-07-06', endDate: '2026-07-07',
    }, 'LV1 2026 leave', companyAId);
    h.ok(await act(tokenA, `payroll/leave-requests/${lv1Leave2026.id}/approve`, {}, companyAId), 200, 'approve LV1 2026 leave');
    const lv1Year2 = h.ok(await get(tokenA, `payroll/leave-balances?year=2027&employeeId=${lv1.id}`, companyAId), 200, 'LV1 2027 balance') as Array<{ category: string; available: string }>;
    expect(lv1Year2.find((row) => row.category === 'ANNUAL')?.available).toBe('19.06');
    const lv1Leave2027 = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: lv1.id, leaveTypeId: annual.id, startDate: '2027-07-05', endDate: '2027-07-07',
    }, 'LV1 2027 leave', companyAId);
    h.ok(await act(tokenA, `payroll/leave-requests/${lv1Leave2027.id}/approve`, {}, companyAId), 200, 'approve LV1 2027 leave');
    const lv1Year3 = h.ok(await get(tokenA, `payroll/leave-balances?year=2028&employeeId=${lv1.id}`, companyAId), 200, 'LV1 2028 balance') as Array<{ category: string; available: string }>;
    expect(lv1Year3.find((row) => row.category === 'ANNUAL')?.available).toBe('28');

    const lv1b = await createBalanceEmployee('LV1B', '2021-04-01');
    const lv1b2026 = h.ok(await get(tokenA, `payroll/leave-balances?year=2026&employeeId=${lv1b.id}`, companyAId), 200, 'LV1b 2026 balance') as Array<{ category: string; entitlement: string }>;
    expect(lv1b2026.find((row) => row.category === 'ANNUAL')?.entitlement).toBe('19.27');
    const lv1b2027 = h.ok(await get(tokenA, `payroll/leave-balances?year=2027&employeeId=${lv1b.id}`, companyAId), 200, 'LV1b 2027 balance') as Array<{ category: string; entitlement: string }>;
    expect(lv1b2027.find((row) => row.category === 'ANNUAL')?.entitlement).toBe('21');

    const lv2 = await createBalanceEmployee('LV2', '2020-01-01');
    await post(tokenA, 'payroll/holidays', {
      date: '2026-12-08', nameAr: 'عطلة LV2', nameEn: 'LV2 holiday',
    }, 'LV2 holiday', companyAId);
    const lv2Request = await post<{ days: string; calendarDays: number }>(tokenA, 'payroll/leave-requests', {
      employeeId: lv2.id, leaveTypeId: annual.id, startDate: '2026-12-06', endDate: '2026-12-12',
    }, 'LV2 annual request', companyAId);
    expect(lv2Request).toEqual(expect.objectContaining({ days: '5', calendarDays: 7 }));

    const sickType = types.find((type) => type.code === 'SICK')!;
    const sickEmployee = await createBalanceEmployee('LV-SICK', '2020-01-01');
    const nonHospital = await post<{ id: string; days: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: sickEmployee.id, leaveTypeId: sickType.id, startDate: '2026-01-04', endDate: '2026-01-19',
    }, '14 sick days', companyAId);
    expect(nonHospital.days).toBe('14');
    h.ok(await act(tokenA, `payroll/leave-requests/${nonHospital.id}/approve`, {}, companyAId), 200, 'approve 14 non-hospital sick days');
    const extraNonHospital = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: sickEmployee.id, leaveTypeId: sickType.id, startDate: '2026-01-21', endDate: '2026-01-21',
    }, 'extra non-hospital sick day', companyAId);
    const nonHospitalLimit = await act(tokenA, `payroll/leave-requests/${extraNonHospital.id}/approve`, {}, companyAId);
    expect(nonHospitalLimit.status).toBe(400);
    expect(nonHospitalLimit.body.error.code).toBe('LEAVE_LIMIT_EXCEEDED');
    const hospitalised = await post<{ id: string; days: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: sickEmployee.id, leaveTypeId: sickType.id, startDate: '2026-01-25', endDate: '2026-02-09', hospitalised: true,
    }, '14 hospital sick days', companyAId);
    expect(hospitalised.days).toBe('14');
    h.ok(await act(tokenA, `payroll/leave-requests/${hospitalised.id}/approve`, {}, companyAId), 200, 'approve hospital sick days');
    const overSickLimit = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: sickEmployee.id, leaveTypeId: sickType.id, startDate: '2026-02-10', endDate: '2026-02-10', hospitalised: true,
    }, 'sick request over 28-day limit', companyAId);
    const sickLimit = await act(tokenA, `payroll/leave-requests/${overSickLimit.id}/approve`, {}, companyAId);
    expect(sickLimit.status).toBe(400);
    expect(sickLimit.body.error.code).toBe('LEAVE_LIMIT_EXCEEDED');

    const hajj = types.find((type) => type.code === 'HAJJ')!;
    const underService = await createBalanceEmployee('LV-HAJJ-UNDER', '2022-01-01');
    const earlyHajj = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: underService.id, leaveTypeId: hajj.id, startDate: '2026-01-04', endDate: '2026-01-19',
    }, 'Hajj before service minimum', companyAId);
    const serviceLimit = await act(tokenA, `payroll/leave-requests/${earlyHajj.id}/approve`, {}, companyAId);
    expect(serviceLimit.status).toBe(400);
    expect(serviceLimit.body.error.code).toBe('LEAVE_LIMIT_EXCEEDED');
    const eligibleHajj = await createBalanceEmployee('LV-HAJJ-ELIGIBLE', '2020-01-01');
    const firstHajj = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: eligibleHajj.id, leaveTypeId: hajj.id, startDate: '2026-01-04', endDate: '2026-01-19',
    }, 'eligible Hajj request', companyAId);
    h.ok(await act(tokenA, `payroll/leave-requests/${firstHajj.id}/approve`, {}, companyAId), 200, 'approve eligible Hajj leave');
    const secondHajj = await post<{ id: string }>(tokenA, 'payroll/leave-requests', {
      employeeId: eligibleHajj.id, leaveTypeId: hajj.id, startDate: '2026-03-01', endDate: '2026-03-16',
    }, 'second Hajj request', companyAId);
    const onceLimit = await act(tokenA, `payroll/leave-requests/${secondHajj.id}/approve`, {}, companyAId);
    expect(onceLimit.status).toBe(400);
    expect(onceLimit.body.error.code).toBe('LEAVE_LIMIT_EXCEEDED');
  });
});

describe('Leave payroll effects and provision', () => {
  it('applies unpaid and maternity leave across monthly runs and enforces posted-run cancellation', async () => {
    const token = await register('leave-effects');
    const company = (h.ok(await h.get(token, 'companies'), 200, 'leave effects company') as { id: string }[])[0]!;
    const branch = (h.ok(await get(token, 'branches', company.id), 200, 'leave effects branch') as { id: string }[])[0]!;
    const costCentre = await post<{ id: string }>(token, 'cost-centers', {
      code: `LE-${RUN}`, nameAr: 'Leave effects',
    }, 'leave effects cost centre', company.id);
    for (const year of [2026, 2027]) {
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
        code: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31`,
      }), 201, `create leave effects FY ${year}`);
    }
    const createEmployee = async (code: string, basicSalary: string, sscCovered = true) => {
      const employee = await post<{ id: string }>(token, 'payroll/employees', {
        code: `${code}-${RUN}`, nameAr: code, hireDate: '2026-01-01', payMethod: 'CASH',
        sscCovered, branchId: branch.id, costCenterId: costCentre.id,
      }, `${code} employee`, company.id);
      await post(token, `payroll/employees/${employee.id}/salaries`, {
        effectiveFrom: '2026-01-01', basicSalary,
      }, `${code} salary`, company.id);
      return employee;
    };
    const types = h.ok(await get(token, 'payroll/leave-types', company.id), 200, 'leave effect types') as Array<{
      id: string; code: string; payElementId: string | null;
    }>;
    const unpaidType = types.find((type) => type.code === 'UNPAID')!;
    const maternityType = types.find((type) => type.code === 'MATERNITY')!;
    const annualType = types.find((type) => type.code === 'ANNUAL')!;
    const yearLimitedType = await post<{ id: string }>(token, 'payroll/leave-types', {
      code: `OTHER-LIMIT-${RUN}`, nameAr: 'Year limited', category: 'OTHER', countBasis: 'CALENDAR_DAYS',
      maxDaysPerYear: '5',
    }, 'create yearly leave limit', company.id);
    const yearLimitedEmployee = await createEmployee('LV-YEAR-LIMIT', '600.000');
    const crossYear = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: yearLimitedEmployee.id, leaveTypeId: yearLimitedType.id,
      startDate: '2026-12-30', endDate: '2027-01-02',
    }, 'create cross-year limit request', company.id);
    h.ok(await act(token, `payroll/leave-requests/${crossYear.id}/approve`, {}, company.id), 200, 'approve cross-year limit request');
    const overYearLimit = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: yearLimitedEmployee.id, leaveTypeId: yearLimitedType.id,
      startDate: '2027-01-03', endDate: '2027-01-06',
    }, 'create over-limit request', company.id);
    const deniedYearLimit = await act(token, `payroll/leave-requests/${overYearLimit.id}/approve`, {}, company.id);
    expect(deniedYearLimit.status).toBe(400);
    expect(deniedYearLimit.body.error.code).toBe('LEAVE_LIMIT_EXCEEDED');
    const impossibleHoliday = await act(token, 'payroll/holidays', {
      date: '2026-02-30', nameAr: 'Invalid date',
    }, company.id);
    expect(impossibleHoliday.status).toBe(400);
    expect(impossibleHoliday.body.error.code).toBe('VALIDATION');
    expect(unpaidType.payElementId).toBeTruthy();
    expect(maternityType.payElementId).toBeTruthy();
    const elements = h.ok(await get(token, 'payroll/elements', company.id), 200, 'leave pay elements') as Array<{
      id: string; code: string;
    }>;
    const transport = elements.find((element) => element.code === 'TRANSPORT')!;
    for (const change of [{ kind: 'EARNING' }, { isActive: false }]) {
      const blocked = await h.api().patch(`/api/v1/payroll/elements/${unpaidType.payElementId}`)
        .set(h.auth(token)).set('X-Company-Id', company.id).send(change);
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('INVALID_STATUS_TRANSITION');
    }
    const invalidCreateType = await act(token, 'payroll/leave-types', {
      code: `BAD-ELEMENT-${RUN}`, nameAr: 'Bad element', category: 'OTHER', countBasis: 'CALENDAR_DAYS',
      payElementId: transport.id,
    }, company.id);
    expect(invalidCreateType.status).toBe(400);
    expect(invalidCreateType.body.error.code).toBe('PAYROLL_ACCOUNT_INVALID');
    const invalidUpdateType = await h.api().patch(`/api/v1/payroll/leave-types/${annualType.id}`)
      .set(h.auth(token)).set('X-Company-Id', company.id).send({ payElementId: transport.id });
    expect(invalidUpdateType.status).toBe(400);
    expect(invalidUpdateType.body.error.code).toBe('PAYROLL_ACCOUNT_INVALID');
    const unpaidEmployee = await createEmployee('LV3', '600.000');
    const impossibleRequest = await act(token, 'payroll/leave-requests', {
      employeeId: unpaidEmployee.id, leaveTypeId: annualType.id,
      startDate: '2026-02-30', endDate: '2026-03-01',
    }, company.id);
    expect(impossibleRequest.status).toBe(400);
    expect(impossibleRequest.body.error.code).toBe('VALIDATION');
    const cappedUnpaidEmployee = await createEmployee('LV30', '600.000');
    const maternityEmployee = await createEmployee('LV4', '900.000');
    const nonSscEmployee = await createEmployee('LV4-NONSSC', '900.000', false);
    const unpaidRequest = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: unpaidEmployee.id, leaveTypeId: unpaidType.id, startDate: '2026-12-14', endDate: '2026-12-16',
    }, 'LV3 unpaid leave request', company.id);
    h.ok(await act(token, `payroll/leave-requests/${unpaidRequest.id}/approve`, {}, company.id), 200, 'approve LV3 leave');
    for (const [startDate, endDate] of [['2026-12-01', '2026-12-15'], ['2026-12-16', '2026-12-31']]) {
      const request = await post<{ id: string }>(token, 'payroll/leave-requests', {
        employeeId: cappedUnpaidEmployee.id, leaveTypeId: unpaidType.id, startDate, endDate,
      }, 'create capped unpaid request', company.id);
      h.ok(await act(token, `payroll/leave-requests/${request.id}/approve`, {}, company.id), 200, 'approve capped unpaid request');
    }
    const maternityRequest = await post<{ id: string; days: string; calendarDays: number }>(token, 'payroll/leave-requests', {
      employeeId: maternityEmployee.id, leaveTypeId: maternityType.id, startDate: '2026-11-15', endDate: '2027-01-23',
    }, 'LV4 cross-year maternity', company.id);
    expect(maternityRequest).toEqual(expect.objectContaining({ days: '70', calendarDays: 70 }));
    h.ok(await act(token, `payroll/leave-requests/${maternityRequest.id}/approve`, {}, company.id), 200, 'approve LV4 maternity');
    const nonSscMaternity = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: nonSscEmployee.id, leaveTypeId: maternityType.id, startDate: '2026-11-15', endDate: '2027-01-23',
    }, 'LV4 non-SSC maternity', company.id);
    h.ok(await act(token, `payroll/leave-requests/${nonSscMaternity.id}/approve`, {}, company.id), 200, 'approve non-SSC maternity');

    const createRun = async (period: string) => {
      const draft = h.ok(await act(token, 'payroll/runs', { period }, company.id), 201, `${period} leave run`) as { id: string };
      return h.ok(await get(token, `payroll/runs/${draft.id}`, company.id), 200, `${period} leave detail`) as {
        id: string; lines: Array<{ employeeId: string; deductions: string; sscBase: string; sscEmployee: string; sscEmployer: string; incomeTax: string; net: string; items?: Array<{ leaveRequestId: string | null }> }>;
      };
    };
    const lineFor = (run: { lines: Array<{ employeeId: string; deductions: string; sscBase: string; sscEmployee: string; sscEmployer: string; incomeTax: string; net: string; items?: Array<{ leaveRequestId: string | null }> }> }, employeeId: string) =>
      run.lines.find((line) => line.employeeId === employeeId)!;
    const november = await createRun('2026-11');
    expect(lineFor(november, maternityEmployee.id)).toEqual(expect.objectContaining({
      deductions: '480', sscBase: '420', sscEmployee: '31.5', sscEmployer: '59.85', net: '388.5',
    }));
    const december = await createRun('2026-12');
    expect(lineFor(december, unpaidEmployee.id)).toEqual(expect.objectContaining({
      deductions: '60', sscBase: '540', sscEmployee: '40.5', sscEmployer: '76.95', incomeTax: '0', net: '499.5',
    }));
    expect(lineFor(december, cappedUnpaidEmployee.id)).toEqual(expect.objectContaining({ deductions: '600', net: '0' }));
    expect(lineFor(december, maternityEmployee.id)).toEqual(expect.objectContaining({
      deductions: '900', sscBase: '0', sscEmployee: '0', sscEmployer: '0', net: '0',
    }));
    expect(lineFor(december, nonSscEmployee.id).deductions).toBe('0');
    const january = await createRun('2027-01');
    expect(lineFor(january, maternityEmployee.id)).toEqual(expect.objectContaining({
      deductions: '690', sscBase: '290', sscEmployee: '21.75', sscEmployer: '41.325', net: '188.25',
    }));
    const unpaidItems = lineFor(december, unpaidEmployee.id).items ?? [];
    expect(unpaidItems.some((item) => item.leaveRequestId === unpaidRequest.id)).toBe(true);

    await post(token, `payroll/runs/${december.id}/post`, {}, 'post LV3/LV4 December run', company.id);
    const cancelAfterPost = await act(token, `payroll/leave-requests/${unpaidRequest.id}/cancel`, {}, company.id);
    expect(cancelAfterPost.status).toBe(409);
    expect(cancelAfterPost.body.error.code).toBe('LEAVE_RUN_ALREADY_POSTED');

    const postedPeriodEmployee = await createEmployee('LV-POSTED-APPROVAL', '600.000');
    const unpaidAfterPost = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: postedPeriodEmployee.id, leaveTypeId: unpaidType.id, startDate: '2026-12-07', endDate: '2026-12-08',
    }, 'unpaid leave after posting', company.id);
    const deniedApproval = await act(token, `payroll/leave-requests/${unpaidAfterPost.id}/approve`, {}, company.id);
    expect(deniedApproval.status).toBe(409);
    expect(deniedApproval.body.error.code).toBe('LEAVE_RUN_ALREADY_POSTED');
    const annualAfterPost = await post<{ id: string }>(token, 'payroll/leave-requests', {
      employeeId: postedPeriodEmployee.id, leaveTypeId: annualType.id, startDate: '2026-12-09', endDate: '2026-12-10',
    }, 'annual leave after posting', company.id);
    h.ok(await act(token, `payroll/leave-requests/${annualAfterPost.id}/approve`, {}, company.id), 200, 'approve annual leave after posted run');
  });

  it('posts and reverses the per-employee annual leave provision delta', async () => {
    const token = await register('leave-provision');
    const company = (h.ok(await h.get(token, 'companies'), 200, 'leave provision company') as { id: string }[])[0]!;
    const branch = (h.ok(await get(token, 'branches', company.id), 200, 'leave provision branch') as { id: string }[])[0]!;
    const costCentre = await post<{ id: string }>(token, 'cost-centers', {
      code: `LP-${RUN}`, nameAr: 'Leave provision',
    }, 'leave provision cost centre', company.id);
    const chart = h.ok(await get(token, 'accounts', company.id), 200, 'leave provision chart') as { id: string; code: string }[];
    const accountCodes = new Set(chart.map((account) => account.code));
    expect(accountCodes.has('2109')).toBe(true);
    expect(accountCodes.has('5207')).toBe(true);
    for (const year of [2026, 2027]) {
      h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
        code: String(year), startDate: `${year}-01-01`, endDate: `${year}-12-31`,
      }), 201, `create leave provision FY ${year}`);
    }
    const employee = await post<{ id: string }>(token, 'payroll/employees', {
      code: `LV5-${RUN}`, nameAr: 'LV5', hireDate: '2026-07-01', payMethod: 'CASH',
      branchId: branch.id, costCenterId: costCentre.id,
    }, 'LV5 employee', company.id);
    await post(token, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2026-01-01', basicSalary: '600.000',
    }, 'LV5 salary', company.id);
    const elements = h.ok(await get(token, 'payroll/elements', company.id), 200, 'leave provision elements') as Array<{
      id: string; code: string; kind: string; isFixedAllowance: boolean;
    }>;
    const transport = elements.find((element) => element.code === 'TRANSPORT' && element.kind === 'EARNING' && element.isFixedAllowance)!;
    await post(token, `payroll/employees/${employee.id}/recurring-elements`, {
      payElementId: transport.id, amount: '40.000', validFrom: '2026-07-01',
    }, 'LV5 fixed transport', company.id);
    const postRun = async (period: string) => {
      const draft = h.ok(await act(token, 'payroll/runs', { period }, company.id), 201, `${period} provision run`) as { id: string };
      await post(token, `payroll/runs/${draft.id}/post`, {}, `post ${period} provision run`, company.id);
      const posted = h.ok(await get(token, `payroll/runs/${draft.id}`, company.id), 200, `${period} posted provision detail`) as {
        id: string; leaveProvisionEntryId: string | null; lines: Array<{ employeeId: string; leaveProvision: string }>;
      };
      return { ...posted, line: posted.lines.find((row) => row.employeeId === employee.id)! };
    };
    const december = await postRun('2026-12');
    expect(december.line.leaveProvision).toBe('150.613');
    const january = await postRun('2027-01');
    expect(january.line.leaveProvision).toBe('176');
    const [companyRow] = await boot.db.query('SELECT tenant_id FROM companies WHERE id = ?', [BigInt(company.id)]) as Array<{ tenant_id: bigint }>;
    const rows = await boot.db.query(
      `SELECT a.code, CAST(SUM(l.debit) AS CHAR) AS debit, CAST(SUM(l.credit) AS CHAR) AS credit
         FROM companies c
         JOIN journal_entries j ON j.tenant_id = c.tenant_id AND j.company_id = c.id
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE c.tenant_id = ? AND c.id = ? AND j.source_type = 'PAYROLL_LEAVE_PROVISION'
        GROUP BY a.code`,
      [companyRow!.tenant_id, BigInt(company.id)],
    ) as Array<{ code: string; debit: string; credit: string }>;
    expect(new Decimal(rows.find((row) => row.code === '5207')?.debit ?? 0).toString()).toBe('176');
    expect(new Decimal(rows.find((row) => row.code === '2109')?.credit ?? 0).toString()).toBe('176');

    h.ok(await act(token, `payroll/runs/${january.id}/reverse`, { date: '2027-02-01' }, company.id), 201, 'reverse January leave provision run');
    const afterReverse = await boot.db.query(
      `SELECT a.code, CAST(SUM(l.debit - l.credit) AS CHAR) AS net
         FROM companies c
         JOIN journal_entries j ON j.tenant_id = c.tenant_id AND j.company_id = c.id
         JOIN journal_lines l ON l.tenant_id = j.tenant_id AND l.journal_entry_id = j.id
         JOIN accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id
        WHERE c.tenant_id = ? AND c.id = ? AND a.code IN ('5207', '2109')
        GROUP BY a.code`,
      [companyRow!.tenant_id, BigInt(company.id)],
    ) as Array<{ code: string; net: string }>;
    expect(new Decimal(afterReverse.find((row) => row.code === '5207')?.net ?? 0).toString()).toBe('150.613');
    expect(new Decimal(afterReverse.find((row) => row.code === '2109')?.net ?? 0).toString()).toBe('-150.613');
    expect(await get(token, 'reports/trial-balance?from=2026-01-01&to=2027-12-31', company.id)).toMatchObject({ status: 200, body: { balanced: true } });
  });

  it('clips annual leave taken at the provision period end', async () => {
    const token = tokenA;
    const company = h.ok(
      await h.api().post('/api/v1/companies').set(h.auth(token)).send({ legalNameAr: `Clipped provision ${RUN}` }),
      201,
      'create clipped provision company',
    ) as { id: string };
    const branch = (h.ok(await get(token, 'branches', company.id), 200, 'clipped provision branch') as { id: string }[])[0]!;
    const costCentre = await post<{ id: string }>(token, 'cost-centers', {
      code: `LPC-${RUN}`, nameAr: 'Clipped leave provision',
    }, 'clipped provision cost centre', company.id);
    h.ok(await h.api().post('/api/v1/fiscal-years').set(h.auth(token)).set('X-Company-Id', company.id).send({
      code: '2026', startDate: '2026-01-01', endDate: '2026-12-31',
    }), 201, 'create clipped provision fiscal year');
    const employee = await post<{ id: string }>(token, 'payroll/employees', {
      code: `LV5-CLIP-${RUN}`, nameAr: 'LV5 clip', hireDate: '2026-01-01', payMethod: 'CASH',
      branchId: branch.id, costCenterId: costCentre.id,
    }, 'clipped provision employee', company.id);
    await post(token, `payroll/employees/${employee.id}/salaries`, {
      effectiveFrom: '2026-01-01', basicSalary: '600.000',
    }, 'clipped provision salary', company.id);
    const annualType = (h.ok(await get(token, 'payroll/leave-types', company.id), 200, 'clipped annual type') as Array<{
      id: string; code: string;
    }>).find((type) => type.code === 'ANNUAL')!;
    for (const [startDate, endDate] of [['2026-11-30', '2026-12-02'], ['2026-12-28', '2026-12-31']]) {
      const request = await post<{ id: string }>(token, 'payroll/leave-requests', {
        employeeId: employee.id, leaveTypeId: annualType.id, startDate, endDate, hospitalised: false,
      }, 'create clipped annual request', company.id);
      h.ok(await act(token, `payroll/leave-requests/${request.id}/approve`, {}, company.id), 200, 'approve clipped annual request');
    }
    const postAndReadProvision = async (period: string) => {
      const draft = h.ok(await act(token, 'payroll/runs', { period }, company.id), 201, `${period} clipped run`) as { id: string };
      await post(token, `payroll/runs/${draft.id}/post`, {}, `post ${period} clipped run`, company.id);
      const posted = h.ok(await get(token, `payroll/runs/${draft.id}`, company.id), 200, `${period} clipped detail`) as {
        lines: Array<{ employeeId: string; leaveProvision: string }>;
      };
      return posted.lines.find((line) => line.employeeId === employee.id)!.leaveProvision;
    };
    expect(await postAndReadProvision('2026-11')).toBe('236.2');
    expect(await postAndReadProvision('2026-12')).toBe('140');
  });
});
