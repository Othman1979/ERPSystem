import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';

/**
 * Cost centre rules (ADR-024 §1) as pure functions, so they can be unit tested
 * without a database. CostCentersService and PostingService call them with the
 * rows they read under their locks.
 */

/** Account types a cost centre applies to: the income statement (ADR-024 §1.1). */
export const INCOME_STATEMENT_TYPES: ReadonlySet<string> = new Set(['REVENUE', 'EXPENSE']);

export const isIncomeStatement = (accountType: string): boolean => INCOME_STATEMENT_TYPES.has(accountType);

/** A centre as posting reads it, under its shared lock. */
export interface PostingCentre {
  id: bigint;
  code: string;
  isActive: boolean;
  isPostable: boolean;
}

/** What a journal line needs to know about its account to place a centre. */
export interface LineAccount {
  code: string;
  accountType: string;
  costCenterRequired: boolean;
}

export interface CentreContext {
  /** companies.cost_centers_enabled: the "required" flag applies only when on (§1.3, §1.6). */
  enabled: boolean;
  /** The document's header centre, copied onto every income-statement line (§1.2). */
  header: bigint | null;
  /** A reversal carries the original's centres as they are (§1.10): no checks but existence. */
  reversal: boolean;
}

/**
 * The centre a line posts with, or null: its own, else the document's header
 * centre on an income-statement line. Throws COST_CENTER_NOT_ALLOWED for a centre
 * given on a balance-sheet line and COST_CENTER_REQUIRED for a flagged account's
 * line without one (centres enabled, not a reversal).
 */
export function lineCostCenter(
  lineNo: number,
  account: LineAccount,
  own: bigint | null | undefined,
  ctx: CentreContext,
): bigint | null {
  const income = isIncomeStatement(account.accountType);
  if (own && !income && !ctx.reversal) {
    throw new DomainError(
      ErrorCode.COST_CENTER_NOT_ALLOWED,
      `Line ${lineNo}: account ${account.code} is not an income-statement account; remove the cost centre`,
      { line: lineNo },
    );
  }
  const centre = own ?? (income ? ctx.header : null) ?? null;
  if (!centre && ctx.enabled && account.costCenterRequired && income && !ctx.reversal) {
    throw new DomainError(ErrorCode.COST_CENTER_REQUIRED, `Line ${lineNo}: account ${account.code} requires a cost centre`, {
      line: lineNo,
    });
  }
  return centre;
}

/**
 * A centre a line may post to (§1.4): it exists in the company (NOT_FOUND
 * otherwise), and, outside a reversal, is active and a leaf.
 */
export function assertPostingCentre(
  lineNo: number,
  id: bigint,
  centre: PostingCentre | undefined,
  reversal: boolean,
): void {
  const costCenterId = id.toString();
  if (!centre) {
    throw new DomainError(ErrorCode.NOT_FOUND, `Line ${lineNo}: cost centre ${costCenterId} not found`, {
      line: lineNo,
      costCenterId,
    });
  }
  if (reversal) return;
  if (!centre.isActive) {
    throw new DomainError(ErrorCode.COST_CENTER_INACTIVE, `Cost centre ${centre.code} is inactive`, {
      line: lineNo,
      costCenterId,
    });
  }
  if (!centre.isPostable) {
    throw new DomainError(ErrorCode.COST_CENTER_NOT_POSTABLE, `Cost centre ${centre.code} is a group`, {
      line: lineNo,
      costCenterId,
    });
  }
}

/** A centre that gains a child becomes a group: it must be active and unused (a used leaf stays a leaf). */
export function assertCanTakeChild(parent: { code: string; isActive: boolean }, usage: string[]): void {
  if (!parent.isActive) {
    throw new DomainError(ErrorCode.COST_CENTER_INACTIVE, `Cost centre ${parent.code} is inactive`);
  }
  if (usage.length > 0) {
    throw new DomainError(ErrorCode.COST_CENTER_IN_USE, `Cost centre ${parent.code} is used; it cannot become a group`, {
      reason: 'PARENT_IN_USE',
      usedIn: usage,
    });
  }
}

/** Delete only a leaf no table references (ADR-024 §1.7, ADR-021); deactivate it otherwise. */
export function assertCanDelete(centre: { code: string }, children: number, usage: string[]): void {
  if (children > 0) {
    throw new DomainError(ErrorCode.COST_CENTER_HAS_CHILDREN, `Cost centre ${centre.code} has sub-centres`);
  }
  if (usage.length > 0) {
    throw new DomainError(ErrorCode.COST_CENTER_IN_USE, `Cost centre ${centre.code} is used; deactivate it instead`, {
      usedIn: usage,
    });
  }
}

/** A group is deactivated after its sub-centres, so no active leaf sits under an inactive group. */
export function assertCanDeactivate(centre: { code: string }, activeChildren: number): void {
  if (activeChildren > 0) {
    throw new DomainError(ErrorCode.COST_CENTER_HAS_CHILDREN, `Cost centre ${centre.code} has active sub-centres`);
  }
}
