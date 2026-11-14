import { ClsServiceManager } from 'nestjs-cls';
import { Prisma } from '../../generated/prisma/client.js';
import type { RequestContext } from '../cls/cls.types.js';
import { DomainError } from '../errors/domain.error.js';
import { ErrorCode } from '../errors/error-codes.js';
import {
  allowedBranchIdList,
  assertBranchAllowed,
  branchScopeKey,
  branchSql,
  branchWhere,
  hasAllBranches,
} from './branch-context.js';

const cls = ClsServiceManager.getClsService<RequestContext>();
const column = Prisma.raw('i.branch_id');

/** Runs fn with the given CLS store, as the auth and branch guards would leave it. */
const runWithStore = <T>(store: Partial<RequestContext>, fn: () => T): T => cls.runWith(store as RequestContext, fn);

/** Runs fn as a member whose allowed branches are `allowed` (null = all branches). */
const asMember = <T>(allowed: ReadonlySet<bigint> | null, fn: () => T): T =>
  runWithStore({ tenantId: 7n, branchScope: allowed ?? 'ALL' }, fn);

/** Asserts that `fn` throws a DomainError with the given code. */
function refusedWith(fn: () => unknown, code: ErrorCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

describe.each([
  ['scope ALL on a company request', { tenantId: 7n, branchScope: 'ALL' }],
  ['a Cron job in a company context', { tenantId: 7n, jobContext: true }],
  ['no company in context', {}],
] as const)('member with every branch (%s)', (_label, store) => {
  const run = <T>(fn: () => T): T => runWithStore(store, fn);

  it('may use every branch', () => {
    expect(run(() => hasAllBranches())).toBe(true);
    expect(run(() => allowedBranchIdList())).toBeNull();
  });

  it('adds no branch filter to reads', () => {
    expect(run(() => branchWhere())).toEqual({});
  });

  it('adds TRUE to SQL', () => {
    expect(run(() => branchSql(column)).sql).toBe('TRUE');
  });

  it('keys the cursor scope as all', () => {
    expect(run(() => branchScopeKey())).toBe('all');
  });

  it('does not refuse any branch', () => {
    expect(() => run(() => assertBranchAllowed(2n))).not.toThrow();
    expect(() => run(() => assertBranchAllowed(null))).not.toThrow();
  });
});

describe('member with branches 3 and 1', () => {
  const allowed = new Set([3n, 1n]);
  const run = <T>(fn: () => T): T => asMember(allowed, fn);

  it('is not an all-branch member', () => {
    expect(run(() => hasAllBranches())).toBe(false);
  });

  it('lists the allowed branches sorted', () => {
    expect(run(() => allowedBranchIdList())).toEqual([1n, 3n]);
  });

  it('filters reads to the allowed branches plus documents without a branch', () => {
    expect(run(() => branchWhere())).toEqual({
      OR: [{ branchId: { in: [1n, 3n] } }, { branchId: null }],
    });
  });

  it('uses the given key for the branch column', () => {
    expect(run(() => branchWhere('sourceBranchId'))).toEqual({
      OR: [{ sourceBranchId: { in: [1n, 3n] } }, { sourceBranchId: null }],
    });
  });

  it('builds the SQL fragment with one placeholder per branch', () => {
    const sql = run(() => branchSql(column));
    expect(sql.sql).toBe('(i.branch_id IN (?,?) OR i.branch_id IS NULL)');
    expect(sql.values).toEqual([1n, 3n]);
  });

  it('keys the cursor scope by the sorted branch ids', () => {
    expect(run(() => branchScopeKey())).toBe('1,3');
  });
});

describe('member with branch 1 only', () => {
  const run = <T>(fn: () => T): T => asMember(new Set([1n]), fn);

  it('refuses a document on branch 2 with BRANCH_NOT_ALLOWED', () => {
    refusedWith(() => run(() => assertBranchAllowed(2n)), ErrorCode.BRANCH_NOT_ALLOWED);
  });

  it('allows a document on branch 1 and one without a branch', () => {
    expect(() => run(() => assertBranchAllowed(1n))).not.toThrow();
    expect(() => run(() => assertBranchAllowed(null))).not.toThrow();
  });
});

describe('member with no branch', () => {
  const run = <T>(fn: () => T): T => asMember(new Set<bigint>(), fn);

  it('is not an all-branch member and keeps only documents without a branch', () => {
    expect(run(() => hasAllBranches())).toBe(false);
    expect(run(() => branchSql(column)).sql).toBe('i.branch_id IS NULL');
    expect(run(() => branchWhere())).toEqual({
      OR: [{ branchId: { in: [] } }, { branchId: null }],
    });
  });

  it('refuses any document that belongs to a branch', () => {
    refusedWith(() => run(() => assertBranchAllowed(2n)), ErrorCode.BRANCH_NOT_ALLOWED);
  });
});

describe('fail closed (ADR-003 §16)', () => {
  it('a company request without a branch scope is refused with INTERNAL, not read unrestricted', () => {
    const store = { tenantId: 7n, membershipId: 5n };
    const reads: (() => unknown)[] = [hasAllBranches, allowedBranchIdList, () => branchWhere(), () => branchSql(column), branchScopeKey];
    for (const read of reads) {
      refusedWith(() => runWithStore(store, read), ErrorCode.INTERNAL);
    }
    refusedWith(() => runWithStore(store, () => assertBranchAllowed(1n)), ErrorCode.INTERNAL);
  });

  it('a Cron job declares itself and reads every branch', () => {
    runWithStore({ tenantId: 7n, jobContext: true }, () => {
      expect(hasAllBranches()).toBe(true);
      expect(branchWhere()).toEqual({});
    });
  });

  it('outside any CLS context nothing is scoped', () => {
    expect(hasAllBranches()).toBe(true);
  });
});
