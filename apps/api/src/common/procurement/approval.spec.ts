import { Decimal } from '../decimal/decimal.utils.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { assertCanApprove, isAuthor, type ApprovalCheck } from './approval.js';
import { assertProcurementLevel, meetsProcurementLevel } from './procurement-level.js';

const member = (over: Partial<ApprovalCheck> = {}): ApprovalCheck => ({
  isOwner: false,
  canApprove: true,
  limit: null,
  amount: new Decimal('100.000'),
  isAuthor: false,
  ...over,
});

const codeOf = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DomainError);
    return (e as DomainError).code;
  }
};

describe('Approval rule (ADR-025 §2)', () => {
  it('an owner always approves: own document, over any limit, without a grant', () => {
    expect(codeOf(() => assertCanApprove(member({ isOwner: true, canApprove: false, isAuthor: true, limit: new Decimal(1) })))).toBeNull();
  });

  it('a member needs purchase.approve', () => {
    expect(codeOf(() => assertCanApprove(member({ canApprove: false })))).toBe(ErrorCode.FORBIDDEN);
  });

  it('a member never approves a document they created', () => {
    expect(codeOf(() => assertCanApprove(member({ isAuthor: true })))).toBe(ErrorCode.APPROVAL_SELF_NOT_ALLOWED);
    // Even a request without an amount.
    expect(codeOf(() => assertCanApprove(member({ isAuthor: true, amount: null })))).toBe(ErrorCode.APPROVAL_SELF_NOT_ALLOWED);
  });

  it('an author is the creator, the last editor or the submitter (review #47)', () => {
    const doc = { created_by: 1n, updated_by: 2n, submitted_by: 3n };
    expect([1n, 2n, 3n, 4n].map((u) => isAuthor(doc, u))).toEqual([true, true, true, false]);
    expect(isAuthor({ created_by: null, updated_by: null, submitted_by: null }, 1n)).toBe(false);
    expect(isAuthor(doc, null)).toBe(false);
  });

  it('compares the amount with the limit as Decimal: equal passes, one fils over is refused', () => {
    expect(codeOf(() => assertCanApprove(member({ limit: new Decimal('100.000') })))).toBeNull();
    expect(codeOf(() => assertCanApprove(member({ limit: new Decimal('99.999') })))).toBe(ErrorCode.APPROVAL_LIMIT_EXCEEDED);
    // Not a string or float comparison: '1000' < '999' as text, 0.1 + 0.2 as floats.
    expect(codeOf(() => assertCanApprove(member({ amount: new Decimal('1000'), limit: new Decimal('999') })))).toBe(
      ErrorCode.APPROVAL_LIMIT_EXCEEDED,
    );
    expect(codeOf(() => assertCanApprove(member({ amount: new Decimal('0.3'), limit: new Decimal('0.1').plus('0.2') })))).toBeNull();
  });

  it('gives the amount and limit with three decimals on refusal', () => {
    try {
      assertCanApprove(member({ amount: new Decimal('1500.5'), limit: new Decimal('1000') }));
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as DomainError).details).toEqual({ amount: '1500.500', limit: '1000.000' });
      expect((e as DomainError).getStatus()).toBe(403);
    }
  });

  it('no limit means no ceiling; a request (no amount) ignores the limit', () => {
    expect(codeOf(() => assertCanApprove(member({ amount: new Decimal('999999999.999') })))).toBeNull();
    expect(codeOf(() => assertCanApprove(member({ amount: null, limit: new Decimal('1') })))).toBeNull();
  });
});

describe('Procurement level gate (ADR-025 §5)', () => {
  it('orders the levels', () => {
    expect(meetsProcurementLevel('FULL', 'MEDIUM')).toBe(true);
    expect(meetsProcurementLevel('MEDIUM', 'MEDIUM')).toBe(true);
    expect(meetsProcurementLevel('MEDIUM', 'FULL')).toBe(false);
    expect(meetsProcurementLevel('SIMPLE', 'MEDIUM')).toBe(false);
  });

  it('refuses below the minimum with PROCUREMENT_LEVEL_REQUIRED and the levels', () => {
    expect(() => assertProcurementLevel('FULL', 'FULL')).not.toThrow();
    try {
      assertProcurementLevel('MEDIUM', 'FULL');
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as DomainError).code).toBe(ErrorCode.PROCUREMENT_LEVEL_REQUIRED);
      expect((e as DomainError).details).toEqual({ required: 'FULL', current: 'MEDIUM' });
      expect((e as DomainError).getStatus()).toBe(409);
    }
  });
});
