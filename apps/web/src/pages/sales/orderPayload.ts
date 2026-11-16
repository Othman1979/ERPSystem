import type { CreateInvoiceFromOrderDto, CreateSalesOrderDto } from '@erp/api-client';
import { salesLineBodies, type SalesFormLine } from './salesLines';

/** The sales order form's fields as the user left them. Dates are 'YYYY-MM-DD'. */
export interface SalesOrderForm {
  orderDate: string;
  expectedDate?: string;
  customerId: string;
  warehouseId: string;
  costCenterId?: string;
  /** Payment terms in days, copied to the invoices made from the order. */
  paymentTermsDays?: number;
  description?: string;
  lines: readonly SalesFormLine[];
}

/** Body of POST and PUT sales orders: the header and the lines; the server computes the totals. */
export function salesOrderBody(form: SalesOrderForm): CreateSalesOrderDto {
  const description = form.description?.trim();
  const expectedDate = form.expectedDate?.trim();
  return {
    orderDate: form.orderDate,
    customerId: form.customerId,
    warehouseId: form.warehouseId,
    ...(expectedDate ? { expectedDate } : {}),
    ...(form.costCenterId ? { costCenterId: form.costCenterId } : {}),
    ...(form.paymentTermsDays !== undefined ? { paymentTermsDays: form.paymentTermsDays } : {}),
    ...(description ? { description } : {}),
    lines: salesLineBodies(form.lines),
  };
}

/** The "create invoice" form on a confirmed order (ADR-027 §4). Dates are 'YYYY-MM-DD'. */
export interface OrderInvoiceForm {
  invoiceDate: string;
  dueDate?: string;
  paymentType: 'CASH' | 'CREDIT';
  cashAccountId?: string;
}

/** A cash invoice needs the cash or bank account it is paid into; a credit one does not. */
export function orderInvoiceGaps(form: OrderInvoiceForm): { cashAccount: boolean } {
  return { cashAccount: form.paymentType === 'CASH' && !form.cashAccountId };
}

/**
 * Body of POST /sales-orders/:id/invoice. Only what the user set is sent, and
 * the account only for a cash invoice. The server copies what is left of each
 * line, and the customer, warehouse and branch of the order.
 */
export function orderInvoiceBody(form: OrderInvoiceForm): CreateInvoiceFromOrderDto {
  const cashAccountId = form.paymentType === 'CASH' ? form.cashAccountId : undefined;
  return {
    invoiceDate: form.invoiceDate,
    paymentType: form.paymentType,
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    ...(cashAccountId ? { cashAccountId } : {}),
  };
}

/** What the approval controls show for an order waiting for approval (ADR-027 §6). */
export type SalesApprovalHint = 'ok' | 'noApproval' | 'ownDocument';

/**
 * Whether the member may approve a pending order: the owner always may; any
 * other member needs sales.approve and may not approve what they wrote. The
 * amount limit is the server's to enforce (APPROVAL_LIMIT_EXCEEDED).
 */
export function salesApprovalHint(input: {
  isOwner: boolean;
  canApprove: boolean;
  authoredByMe: boolean;
}): SalesApprovalHint {
  if (input.isOwner) return 'ok';
  if (!input.canApprove) return 'noApproval';
  if (input.authoredByMe) return 'ownDocument';
  return 'ok';
}
