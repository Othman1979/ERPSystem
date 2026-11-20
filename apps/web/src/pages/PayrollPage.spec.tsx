import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  buildElementPayload,
  buildEmployeePayload,
  buildInputPayload,
  buildPaymentSourceOptions,
  buildSettingsPayload,
  employeeEditDateValues,
  payrollTabSearchParams,
  runAvailability,
} from './PayrollPage';

describe('payroll page payloads and run actions', () => {
  it('updates the URL tab parameter without dropping other query parameters', () => {
    const next = payrollTabSearchParams(new URLSearchParams('new=1'), 'runs');
    expect(`?${next.toString()}`).toBe('?new=1&tab=runs');
  });

  it('defaults employee SSC flags in create payload', () => {
    expect(buildEmployeePayload({
      code: 'E1', nameAr: 'Employee', hireDate: '2026-01-01', payMethod: 'BANK',
    })).toMatchObject({ code: 'E1', sscCovered: true, sscHazardous: false });
  });

  it('omits the active state from pay-element create payloads', () => {
    expect(buildElementPayload({ code: 'E1', nameAr: 'Element', isActive: true }, false))
      .toEqual({ code: 'E1', nameAr: 'Element' });
    expect(buildElementPayload({ code: 'E1', nameAr: 'Element', isActive: false }, true))
      .toEqual({ nameAr: 'Element', isActive: false });
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

  it('sends a daily input with its work date and quantity', () => {
    expect(buildInputPayload({
      employeeId: '1', payElementId: '2', period: '2026-03', workDate: dayjs('2026-03-12'), quantity: '8',
    }, 'PER_HOUR', true)).toEqual({
      employeeId: '1', payElementId: '2', period: '2026-03', workDate: '2026-03-12', quantity: '8',
    });
  });

  it('sends a monthly fixed input without a work date', () => {
    expect(buildInputPayload({
      employeeId: '1', payElementId: '2', period: '2026-03', workDate: '2026-03-12', amount: '25.000',
    }, 'FIXED', false)).toEqual({
      employeeId: '1', payElementId: '2', period: '2026-03', amount: '25.000',
    });
  });

  it('allows tax editing and posting only while the run is draft', () => {
    expect(runAvailability('DRAFT')).toEqual({ taxEditable: true, canPost: true, canPay: false, canReverse: false });
    expect(runAvailability('POSTED')).toEqual({ taxEditable: false, canPost: false, canPay: true, canReverse: true });
  });
});
