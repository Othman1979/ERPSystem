import dayjs from 'dayjs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import {
  buildElementPayload,
  buildEmployeePayload,
  buildMovementPayload,
  buildPaymentSourceOptions,
  buildSettingsPayload,
  employeeEditDateValues,
  formatPayrollDate,
  monthToPayrollPeriod,
  PayrollPage,
  PayrollMonthPicker,
  payElementAccountSelectable,
  payrollTabSearchParams,
  runAvailability,
} from './PayrollPage';

const api = vi.hoisted(() => ({
  addSalary: vi.fn(),
  createEmployee: vi.fn(),
  createRun: vi.fn(),
  getRun: vi.fn(),
  listBankAccounts: vi.fn(),
  listCashBoxes: vi.fn(),
  listElements: vi.fn(),
  listEmployees: vi.fn(),
  listRuns: vi.fn(),
  payRun: vi.fn(),
  postRun: vi.fn(),
  reverseRun: vi.fn(),
  setIncomeTax: vi.fn(),
  clearIncomeTax: vi.fn(),
  updateEmployee: vi.fn(),
  costCenters: vi.fn(),
  listLeaveTypes: vi.fn(),
  listLeaveRequests: vi.fn(),
  listLeaveHolidays: vi.fn(),
  listLeaveBalances: vi.fn(),
  listLeaveAdjustments: vi.fn(),
  createLeaveRequest: vi.fn(),
  createLeaveType: vi.fn(),
  updateLeaveType: vi.fn(),
  createLeaveHoliday: vi.fn(),
  deleteLeaveHoliday: vi.fn(),
  createLeaveAdjustment: vi.fn(),
  approveLeave: vi.fn(),
  rejectLeave: vi.fn(),
  cancelLeave: vi.fn(),
}));
const auth = vi.hoisted(() => ({ can: vi.fn((_permission: string) => true) }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, me: { currentMembership: { branches: [] } } }),
}));

vi.mock('@erp/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@erp/api-client')>();
  return {
    ...actual,
    payrollControllerAddSalary: (...args: unknown[]) => api.addSalary(...args),
    payrollControllerCreateEmployee: (...args: unknown[]) => api.createEmployee(...args),
    payrollControllerCreateRun: (...args: unknown[]) => api.createRun(...args),
    payrollControllerGetRun: (...args: unknown[]) => api.getRun(...args),
    payrollControllerListEmployees: (...args: unknown[]) => api.listEmployees(...args),
    payrollControllerListElements: (...args: unknown[]) => api.listElements(...args),
    payrollControllerListRuns: (...args: unknown[]) => api.listRuns(...args),
    payrollControllerPayRun: (...args: unknown[]) => api.payRun(...args),
    payrollControllerPostRun: (...args: unknown[]) => api.postRun(...args),
    payrollControllerReverseRun: (...args: unknown[]) => api.reverseRun(...args),
    payrollControllerSetIncomeTax: (...args: unknown[]) => api.setIncomeTax(...args),
    payrollControllerClearIncomeTax: (...args: unknown[]) => api.clearIncomeTax(...args),
    payrollControllerUpdateEmployee: (...args: unknown[]) => api.updateEmployee(...args),
    treasuryControllerListBankAccounts: (...args: unknown[]) => api.listBankAccounts(...args),
    treasuryControllerListCashBoxes: (...args: unknown[]) => api.listCashBoxes(...args),
    costCentersControllerList: (...args: unknown[]) => api.costCenters(...args),
    leaveControllerListTypes: (...args: unknown[]) => api.listLeaveTypes(...args),
    leaveControllerListRequests: (...args: unknown[]) => api.listLeaveRequests(...args),
    leaveControllerListHolidays: (...args: unknown[]) => api.listLeaveHolidays(...args),
    leaveControllerBalances: (...args: unknown[]) => api.listLeaveBalances(...args),
    leaveControllerAdjustments: (...args: unknown[]) => api.listLeaveAdjustments(...args),
    leaveControllerCreateRequest: (...args: unknown[]) => api.createLeaveRequest(...args),
    leaveControllerCreateType: (...args: unknown[]) => api.createLeaveType(...args),
    leaveControllerUpdateType: (...args: unknown[]) => api.updateLeaveType(...args),
    leaveControllerCreateHoliday: (...args: unknown[]) => api.createLeaveHoliday(...args),
    leaveControllerDeleteHoliday: (...args: unknown[]) => api.deleteLeaveHoliday(...args),
    leaveControllerCreateAdjustment: (...args: unknown[]) => api.createLeaveAdjustment(...args),
    leaveControllerApprove: (...args: unknown[]) => api.approveLeave(...args),
    leaveControllerReject: (...args: unknown[]) => api.rejectLeave(...args),
    leaveControllerCancel: (...args: unknown[]) => api.cancelLeave(...args),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }) as MediaQueryList;

