import { round3, toDecimal } from '../format/number';

/** What the grid needs to know about an account (from GET /accounts). */
export interface LineAccount {
  code: string;
  isControl?: boolean;
  controlType?: string | null;
}

export type PartyType = 'CUSTOMER' | 'SUPPLIER';

export interface CheckedLine {
  accountId?: string;
  debit?: string | null;
  credit?: string | null;
  partyId?: string | null;
}

/**
 * A control account (customers / suppliers) needs a party on every line;
 * the API refuses to post it otherwise (PostingService.validateLines).
 */
export const needsParty = (a?: LineAccount | null) => !!a?.isControl;

/** Party type the control account expects; null = any party type. */
export function partyTypeFor(a?: LineAccount | null): PartyType | null {
  if (a?.controlType === 'CUSTOMERS') return 'CUSTOMER';
  if (a?.controlType === 'SUPPLIERS') return 'SUPPLIER';
  return null;
}

export type LineRule = 'ONE_SIDE' | 'PARTY_REQUIRED';

export interface LineProblem {
  /** Row number as shown in the grid (1-based). */
  line: number;
  rule: LineRule;
  accountCode: string;
  partyType: PartyType | null;
}

const positive = (v?: string | null) => {
  const d = toDecimal(v);
  return !!d && round3(d).gt(0);
};

/**
 * First line the API would reject, checked before saving so the user sees
 * which row is wrong instead of a generic "invalid data" at posting time.
 * Rows without an account are skipped (they are not sent).
 */
export function firstLineProblem(
  lines: CheckedLine[],
  accountById: Map<string, LineAccount>,
): LineProblem | null {
  for (const [i, l] of lines.entries()) {
    if (!l.accountId) continue;
    const account = accountById.get(l.accountId);
    const base = { line: i + 1, accountCode: account?.code ?? '', partyType: partyTypeFor(account) };
    if (positive(l.debit) === positive(l.credit)) return { ...base, rule: 'ONE_SIDE' };
    if (needsParty(account) && !l.partyId) return { ...base, rule: 'PARTY_REQUIRED' };
  }
  return null;
}
