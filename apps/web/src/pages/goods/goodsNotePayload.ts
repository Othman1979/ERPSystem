import type { CreateGoodsNoteDto, GoodsNoteLineDto } from '@erp/api-client';

/** One line of the goods note form; quantities and costs are decimal strings, never JS numbers. */
export interface GoodsNoteFormLine {
  itemId: string;
  qty: string;
  /** Receipt cost per base unit: sent on GRN lines only. */
  unitCost?: string | null;
  /** ADR-026 §5: the order line a GRN line receives (order-linked GRN). */
  poLineId?: string | null;
  /** ADR-026 §9: the request line a GIN line issues (request-linked GIN). */
  issueRequestLineId?: string | null;
}

export interface GoodsNoteFormValues {
  noteType: CreateGoodsNoteDto['noteType'];
  noteDate: string;
  warehouseId: string;
  description?: string;
  /** GIN only: the expense account that replaces INVENTORY_ADJUSTMENT (ADR-026 §8). Null or undefined: none. */
  expenseAccountId?: string | null;
  /** GIN only: the department cost centre (ADR-026 §8). Null or undefined: none. */
  costCenterId?: string | null;
  lines: GoodsNoteFormLine[];
}

/** The links of a saved note; they are set at creation and never change (ADR-026 §5, §9). */
export interface GoodsNoteLinks {
  purchaseOrderId?: string | null;
  issueRequestId?: string | null;
}

/**
 * The request body of a goods note create or update. The server re-computes
 * costs and validates links, so this only shapes what the form knows:
 * - a GRN never sends an expense account, a cost centre or a request;
 * - a GRN against an order sends the order id and each line's order line, and no
 *   unit cost (the server takes the order's net price);
 * - a GIN against a request sends the request id and each line's request line;
 * - unit cost goes on GRN lines only; temporary receipts are always zero cost;
 * - a GIN's expense account and cost centre are omitted when none is chosen on create,
 *   and sent as null on update, because an update replaces the note and null clears them.
 * Lines without an item or a quantity are left out, as the create screen always did.
 */
export function goodsNoteBody(
  form: GoodsNoteFormValues,
  existing?: GoodsNoteLinks | null,
  forUpdate = false,
): CreateGoodsNoteDto {
  const isGrn = form.noteType === 'GRN';
  const isGin = form.noteType === 'GIN';
  const orderLinked = !!existing?.purchaseOrderId;
  const requestLinked = !!existing?.issueRequestId;

  const body: CreateGoodsNoteDto = {
    noteDate: form.noteDate,
    warehouseId: form.warehouseId,
    noteType: form.noteType,
    description: form.description || undefined,
    lines: form.lines
      .filter((l) => !!l.itemId && !!l.qty)
      .map((l): GoodsNoteLineDto => {
        const line: GoodsNoteLineDto = { itemId: l.itemId, qty: l.qty };
        if (orderLinked) {
          if (l.poLineId) line.poLineId = l.poLineId;
        } else if (requestLinked) {
          if (l.issueRequestLineId) line.issueRequestLineId = l.issueRequestLineId;
        } else if (isGrn && l.unitCost != null) {
          line.unitCost = l.unitCost;
        }
        return line;
      }),
  };

  if (existing?.purchaseOrderId) body.purchaseOrderId = existing.purchaseOrderId;
  if (existing?.issueRequestId) body.issueRequestId = existing.issueRequestId;
  if (isGin) {
    if (form.expenseAccountId) body.expenseAccountId = form.expenseAccountId;
    else if (forUpdate) body.expenseAccountId = null;
    if (form.costCenterId) body.costCenterId = form.costCenterId;
    else if (forUpdate) body.costCenterId = null;
  }
  return body;
}