const response = <T,>(data: T) => ({ data, status: 200, headers: new Headers() });
const employee = {
  id: 'employee-1',
  code: 'EMP-1',
  nameAr: 'Test employee',
  nameEn: null,
  hireDate: '2026-01-01',
  leaveDate: null,
  payMethod: 'CASH',
  sscCovered: true,
  sscHazardous: false,
  taxSubject: true,
  taxDependants: false,
  taxOtherExemption: '0.000',
  isActive: true,
};
const run = {
  id: 'run-1',
  period: '2026-11',
  runDate: '2026-11-30',
  status: 'DRAFT',
  runNo: null,
  basicTotal: '100.000',
  grossTotal: '100.000',
  sscBaseTotal: '100.000',
  sscEmployeeTotal: '0.000',
  sscEmployerTotal: '0.000',
  incomeTaxTotal: '0.000',
  deductionsTotal: '0.000',
  netTotal: '100.000',
  lines: [{
    id: 'line-1',
    employeeId: employee.id,
    employeeName: employee.nameAr,
    basic: '100.000',
    earnings: '0.000',
    gross: '100.000',
    sscBase: '100.000',
    sscEmployee: '0.000',
    sscEmployer: '0.000',
    taxableIncome: '100.000',
    incomeTax: '0.000',
    nationalContribution: '0.000',
    taxManual: false,
    deductions: '0.000',
    net: '100.000',
  }],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

const settle = async (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

async function until(check: () => void) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      check();
      return;
    } catch {
      await settle(10);
    }
  }
  check();
}

async function mount(path: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <AntApp>
          <MemoryRouter initialEntries={[path]}>
            <PayrollPage />
          </MemoryRouter>
        </AntApp>
      </QueryClientProvider>,
    );
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.resetAllMocks();
  auth.can.mockReturnValue(true);
  await i18n.changeLanguage('en');
  api.listRuns.mockResolvedValue(response([]));
  api.createRun.mockResolvedValue(response(run));
  api.getRun.mockResolvedValue(response(run));
  api.setIncomeTax.mockResolvedValue(response({}));
  api.payRun.mockResolvedValue(response({}));
  api.postRun.mockResolvedValue(response({}));
  api.reverseRun.mockResolvedValue(response({}));
  api.listBankAccounts.mockResolvedValue(response([]));
  api.listCashBoxes.mockResolvedValue(response([]));
  api.listEmployees.mockResolvedValue(response([]));
  api.listElements.mockResolvedValue(response([]));
  api.costCenters.mockResolvedValue(response([]));
  api.createEmployee.mockResolvedValue(response(employee));
  api.addSalary.mockResolvedValue(response({}));
  api.updateEmployee.mockResolvedValue(response(employee));
  api.listLeaveTypes.mockResolvedValue(response([]));
  api.listLeaveRequests.mockResolvedValue(response([]));
  api.listLeaveHolidays.mockResolvedValue(response([]));
  api.listLeaveBalances.mockResolvedValue(response([]));
  api.listLeaveAdjustments.mockResolvedValue(response([]));
  api.createLeaveRequest.mockResolvedValue(response({}));
  api.createLeaveType.mockResolvedValue(response({}));
  api.updateLeaveType.mockResolvedValue(response({}));
  api.createLeaveHoliday.mockResolvedValue(response({}));
  api.deleteLeaveHoliday.mockResolvedValue(response({}));
  api.createLeaveAdjustment.mockResolvedValue(response({}));
  api.approveLeave.mockResolvedValue(response({}));
  api.rejectLeave.mockResolvedValue(response({}));
  api.cancelLeave.mockResolvedValue(response({}));
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  document.body.innerHTML = '';
});

