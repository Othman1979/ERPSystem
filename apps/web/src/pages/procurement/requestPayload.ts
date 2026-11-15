import type { CreatePurchaseRequestDto, PurchaseRequestLineDto, PurchaseRequestStatus } from '@erp/api-client';
import { PERMISSIONS, type Permission } from '../../auth/permissions';
import { toDecimal } from '../../format/number';

/** Header fields of a purchase request as the editor holds them. Dates are yyyy-mm-dd. */
export interface PurchaseRequestForm {
  requestDate: string;
  neededBy?: string | null;
  notes?: string | null;
}

/** A line as the grid holds it: ids and decimal strings, never JS numbers. */
export interface PurchaseRequestLineInput {
  itemId?: string | null;
  /** Absent means the item's base unit. */
  itemUnitId?: string | null;
  qty?: string | null;
  estimatedPrice?: string | null;
  note?: string | null;
}

/** Trimmed text, or undefined when blank (optional fields are omitted, not sent empty). */
function optionalText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * Body for POST/PUT of a purchase request (CreatePurchaseRequestDto).
 *
 * Lines without an item or with a quantity that is blank, zero or not a number
 * are left out: a request line needs both. Totals and prices are the server's
 * business, so nothing computed is sent. Every value is a string.
 */
export function purchaseRequestBody(
  form: PurchaseRequestForm,
  lines: readonly PurchaseRequestLineInput[],
): CreatePurchaseRequestDto {
  const body: CreatePurchaseRequestDto = {
    requestDate: form.requestDate,
    lines: lines.flatMap((line): PurchaseRequestLineDto[] => {
      const qty = toDecimal(line.qty);
      if (!line.itemId || !qty || !qty.gt(0)) return [];
      const out: PurchaseRequestLineDto = { itemId: line.itemId, qty: qty.toString() };
      if (line.itemUnitId) out.itemUnitId = line.itemUnitId;
      const estimatedPrice = optionalText(line.estimatedPrice);
      if (estimatedPrice) out.estimatedPrice = estimatedPrice;
      const note = optionalText(line.note);
      if (note) out.note = note;
      return [out];
    }),
  };
  const neededBy = optionalText(form.neededBy);
  if (neededBy) body.neededBy = neededBy;
  const notes = optionalText(form.notes);
  if (notes) body.notes = notes;
  return body;
}

/** A button on a purchase request's screen. */
export type RequestAction =
  | 'edit'
  | 'delete'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'cancel'
  | 'close'
  | 'orderFromRequest'
  | 'quoteFromRequest';

/**
 * The actions a user may take on a purchase request in a given status (ADR-025 §7, §13).
 *
 * - DRAFT: edit, delete, submit, with `purchase_request.manage`.
 * - SUBMITTED: approve and reject with `purchase.approve`; cancel with `purchase.manage`.
 * - APPROVED: cancel and close with `purchase.manage`; order or quote from the request.
 * - REJECTED, CANCELLED, CLOSED: nothing.
 *
 * The approval rule for one's own document (ADR-025 §2) is not here; see approvalBlockedAsOwnDocument.
 */
export function requestActions(
  status: PurchaseRequestStatus,
  can: (permission: Permission) => boolean,
): RequestAction[] {
  switch (status) {
    case 'DRAFT':
      return can(PERMISSIONS.PURCHASE_REQUEST_MANAGE) ? ['edit', 'delete', 'submit'] : [];
    case 'SUBMITTED': {
      const actions: RequestAction[] = [];
      if (can(PERMISSIONS.PURCHASE_APPROVE)) actions.push('approve', 'reject');
      if (can(PERMISSIONS.PURCHASE_MANAGE)) actions.push('cancel');
      return actions;
    }
    case 'APPROVED':
      return can(PERMISSIONS.PURCHASE_MANAGE)
        ? ['cancel', 'close', 'orderFromRequest', 'quoteFromRequest']
        : [];
    default:
      return [];
  }
}

/**
 * True when the user may not approve this request because they created it (ADR-025 §2):
 * only the company owner may approve a document they made.
 */
export function approvalBlockedAsOwnDocument({
  createdBy,
  userId,
  isOwner,
}: {
  createdBy: string | null | undefined;
  userId: string | null | undefined;
  isOwner: boolean;
}): boolean {
  return !isOwner && !!createdBy && createdBy === userId;
}
