import type { CreatePurchaseReturnDto, CreatePurchaseReturnDtoRefundType } from '@erp/api-client';
import Decimal from 'decimal.js';

/** What the return form knows about the original invoice. */
export interface ReturnedInvoice {
  id: string;
  warehouseId: string | null;
  lines: { id: string }[];
}

export interface PurchaseReturnForm {
  returnDate: string;
  refundType: CreatePurchaseReturnDtoRefundType;
  cashAccountId?: string;
  reason?: string;
  /** Quantity to return per original line id; empty or 0 lines are left out. */
  qtyByLine: Record<string, string | undefined>;
}

const positive = (q: string | undefined) => {
  try {
    return new Decimal(q || 0).gt(0);
  } catch {
    return false;
  }
};

/**
 * The body of POST /purchase-returns. The goods leave from the original
 * invoice's warehouse (owner, ADR-016 §5): the form has no picker and sends
 * the invoice's. An invoice with no warehouse (services only) sends none, and
 * the API answers with its own, translated, RETURN_WAREHOUSE_REQUIRED.
 */
export function purchaseReturnBody(invoice: ReturnedInvoice, form: PurchaseReturnForm): CreatePurchaseReturnDto {
  const body: CreatePurchaseReturnDto = {
    returnDate: form.returnDate,
    originalInvoiceId: invoice.id,
    warehouseId: invoice.warehouseId ?? undefined,
    refundType: form.refundType,
    cashAccountId: form.refundType === 'CASH' ? form.cashAccountId : undefined,
    reason: form.reason || undefined,
    lines: invoice.lines
      .filter((l) => positive(form.qtyByLine[l.id]))
      .map((l) => ({ originalLineId: l.id, qty: form.qtyByLine[l.id]! })),
  };
  return body;
}
