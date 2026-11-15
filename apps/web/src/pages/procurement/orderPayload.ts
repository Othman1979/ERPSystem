import type {
  CreatePurchaseOrderDto,
  PurchaseOrderLineDto,
  UpdatePurchaseOrderDto,
} from '@erp/api-client';
import { dec, toDecimal } from '../../format/number';

/** An editable line of the purchase order form; numeric fields are decimal strings. */
export interface PurchaseOrderFormLine {
  itemId?: string;
  itemUnitId?: string;
  qty?: string | null;
  unitPrice?: string | null;
  discountPct?: string | null;
  /** Set on lines prefilled from an approved request; kept on save. */
  requestLineId?: string;
}

/** What the purchase order form holds when the user saves. Dates are 'YYYY-MM-DD'. */
export interface PurchaseOrderForm {
  orderDate: string;
  expectedDate?: string;
  supplierId: string;
  warehouseId: string;
  /** Optional header cost centre (ADR-025 §12); left out of the body when empty. */
  costCenterId?: string;
  /** The approved request the order is raised from; sent on create only. */
  requestId?: string;
  notes?: string;
}

/** Trimmed text, or undefined when blank. */
function text(v: string | null | undefined): string | undefined {
  const s = v?.trim();
  return s ? s : undefined;
}

/**
 * Indexes of the lines that have an item but no unit price. Every line with an
 * item needs a price: a blank one is never sent as zero. A price of '0' is a price.
 */
export function missingPriceLines(lines: readonly PurchaseOrderFormLine[]): number[] {
  return lines.flatMap((l, index) => (l.itemId && !text(l.unitPrice) ? [index] : []));
}

/**
 * Lines as the server takes them. A line without an item or a quantity is not
 * sent. The server computes every total and tax from these inputs; no total is
 * sent from here. The page blocks a save while `missingPriceLines` is not empty,
 * so a line that reaches here with a quantity and no price is a caller error.
 */
function orderLines(lines: readonly PurchaseOrderFormLine[]): PurchaseOrderLineDto[] {
  return lines.flatMap((l): PurchaseOrderLineDto[] => {
    const qty = text(l.qty);
    if (!l.itemId || !qty) return [];
    const unitPrice = text(l.unitPrice);
    if (!unitPrice) throw new Error('a unit price is required on every line with an item');
    const line: PurchaseOrderLineDto = { itemId: l.itemId, qty, unitPrice };
    const itemUnitId = text(l.itemUnitId);
    const discountPct = text(l.discountPct);
    const requestLineId = text(l.requestLineId);
    if (itemUnitId) line.itemUnitId = itemUnitId;
    if (discountPct) line.discountPct = discountPct;
    if (requestLineId) line.requestLineId = requestLineId;
    return [line];
  });
}

/** Header and lines shared by create and update (the API takes no request id on update). */
function orderFields(form: PurchaseOrderForm, lines: readonly PurchaseOrderFormLine[]): UpdatePurchaseOrderDto {
  const body: UpdatePurchaseOrderDto = {
    orderDate: form.orderDate,
    supplierId: form.supplierId,
    warehouseId: form.warehouseId,
    lines: orderLines(lines),
  };
  const expectedDate = text(form.expectedDate);
  const costCenterId = text(form.costCenterId);
  const notes = text(form.notes);
  if (expectedDate) body.expectedDate = expectedDate;
  if (costCenterId) body.costCenterId = costCenterId;
  if (notes) body.notes = notes;
  return body;
}

/** Body of POST /purchase-orders: the header, the lines, and the request id when the order comes from one. */
export function purchaseOrderBody(
  form: PurchaseOrderForm,
  lines: readonly PurchaseOrderFormLine[],
): CreatePurchaseOrderDto {
  const body: CreatePurchaseOrderDto = orderFields(form, lines);
  const requestId = text(form.requestId);
  if (requestId) body.requestId = requestId;
  return body;
}

/** Body of PUT /purchase-orders/:id: as create, without the request id (it is set at creation only). */
export function purchaseOrderUpdateBody(
  form: PurchaseOrderForm,
  lines: readonly PurchaseOrderFormLine[],
): UpdatePurchaseOrderDto {
  return orderFields(form, lines);
}

/** What the approval controls show for a submitted order (ADR-024 §3, ADR-025 §2). */
export type ApprovalHint = 'ok' | 'needsOwner' | 'ownDocument' | 'noApproval';

export interface ApprovalHintInput {
  /** The owner approves every order: the role holds every purchase permission. */
  isOwner: boolean;
  /** The member holds purchase.approve. */
  canApprove: boolean;
  /** The member's approval limit as a decimal string; null or undefined means no limit. */
  approvalLimit: string | null | undefined;
  /** The order's grand total as the server computed it. */
  grandTotal: string;
  /** The current member created, last edited or submitted the order (see isAuthoredBy). */
  authoredByMe: boolean;
}

/** The document fields that name the member who wrote it (ADR-024 §3). */
export interface AuthorFields {
  createdBy?: string | null;
  updatedBy?: string | null;
  submittedBy?: string | null;
}

/**
 * Whether the member wrote the document: created it, last edited it or
 * submitted it. Such a member cannot approve it (APPROVAL_SELF_NOT_ALLOWED).
 */
export function isAuthoredBy(doc: AuthorFields, userId: string | undefined): boolean {
  if (!userId) return false;
  return [doc.createdBy, doc.updatedBy, doc.submittedBy].includes(userId);
}

/**
 * Whether the current member may approve this order, and why not. Amounts are
 * compared as decimals: an order exactly at the limit is within it.
 */
export function approvalHint(input: ApprovalHintInput): ApprovalHint {
  if (input.isOwner) return 'ok';
  if (!input.canApprove) return 'noApproval';
  if (input.authoredByMe) return 'ownDocument';
  const limit = toDecimal(input.approvalLimit);
  if (limit !== null && dec(input.grandTotal).gt(limit)) return 'needsOwner';
  return 'ok';
}
