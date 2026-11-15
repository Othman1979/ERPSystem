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
 * Lines as the server takes them. A line without an item or a quantity is not
 * sent. The server computes every total and tax from these inputs; no total is
 * sent from here.
 */
function orderLines(lines: readonly PurchaseOrderFormLine[]): PurchaseOrderLineDto[] {
  return lines.flatMap((l): PurchaseOrderLineDto[] => {
    const qty = text(l.qty);
    if (!l.itemId || !qty) return [];
    const line: PurchaseOrderLineDto = {
      itemId: l.itemId,
      qty,
      // The API requires a unit price; a blank one is sent as zero, as the purchase invoice does.
      unitPrice: text(l.unitPrice) ?? '0',
    };
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
  /** The order was created by the current member. */
  createdByMe: boolean;
}

/**
 * Whether the current member may approve this order, and why not. Amounts are
 * compared as decimals: an order exactly at the limit is within it.
 */
export function approvalHint(input: ApprovalHintInput): ApprovalHint {
  if (input.isOwner) return 'ok';
  if (!input.canApprove) return 'noApproval';
  if (input.createdByMe) return 'ownDocument';
  const limit = toDecimal(input.approvalLimit);
  if (limit !== null && dec(input.grandTotal).gt(limit)) return 'needsOwner';
  return 'ok';
}
