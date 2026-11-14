import { Decimal } from '../../common/decimal/decimal.utils.js';
import { DomainError } from '../../common/errors/domain.error.js';
import { ErrorCode } from '../../common/errors/error-codes.js';
import type { CursorState } from '../../common/paging/cursor.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Keyset reading of account and party statements (ADR-022 §4, LEDGER-19).
 * Statement order is (entry date, entry id, line number), unique because
 * (journal_entry_id, line_no) is. A cursor carries the last line's key and
 * the running balance after it, so the next page continues the balance
 * exactly where the previous one stopped.
 */

/** A statement line's place in statement order. */
export interface LineKey {
  date: Date;
  entryId: bigint;
  lineNo: number;
}

/** One page of a statement read. */
export interface StatementPageQuery {
  limit: number;
  cursor?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^\d{1,19}$/;
const LINE_NO = /^\d{1,9}$/;
const AMOUNT = /^-?\d{1,15}\.\d{3}$/;

/**
 * Statement order: entry date, entry id, line number — on the line's own
 * columns (entry_date is a copy of the entry's), so the page is read in
 * journal_lines_account_seek_idx / journal_lines_party_seek_idx order.
 */
export const LINE_ORDER: Prisma.JournalLineOrderByWithRelationInput[] = [
  { entryDate: 'asc' },
  { journalEntryId: 'asc' },
  { lineNo: 'asc' },
];

/** The position and running balance a (signature-checked) cursor carries; CURSOR_INVALID if malformed. */
export function lineCursor(state: CursorState): { key: LineKey; balance: Decimal } {
  const [day, entryId, lineNo] = state.keys;
  const balance = state.carry.balance;
  if (
    state.keys.length !== 3 ||
    !DAY.test(day) ||
    !ID.test(entryId) ||
    !LINE_NO.test(lineNo) ||
    typeof balance !== 'string' ||
    !AMOUNT.test(balance)
  ) {
    throw new DomainError(ErrorCode.CURSOR_INVALID, 'The cursor is not valid for this request; reload from the start', {
      reason: 'keys',
    });
  }
  return {
    key: { date: new Date(day), entryId: BigInt(entryId), lineNo: Number(lineNo) },
    balance: new Decimal(balance),
  };
}

/** Lines after `k` in statement order (a seek on the statement indexes). */
export function afterLine(k: LineKey): Prisma.JournalLineWhereInput {
  return {
    OR: [
      { entryDate: { gt: k.date } },
      { entryDate: k.date, journalEntryId: { gt: k.entryId } },
      { entryDate: k.date, journalEntryId: k.entryId, lineNo: { gt: k.lineNo } },
    ],
  };
}

/** Cursor state after `line`, carrying the running balance after it (3 decimals). */
export function lineState(
  line: { lineNo: number; journalEntryId: bigint; entryDate: Date },
  balance: Decimal,
): CursorState {
  return {
    keys: [line.entryDate.toISOString().slice(0, 10), line.journalEntryId.toString(), String(line.lineNo)],
    carry: { balance: balance.toFixed(3) },
  };
}
