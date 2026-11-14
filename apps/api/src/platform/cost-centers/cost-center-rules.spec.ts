import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import {
  assertCanDeactivate,
  assertCanDelete,
  assertCanTakeChild,
  assertPostingCentre,
  isIncomeStatement,
  lineCostCenter,
} from './cost-center-rules.js';

/** The ErrorCode a call throws, or null when it does not throw. */
function codeOf(fn: () => unknown): ErrorCode | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
}

const expense = { code: '5204', accountType: 'EXPENSE', costCenterRequired: false };
const flagged = { code: '5202', accountType: 'EXPENSE', costCenterRequired: true };
const revenue = { code: '4101', accountType: 'REVENUE', costCenterRequired: false };
const cash = { code: '1101', accountType: 'ASSET', costCenterRequired: false };
const on = { enabled: true, header: null, reversal: false };

describe('cost centre rules (ADR-024 §1)', () => {
  it('income statement means REVENUE and EXPENSE', () => {
    expect(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'].filter(isIncomeStatement)).toEqual(['REVENUE', 'EXPENSE']);
  });

  describe('lineCostCenter', () => {
    it("keeps a line's own centre on an income-statement account", () => {
      expect(lineCostCenter(1, expense, 7n, on)).toBe(7n);
      expect(lineCostCenter(1, revenue, 7n, { ...on, header: 9n })).toBe(7n);
    });

    it('copies the header centre onto income-statement lines only', () => {
      expect(lineCostCenter(1, revenue, null, { ...on, header: 9n })).toBe(9n);
      expect(lineCostCenter(1, expense, undefined, { ...on, header: 9n })).toBe(9n);
      expect(lineCostCenter(1, cash, null, { ...on, header: 9n })).toBeNull();
    });

    it('refuses a centre on a balance-sheet line', () => {
      expect(codeOf(() => lineCostCenter(2, cash, 7n, on))).toBe(ErrorCode.COST_CENTER_NOT_ALLOWED);
    });

    it('requires a centre on a flagged account only while centres are enabled', () => {
      expect(codeOf(() => lineCostCenter(1, flagged, null, on))).toBe(ErrorCode.COST_CENTER_REQUIRED);
      expect(lineCostCenter(1, flagged, null, { ...on, enabled: false })).toBeNull();
      expect(lineCostCenter(1, flagged, null, { ...on, header: 3n })).toBe(3n);
      expect(lineCostCenter(1, expense, null, on)).toBeNull();
    });

    it('a reversal carries what the original had, without checks', () => {
      const reversal = { ...on, reversal: true };
      expect(lineCostCenter(1, flagged, null, reversal)).toBeNull();
      expect(lineCostCenter(1, cash, 7n, reversal)).toBe(7n);
    });

    it('reports the line number', () => {
      try {
        lineCostCenter(3, flagged, null, on);
      } catch (err) {
        expect((err as DomainError).details).toEqual({ line: 3 });
      }
    });
  });

  describe('assertPostingCentre', () => {
    const leaf = { id: 5n, code: 'CC1', isActive: true, isPostable: true };
    it('accepts an active leaf', () => {
      expect(codeOf(() => assertPostingCentre(1, 5n, leaf, false))).toBeNull();
    });
    it('refuses a missing, inactive or group centre', () => {
      expect(codeOf(() => assertPostingCentre(1, 5n, undefined, false))).toBe(ErrorCode.NOT_FOUND);
      expect(codeOf(() => assertPostingCentre(1, 5n, { ...leaf, isActive: false }, false))).toBe(ErrorCode.COST_CENTER_INACTIVE);
      expect(codeOf(() => assertPostingCentre(1, 5n, { ...leaf, isPostable: false }, false))).toBe(
        ErrorCode.COST_CENTER_NOT_POSTABLE,
      );
    });
    it('a reversal needs the centre to exist only', () => {
      expect(codeOf(() => assertPostingCentre(1, 5n, { ...leaf, isActive: false, isPostable: false }, true))).toBeNull();
      expect(codeOf(() => assertPostingCentre(1, 5n, undefined, true))).toBe(ErrorCode.NOT_FOUND);
    });
  });

  describe('tree rules', () => {
    it('a parent must be active and unused to take a child', () => {
      expect(codeOf(() => assertCanTakeChild({ code: 'P', isActive: true }, []))).toBeNull();
      expect(codeOf(() => assertCanTakeChild({ code: 'P', isActive: false }, []))).toBe(ErrorCode.COST_CENTER_INACTIVE);
      expect(codeOf(() => assertCanTakeChild({ code: 'P', isActive: true }, ['journal:journal_lines']))).toBe(
        ErrorCode.COST_CENTER_IN_USE,
      );
    });

    it('deletes only an unused leaf', () => {
      expect(codeOf(() => assertCanDelete({ code: 'C' }, 0, []))).toBeNull();
      expect(codeOf(() => assertCanDelete({ code: 'C' }, 1, []))).toBe(ErrorCode.COST_CENTER_HAS_CHILDREN);
      expect(codeOf(() => assertCanDelete({ code: 'C' }, 0, ['sales:sales_invoices']))).toBe(ErrorCode.COST_CENTER_IN_USE);
    });

    it('deactivates a group after its active sub-centres', () => {
      expect(codeOf(() => assertCanDeactivate({ code: 'P' }, 0))).toBeNull();
      expect(codeOf(() => assertCanDeactivate({ code: 'P' }, 2))).toBe(ErrorCode.COST_CENTER_HAS_CHILDREN);
    });
  });
});