describe('payroll page payloads and run actions', () => {
  it('shows leave requests and gates approval actions by permission', async () => {
    api.listLeaveTypes.mockResolvedValue(response([{
      id: 'leave-type-1', code: 'ANNUAL', nameAr: 'سنوية', nameEn: 'Annual', category: 'ANNUAL',
      countBasis: 'WORKING_DAYS', isActive: true,
    }]));
    api.listLeaveRequests.mockResolvedValue(response([{
      id: 'leave-request-1', employeeId: employee.id, employeeName: employee.nameAr, employeeNameEn: 'Test employee',
      leaveTypeId: 'leave-type-1', leaveTypeCode: 'ANNUAL', leaveTypeNameAr: 'سنوية', leaveTypeNameEn: 'Annual',
      startDate: '2026-03-02', endDate: '2026-03-03', days: '2.00', calendarDays: 2, hospitalised: false,
      status: 'SUBMITTED',
    }]));
    auth.can.mockImplementation((permission: string) => permission !== 'payroll.leave.approve');
    await mount('/payroll?tab=leave');
    await until(() => {
      expect(host?.textContent).toContain('Test employee');
      expect(host?.textContent).toContain('Annual');
    });
    expect(host?.textContent).not.toContain('Approve');
  });

  it('offers only active fixed earning elements for recurring allowances', async () => {
    api.listElements.mockResolvedValue(response([
      { id: 'fixed-earning', nameAr: 'بدل النقل', nameEn: 'Transport allowance', kind: 'EARNING', amountType: 'FIXED', isFixedAllowance: true, isActive: true },
      { id: 'bonus', nameAr: 'مكافأة', nameEn: 'Bonus', kind: 'EARNING', amountType: 'FIXED', isFixedAllowance: false, isActive: true },
      { id: 'fixed-deduction', nameAr: 'سداد سلفة', nameEn: 'Advance repayment', kind: 'DEDUCTION', amountType: 'FIXED', isFixedAllowance: false, isActive: true },
      { id: 'hourly-earning', nameAr: 'عمل إضافي', nameEn: 'Overtime', kind: 'EARNING', amountType: 'PER_HOUR', isFixedAllowance: false, isActive: true },
      { id: 'inactive-earning', nameAr: 'بدل غير نشط', nameEn: 'Inactive allowance', kind: 'EARNING', amountType: 'FIXED', isFixedAllowance: true, isActive: false },
    ]));
    await mount('/payroll?tab=employees');
    await until(() => expect(
      [...(host?.querySelectorAll('button') ?? [])].some((button) => button.textContent?.includes(i18n.t('payroll.addEmployee'))),
    ).toBe(true));
    const addEmployee = [...host!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(i18n.t('payroll.addEmployee')))!;
    act(() => addEmployee.click());
    await until(() => expect(document.querySelector('.ant-modal')).not.toBeNull());
    const modal = document.querySelector<HTMLElement>('.ant-modal')!;
    const elementLabel = [...modal.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.includes(i18n.t('payroll.element')));
    const elementSelect = elementLabel?.closest('.ant-form-item')?.querySelector<HTMLElement>('.ant-select-selector');
    if (!elementSelect) throw new Error('Missing recurring pay element selector');
    act(() => elementSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await until(() => expect(
      [...document.querySelectorAll('.ant-select-item-option')].some((option) => option.textContent?.includes('Transport allowance')),
    ).toBe(true));
    const options = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
      .map((option) => option.textContent?.trim());
    expect(options).toContain('Transport allowance');
    expect(options).not.toContain('Bonus');
    expect(options).not.toContain('Advance repayment');
    expect(options).not.toContain('Overtime');
    expect(options).not.toContain('Inactive allowance');
  });

  it('waits for a pending income-tax save before posting a run', async () => {
    const taxSave = deferred<ReturnType<typeof response<{ id: string }>>>();
    api.setIncomeTax.mockReturnValue(taxSave.promise);
    await mount('/payroll?tab=runs&new=1');
    await until(() => expect(host?.querySelector('.ant-table .ant-input')).not.toBeNull());

    const taxInput = host!.querySelector<HTMLInputElement>('.ant-table .ant-input')!;
    setInputValue(taxInput, '12.500');
    act(() => {
      taxInput.focus();
      taxInput.blur();
    });
    expect(api.setIncomeTax).toHaveBeenCalledWith(run.id, run.lines[0]!.id, { incomeTax: '12.500' });

    const postButton = [...host!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(i18n.t('payroll.post')))!;
    act(() => postButton.click());
    await settle();
    expect(api.postRun).not.toHaveBeenCalled();

    await act(async () => {
      taxSave.resolve(response({ id: run.id }));
      await taxSave.promise;
    });
    await until(() => expect(api.postRun).toHaveBeenCalledTimes(1));
  });

  it('does not set manual tax on an unchanged blur, but saves a changed amount', async () => {
    await mount('/payroll?tab=runs&new=1');
    await until(() => expect(host?.querySelector('.ant-table .ant-input')).not.toBeNull());

    const taxInput = host!.querySelector<HTMLInputElement>('.ant-table .ant-input')!;
    act(() => {
      taxInput.focus();
      taxInput.blur();
    });
    expect(api.setIncomeTax).not.toHaveBeenCalled();

    setInputValue(taxInput, '12.500');
    act(() => {
      taxInput.focus();
      taxInput.blur();
    });
    await until(() => expect(api.setIncomeTax).toHaveBeenCalledTimes(1));
    expect(api.setIncomeTax).toHaveBeenCalledWith(run.id, run.lines[0]!.id, { incomeTax: '12.500' });
  });

  it('resets a manual tax override from the run line', async () => {
    const manualRun = {
      ...run,
      lines: [{ ...run.lines[0]!, incomeTax: '4000.000', taxManual: true }],
    };
    api.getRun.mockResolvedValue(response(manualRun));
    api.clearIncomeTax.mockResolvedValue(response({ id: 'line-2', incomeTax: '0.000', net: '100.000', taxManual: false }));
    await mount('/payroll?tab=runs&new=1');
    const resetTitle = i18n.t('payroll.resetTax');
    await until(() => expect(host?.querySelector(`button[title="${resetTitle}"]`)).not.toBeNull());
    const reset = host!.querySelector<HTMLButtonElement>(`button[title="${resetTitle}"]`)!;
    act(() => reset.click());
    await until(() => expect(api.clearIncomeTax).toHaveBeenCalledWith(run.id, run.lines[0]!.id));
  });

  it('defaults the payment and reversal date to the run date and sends the selected date', async () => {
    const postedRun = { ...run, runDate: '2100-12-31', status: 'POSTED' };
    api.createRun.mockResolvedValue(response({ id: postedRun.id }));
    api.getRun.mockResolvedValue(response(postedRun));
    api.listCashBoxes.mockResolvedValue(response([{ id: 'cash-1', name: 'Main cash box' }]));
    await mount('/payroll?tab=runs&new=1');

    await until(() => expect(api.getRun).toHaveBeenCalledWith(postedRun.id));
    let actionDateInput: HTMLInputElement | undefined;
    await until(() => {
      actionDateInput = [...host!.querySelectorAll<HTMLInputElement>('.ant-picker-input input')]
        .find((input) => input.value === '31/12/2100');
      expect(actionDateInput).toBeDefined();
    });

    act(() => actionDateInput!.click());
    await until(() => expect(document.querySelector('.ant-picker-dropdown')).not.toBeNull());
    const datePicker = document.querySelector<HTMLElement>('.ant-picker-dropdown')!;
    const nextMonth = datePicker.querySelector<HTMLElement>('.ant-picker-header-next-btn');
    if (!nextMonth) throw new Error('Missing next-month control');
    act(() => nextMonth.click());
    await settle();
    const nextDate = document.querySelector<HTMLElement>('.ant-picker-cell[title="2101-01-01"] .ant-picker-cell-inner');
    if (!nextDate) throw new Error('Missing January 1, 2101 in date picker');
    act(() => nextDate.click());
    await settle();
    expect(actionDateInput!.value).toBe('01/01/2101');

    const paymentAccount = [...host!.querySelectorAll<HTMLElement>('.ant-select')]
      .find((select) => select.textContent?.includes(i18n.t('payroll.paymentAccount')));
    const paymentAccountSelector = paymentAccount?.querySelector<HTMLElement>('.ant-select-selector');
    if (!paymentAccountSelector) throw new Error('Missing payment account selector');
    act(() => paymentAccountSelector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await until(() => expect(
      [...document.querySelectorAll('.ant-select-item-option')].some((option) => option.textContent?.includes('Main cash box')),
    ).toBe(true));
    const cashOption = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
      .find((option) => option.textContent?.includes('Main cash box'))!;
    act(() => cashOption.click());
    await settle();

    const payButton = [...host!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(i18n.t('payroll.pay')))!;
    act(() => payButton.click());
    await until(() => expect(api.payRun).toHaveBeenCalledTimes(1));
    expect(api.payRun.mock.calls[0]?.[1]).toEqual({ date: '2101-01-01', cashBoxId: 'cash-1' });

    const reverseButton = [...host!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(i18n.t('payroll.reverse')))!;
    act(() => reverseButton.click());
    await until(() => expect(api.reverseRun).toHaveBeenCalledTimes(1));
    expect(api.reverseRun.mock.calls[0]?.[1]).toEqual({ date: '2101-01-01' });
  });

  it('retries a partial employee save as an update', async () => {
    const createdEmployee = { ...employee, code: 'EMP-RETRY' };
    api.createEmployee.mockResolvedValue(response(createdEmployee));
    api.listEmployees.mockResolvedValue(response([createdEmployee]));
    api.addSalary.mockRejectedValueOnce(new Error('salary save failed'));
    await mount('/payroll?tab=employees');
    await until(() => expect(
      [...(host?.querySelectorAll('button') ?? [])].some((button) => button.textContent?.includes(i18n.t('payroll.addEmployee'))),
    ).toBe(true));
    const addEmployee = [...host!.querySelectorAll('button')]
      .find((button) => button.textContent?.includes(i18n.t('payroll.addEmployee')))!;
    act(() => addEmployee.click());
    await until(() => expect(document.querySelector('.ant-modal')).not.toBeNull());
    const modal = document.querySelector<HTMLElement>('.ant-modal')!;
    const inputFor = (labelKey: string) => {
      const label = [...modal.querySelectorAll('label')].find((candidate) => candidate.textContent?.includes(i18n.t(labelKey)));
      const input = label?.closest('.ant-form-item')?.querySelector<HTMLInputElement>('input');
      if (!input) throw new Error(`Missing input for ${labelKey}`);
      return input;
    };
    setInputValue(inputFor('payroll.code'), 'EMP-RETRY');
    setInputValue(inputFor('payroll.nameAr'), 'Retry employee');
    const hireDate = inputFor('payroll.hireDate');
    const selectToday = async (input: HTMLInputElement) => {
      act(() => input.click());
      await until(() => expect(document.querySelectorAll('.ant-picker-dropdown').length).toBeGreaterThan(0));
      const dropdown = [...document.querySelectorAll('.ant-picker-dropdown')].at(-1);
      const today = dropdown?.querySelector<HTMLElement>('.ant-picker-cell-today .ant-picker-cell-inner');
      if (!today) throw new Error('Missing current date in date picker');
      act(() => today.click());
      await settle();
    };
    await selectToday(hireDate);
    const salaryEffectiveFrom = inputFor('payroll.effectiveFrom');
    await selectToday(salaryEffectiveFrom);
    setInputValue(inputFor('payroll.basicSalary'), '100.000');

    const payMethodLabel = [...modal.querySelectorAll('label')]
      .find((candidate) => candidate.textContent?.includes(i18n.t('payroll.payMethod')));
    const payMethodSelect = payMethodLabel?.closest('.ant-form-item')?.querySelector<HTMLElement>('.ant-select-selector');
    if (!payMethodSelect) throw new Error('Missing pay method selector');
    act(() => payMethodSelect.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await until(() => expect(
      [...document.querySelectorAll('.ant-select-item-option')].some((option) => option.textContent?.includes(i18n.t('payroll.cash'))),
    ).toBe(true));
    const cashOption = [...document.querySelectorAll<HTMLElement>('.ant-select-item-option')]
      .find((option) => option.textContent?.includes(i18n.t('payroll.cash')))!;
    act(() => cashOption.click());
    await settle();
    expect(inputFor('payroll.code').value).toBe('EMP-RETRY');
    expect(inputFor('payroll.nameAr').value).toBe('Retry employee');
    expect(hireDate.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(salaryEffectiveFrom.value).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(payMethodSelect.querySelector('.ant-select-selection-item')?.textContent).toBe(i18n.t('payroll.cash'));

    const activeModal = () => [...document.querySelectorAll<HTMLElement>('.ant-modal')]
      .find((candidate) => candidate.querySelector('.ant-modal-title')?.textContent?.includes(i18n.t('payroll.editEmployee')))!;
    const saveButton = (dialog: HTMLElement) => dialog.querySelector<HTMLButtonElement>('.form-dialog-footer button')!;
    const save = () => {
      act(() => saveButton(modal).click());
    };
    save();
    await settle();
    const validationErrors = [...modal.querySelectorAll('.ant-form-item-explain-error')]
      .map((error) => error.textContent).filter(Boolean).join(', ');
    expect(api.createEmployee.mock.calls.length, validationErrors).toBe(1);
    await until(() => expect(api.addSalary).toHaveBeenCalledTimes(1));
    expect(api.createEmployee).toHaveBeenCalledTimes(1);
    expect(api.listEmployees).toHaveBeenCalledTimes(2);
    await until(() => expect(
      document.querySelector('.ant-modal-title')?.textContent,
    ).toContain(i18n.t('payroll.editEmployee')));
    await until(() => expect(document.body.textContent).toContain(i18n.t('payroll.saveError')));

    const editModal = activeModal();
    await until(() => expect(saveButton(editModal).classList.contains('ant-btn-loading')).toBe(false));
    act(() => saveButton(editModal).click());
    await settle();
    const retryErrors = [...modal.querySelectorAll('.ant-form-item-explain-error')]
      .map((error) => error.textContent).filter(Boolean).join(', ');
    expect(api.updateEmployee.mock.calls.length, `create calls: ${api.createEmployee.mock.calls.length}; ${retryErrors}`).toBe(1);
    expect(api.createEmployee).toHaveBeenCalledTimes(1);
    expect(api.updateEmployee).toHaveBeenCalledWith(createdEmployee.id, expect.objectContaining({ code: 'EMP-RETRY' }));
  });

  it('updates the URL tab parameter without dropping other query parameters', () => {
    const next = payrollTabSearchParams(new URLSearchParams('new=1'), 'runs');
    expect(`?${next.toString()}`).toBe('?new=1&tab=runs');
  });

  it('formats a selected payroll month as YYYY-MM for the API', () => {
    expect(monthToPayrollPeriod(dayjs('2026-11-01'))).toBe('2026-11');
  });

  it('shows movement table dates as DD/MM/YYYY', () => {
    expect(formatPayrollDate('2026-11-10')).toBe('10/11/2026');
  });

  it('does not expose a clear control or clear the selected API period', () => {
    const onChange = vi.fn();
    const picker = PayrollMonthPicker({ period: '2026-11', onChange });

    expect(picker.props.allowClear).toBe(false);
    expect(picker.props.value.format('YYYY-MM')).toBe('2026-11');
    picker.props.onChange?.(null, '');
    expect(onChange).not.toHaveBeenCalled();
    expect(picker.props.value.format('YYYY-MM')).toBe('2026-11');
  });

  it('defaults employee SSC flags in create payload', () => {
    expect(buildEmployeePayload({
      code: 'E1', nameAr: 'Employee', hireDate: '2026-01-01', payMethod: 'BANK',
    })).toMatchObject({ code: 'E1', sscCovered: true, sscHazardous: false });
  });

  it('omits the active state and clears fixed-allowance flags when hidden', () => {
    expect(buildElementPayload({
      code: 'E1', nameAr: 'Element', kind: 'EARNING', amountType: 'FIXED', isFixedAllowance: true, isActive: true,
    }, false)).toEqual({
      code: 'E1', nameAr: 'Element', kind: 'EARNING', amountType: 'FIXED', isFixedAllowance: true,
    });
    expect(buildElementPayload({
      code: 'E1', nameAr: 'Element', kind: 'DEDUCTION', amountType: 'FIXED', isFixedAllowance: true, isActive: false,
    }, true)).toEqual({
      nameAr: 'Element', kind: 'DEDUCTION', amountType: 'FIXED', isFixedAllowance: false, isActive: false,
    });
  });

  it('allows all non-control account types for deductions and keeps earnings expense-only', () => {
    const account = (accountType: 'ASSET' | 'LIABILITY' | 'EXPENSE' | 'REVENUE', overrides = {}) => ({
      accountType, isActive: true, isPostable: true, isControl: false, controlType: null, ...overrides,
    });

    for (const type of ['ASSET', 'LIABILITY', 'EXPENSE', 'REVENUE'] as const) {
      expect(payElementAccountSelectable(account(type), 'DEDUCTION')).toBe(true);
    }
    expect(payElementAccountSelectable(account('EXPENSE'), 'EARNING')).toBe(true);
    expect(payElementAccountSelectable(account('REVENUE'), 'EARNING')).toBe(false);
    expect(payElementAccountSelectable(account('LIABILITY', { controlType: 'BANK' }), 'DEDUCTION')).toBe(false);
  });

  it('labels cash boxes by name and bank accounts by bank plus account number or IBAN', () => {
    expect(buildPaymentSourceOptions('cash', [{ id: 'cash-1', name: 'Main cash' }], []))
      .toEqual([{ value: 'cash-1', label: 'Main cash' }]);
    expect(buildPaymentSourceOptions('bank', [], [
      { id: 'bank-1', bankName: 'Arab Bank', accountNoMasked: '****1234', ibanMasked: 'JO****' },
      { id: 'bank-2', bankName: 'Housing Bank', accountNoMasked: null, ibanMasked: 'JO****9876' },
    ])).toEqual([
      { value: 'bank-1', label: 'Arab Bank — ****1234' },
      { value: 'bank-2', label: 'Housing Bank — JO****9876' },
    ]);
  });

  it('loads saved employee edit dates and sends date-only strings', () => {
    const editDates = employeeEditDateValues({
      hireDate: '2026-03-12T00:00:00.000Z',
      leaveDate: '2026-04-05T00:00:00.000Z',
    });
    expect(dayjs.isDayjs(editDates.hireDate)).toBe(true);
    expect(editDates.hireDate?.format('YYYY-MM-DD')).toBe('2026-03-12');
    expect(buildEmployeePayload({
      code: 'E1', nameAr: 'Employee', payMethod: 'BANK', ...editDates,
    })).toMatchObject({ hireDate: '2026-03-12', leaveDate: '2026-04-05' });
    expect(buildSettingsPayload({ effectiveFrom: dayjs('2026-03-12') })).toEqual({ effectiveFrom: '2026-03-12' });
  });

  it('sends null for cleared optional employee fields while editing', () => {
    expect(buildEmployeePayload({
      code: 'E1', nameAr: 'Employee', payMethod: 'BANK', hireDate: dayjs('2026-03-12'),
      nameEn: '', nationalId: null, sscNumber: undefined, leaveDate: null,
      branchId: undefined, costCenterId: null, iban: '',
    }, true)).toMatchObject({
      nameEn: null, nationalId: null, sscNumber: null, leaveDate: null,
      branchId: null, costCenterId: null, iban: null,
    });
  });

  it('sends a variable movement with its date and quantity', () => {
    expect(buildMovementPayload({
      employeeId: '1', payElementId: '2', movementDate: dayjs('2026-03-12'), quantity: '8', description: 'Overtime',
    }, 'PER_HOUR')).toEqual({
      employeeId: '1', payElementId: '2', movementDate: '2026-03-12', quantity: '8', description: 'Overtime',
    });
  });

  it('sends a fixed movement as a date-only request', () => {
    expect(buildMovementPayload({
      employeeId: '1', payElementId: '2', movementDate: '2026-03-12', amount: '25.000', description: 'Bonus',
    }, 'FIXED')).toEqual({
      employeeId: '1', payElementId: '2', movementDate: '2026-03-12', amount: '25.000', description: 'Bonus',
    });
  });

  it('allows tax editing and posting only while the run is draft', () => {
    expect(runAvailability('DRAFT')).toEqual({ taxEditable: true, canPost: true, canPay: false, canReverse: false });
    expect(runAvailability('POSTED')).toEqual({ taxEditable: false, canPost: false, canPay: true, canReverse: true });
  });
});
