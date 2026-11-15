import type { CreateIssueRequestDto, IssueFromRequestDto, IssueLineDto, IssueRequestLineDto, IssueRequestStatus } from '@erp/api-client';
import { PERMISSIONS, type Permission } from '../../auth/permissions';
import { toDecimal } from '../../format/number';

/** Header fields of an issue request as the editor holds them. Dates are yyyy-mm-dd. */
export interface IssueRequestForm {
  requestDate: string;
  /** Empty until the user picks one; the request needs it (see issueRequestGaps). */
  warehouseId?: string | null;
  costCenterId?: string | null;
  expenseAccountId?: string | null;
  notes?: string | null;
}

/** A line as the grid holds it: ids and decimal strings, never JS numbers. */
export interface IssueRequestLineInput {
  itemId?: string | null;
  /** Base-unit quantity, a decimal string. */
  qty?: string | null;
  note?: string | null;
}

/** A request line as the issue dialog holds it: what is left to issue, and what to issue now. */
export interface IssueRowInput {
  issueRequestLineId: string;
  /** The line's remaining quantity from the API (decimal string). */
  remainingQty: string;
  qty?: string | null;
}

/** What the editor still lacks before it can save. */
export type IssueRequestGap = 'warehouse' | 'lines';

/** Trimmed text, or undefined when blank (optional fields are omitted, not sent empty). */
function optionalText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/** Lines a request would send: an item and a positive quantity. Others are left out. */
function completeLines(lines: readonly IssueRequestLineInput[]): IssueRequestLineDto[] {
  return lines.flatMap((line): IssueRequestLineDto[] => {
    const qty = toDecimal(line.qty);
    if (!line.itemId || !qty || !qty.gt(0)) return [];
    const out: IssueRequestLineDto = { itemId: line.itemId, qty: qty.toString() };
    const note = optionalText(line.note);
    if (note) out.note = note;
    return [out];
  });
}

/** What the editor still needs before it can save: a warehouse and at least one complete line. */
export function issueRequestGaps(
  form: Pick<IssueRequestForm, 'warehouseId'>,
  lines: readonly IssueRequestLineInput[],
): IssueRequestGap[] {
  const gaps: IssueRequestGap[] = [];
  if (!form.warehouseId) gaps.push('warehouse');
  if (completeLines(lines).length === 0) gaps.push('lines');
  return gaps;
}

/**
 * Body for POST/PUT of an issue request (CreateIssueRequestDto), or null while the
 * request is incomplete (see issueRequestGaps). Quantities are base units; every
 * value is a string, and nothing computed is sent: the server owns the rest.
 */
export function issueRequestBody(
  form: IssueRequestForm,
  lines: readonly IssueRequestLineInput[],
): CreateIssueRequestDto | null {
  const warehouseId = form.warehouseId;
  const sent = completeLines(lines);
  if (!warehouseId || sent.length === 0) return null;
  const body: CreateIssueRequestDto = { requestDate: form.requestDate, warehouseId, lines: sent };
  const costCenterId = optionalText(form.costCenterId);
  if (costCenterId) body.costCenterId = costCenterId;
  const expenseAccountId = optionalText(form.expenseAccountId);
  if (expenseAccountId) body.expenseAccountId = expenseAccountId;
  const notes = optionalText(form.notes);
  if (notes) body.notes = notes;
  return body;
}

/** Ids of the rows that ask for more than their remaining quantity (or whose remaining quantity is unreadable). */
export function overRemainingLineIds(rows: readonly IssueRowInput[]): string[] {
  return rows
    .filter((row) => {
      const qty = toDecimal(row.qty);
      if (!qty || qty.lte(0)) return false;
      const remaining = toDecimal(row.remainingQty);
      return !remaining || qty.gt(remaining);
    })
    .map((row) => row.issueRequestLineId);
}

/**
 * Body for POST /issue-requests/{id}/issue (IssueFromRequestDto): the rows that issue a
 * positive quantity. Null when no row does, or when a row asks for more than is left
 * (check overRemainingLineIds first, so the screen can say which one).
 */
export function issueFromRequestBody(noteDate: string, rows: readonly IssueRowInput[]): IssueFromRequestDto | null {
  if (overRemainingLineIds(rows).length > 0) return null;
  const lines = rows.flatMap((row): IssueLineDto[] => {
    const qty = toDecimal(row.qty);
    return qty && qty.gt(0) ? [{ issueRequestLineId: row.issueRequestLineId, qty: qty.toString() }] : [];
  });
  if (lines.length === 0) return null;
  return { noteDate, lines };
}

/** A button on an issue request's screen. */
export type IssueRequestAction = 'edit' | 'delete' | 'submit' | 'approve' | 'reject' | 'cancel' | 'close' | 'issue';

/**
 * The actions a user may take on an issue request in a given status (ADR-026 §9).
 *
 * - DRAFT: edit, delete, submit, with `purchase_request.manage`.
 * - SUBMITTED: approve and reject with `purchase.approve`; cancel with `purchase.manage`.
 * - APPROVED: issue the stock with `stock.movement`; cancel and close with `purchase.manage`.
 * - REJECTED, CANCELLED, CLOSED: nothing.
 *
 * The approval rule for one's own document is not here; see approvalBlockedAsOwnDocument
 * in requestPayload.ts.
 */
export function issueRequestActions(
  status: IssueRequestStatus,
  can: (permission: Permission) => boolean,
): IssueRequestAction[] {
  switch (status) {
    case 'DRAFT':
      return can(PERMISSIONS.PURCHASE_REQUEST_MANAGE) ? ['edit', 'delete', 'submit'] : [];
    case 'SUBMITTED': {
      const actions: IssueRequestAction[] = [];
      if (can(PERMISSIONS.PURCHASE_APPROVE)) actions.push('approve', 'reject');
      if (can(PERMISSIONS.PURCHASE_MANAGE)) actions.push('cancel');
      return actions;
    }
    case 'APPROVED': {
      const actions: IssueRequestAction[] = [];
      if (can(PERMISSIONS.STOCK_MOVEMENT)) actions.push('issue');
      if (can(PERMISSIONS.PURCHASE_MANAGE)) actions.push('cancel', 'close');
      return actions;
    }
    default:
      return [];
  }
}
